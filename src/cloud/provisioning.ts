import { log } from "../logger.ts";
import { emitServiceEvent, type ServiceEventSink } from "../services/events.ts";
import type { RepoConfig, WorkspaceConfig } from "../types.ts";
import { renderPipelinesGrid, shouldUseGrid } from "../ui/grid-consumer.ts";
import { runCommand } from "../utils/exec.ts";
import type {
  CreateChangeInput,
  ResolvedStartSource,
} from "../workspace/create-change.ts";
import type { RepoPipelineState } from "../workspace/pipeline.ts";
import {
  type CloudCredentials,
  describeCloudError,
  resolveCloudCredentials,
} from "./credentials.ts";
import {
  baseSnapshotGroup,
  type CloudRepo,
  DEFAULT_SNAPSHOT_TTL_MS,
  ensureBaseSnapshot,
  SANDBOX_WORKDIR,
} from "./snapshot.ts";
import { buildWorkspaceTags, cloudSandboxName } from "./tags.ts";
import {
  buildNetworkPolicy,
  type CloudSandbox,
  type CredentialBrokering,
  createWorkspaceSandbox,
  forkWorkspaceSandbox,
  streamCommand,
} from "./vercel-sandbox.ts";
import { httpsCloneUrl, resolveVercelTeam } from "./vercel-team.ts";

const DEFAULT_PORTS: readonly number[] = [3000];

/**
 * Default sandbox runtime timeout. The SDK's own default is only a few minutes,
 * which stops the box almost immediately after provisioning; 45 minutes gives a
 * usable working/attach window. Override with `cloud.timeoutMs`. (Extending a
 * long-running box past this — the "keep it alive while away" story — is a later
 * phase; see the plan's deferred work.)
 */
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;

export type CreateCloudChangeOptions = Readonly<{
  interactive: boolean;
  onEvent?: ServiceEventSink;
  config: WorkspaceConfig;
}>;

/**
 * Provision a cloud workspace: a single persistent Vercel Sandbox with every
 * source repo cloned onto a new branch and dependencies installed — the remote
 * counterpart of {@link createChange}. Near-instant spin-up comes from forking a
 * per-template base snapshot; the per-repo pipeline then fetches, branches, and
 * pulls env on top, rendered through the same grid the local path uses.
 */
export async function createCloudChange(
  input: CreateChangeInput,
  options: CreateCloudChangeOptions,
): Promise<void> {
  const credentials = await resolveCloudCredentials(options.config);
  try {
    await provisionCloudChange(input, options, credentials);
  } catch (error) {
    throw describeCloudError(error, credentials);
  }
}

async function provisionCloudChange(
  input: CreateChangeInput,
  options: CreateCloudChangeOptions,
  credentials: CloudCredentials,
): Promise<void> {
  const repos = reposOf(input.source);
  const cloudRepos: CloudRepo[] = repos.map((repo) => ({
    name: repo.name,
    remote: repo.remote,
  }));
  const brokering = await resolveBrokering();
  const networkPolicy = buildNetworkPolicy(brokering);
  const cloud = options.config.cloud?.vercel ?? {};
  const ports = cloud.ports ?? [...DEFAULT_PORTS];
  const timeoutMs = cloud.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const vercelTeam = resolveVercelTeam(repos[0]?.remote ?? "", options.config);

  const group = baseSnapshotGroup(input.source);
  const baseName = await ensureBaseSnapshot({
    group,
    repos: cloudRepos,
    ttlMs: cloud.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS,
    nowMs: Date.now(),
    networkPolicy,
    credentials,
    timeoutMs,
    ...(cloud.vcpus !== undefined ? { vcpus: cloud.vcpus } : {}),
    ...(cloud.runtime !== undefined ? { runtime: cloud.runtime } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });

  const sandboxName = cloudSandboxName(input.changeName);
  const tags = buildWorkspaceTags({
    changeName: input.changeName,
    branchName: input.branchName,
    repos: repos.map((repo) => repo.name),
    ...(input.source.kind === "template"
      ? { templateId: input.source.templateId }
      : {}),
  });

  const sandbox = await acquireWorkspaceSandbox({
    baseName,
    name: sandboxName,
    tags,
    ports,
    networkPolicy,
    credentials,
    timeoutMs,
    ...(cloud.vcpus !== undefined ? { vcpus: cloud.vcpus } : {}),
    ...(cloud.runtime !== undefined ? { runtime: cloud.runtime } : {}),
  });
  const mode: RepoSetupMode = baseName ? "forked" : "cold";

  const pipelines = new Map<string, AsyncGenerator<RepoPipelineState>>();
  for (const repo of repos) {
    pipelines.set(
      repo.name,
      cloudRepoPipelineGenerator({
        sandbox,
        repo,
        branchName: input.branchName,
        mode,
        vercelEnvEnabled:
          Boolean(brokering.vercelToken) && vercelTeam !== undefined,
        ...(vercelTeam !== undefined ? { vercelTeam } : {}),
      }),
    );
  }

  const repoNames = repos.map((repo) => repo.name);
  const useGrid = options.interactive && shouldUseGrid(repoNames.length);
  if (useGrid) {
    await renderPipelinesGrid({ pipelines, repoNames });
  } else {
    await drainPipelinesToConsole(pipelines, options.onEvent);
  }

  reportReady(sandbox, input.changeName, ports, options.onEvent);
}

type AcquireParams = Readonly<{
  baseName: string | null;
  name: string;
  tags: Record<string, string>;
  ports: number[];
  networkPolicy: ReturnType<typeof buildNetworkPolicy>;
  credentials: CloudCredentials;
  vcpus?: number;
  timeoutMs?: number;
  runtime?: string;
}>;

async function acquireWorkspaceSandbox(
  params: AcquireParams,
): Promise<CloudSandbox> {
  if (params.baseName) {
    return forkWorkspaceSandbox({
      sourceSandbox: params.baseName,
      name: params.name,
      tags: params.tags,
      ports: params.ports,
      networkPolicy: params.networkPolicy,
      credentials: params.credentials,
      ...(params.vcpus !== undefined ? { vcpus: params.vcpus } : {}),
      ...(params.timeoutMs !== undefined
        ? { timeoutMs: params.timeoutMs }
        : {}),
    });
  }
  return createWorkspaceSandbox({
    name: params.name,
    tags: params.tags,
    ports: params.ports,
    networkPolicy: params.networkPolicy,
    credentials: params.credentials,
    ...(params.vcpus !== undefined ? { vcpus: params.vcpus } : {}),
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.runtime !== undefined ? { runtime: params.runtime } : {}),
  });
}

type RepoSetupMode = "forked" | "cold";

type CloudRepoPipelineParams = Readonly<{
  sandbox: CloudSandbox;
  repo: RepoConfig;
  branchName: string;
  mode: RepoSetupMode;
  vercelEnvEnabled: boolean;
  vercelTeam?: string;
}>;

/**
 * Per-repo remote setup, yielding the same {@link RepoPipelineState} the local
 * pipeline emits so the grid renders cloud progress unchanged. A forked repo
 * already exists in the sandbox (fetch + branch); a cold repo is cloned first.
 * Dependency install and `vercel env pull` map onto the initializer phase.
 */
export async function* cloudRepoPipelineGenerator(
  params: CloudRepoPipelineParams,
): AsyncGenerator<RepoPipelineState> {
  const { sandbox, repo, branchName, mode } = params;
  const repoDir = `${SANDBOX_WORKDIR}/${repo.name}`;

  try {
    // Git phase: get the repo onto a fresh branch at latest default-branch HEAD.
    const gitCommands: { cmd: string; args: string[]; cwd: string }[] =
      mode === "cold"
        ? [
            {
              cmd: "git",
              args: ["clone", httpsCloneUrl(repo.remote), repo.name],
              cwd: SANDBOX_WORKDIR,
            },
            { cmd: "git", args: ["checkout", "-B", branchName], cwd: repoDir },
          ]
        : [
            { cmd: "git", args: ["fetch", "origin"], cwd: repoDir },
            { cmd: "git", args: ["checkout", "-B", branchName], cwd: repoDir },
          ];

    for (const command of gitCommands) {
      const failure = yield* runStep(sandbox, command, "git", "worktree");
      if (failure) {
        yield failure;
        return;
      }
    }

    // Initializer phase: install dependencies, then pull Vercel env.
    const hasLockfile = await repoHasLockfile(sandbox, repoDir);
    if (hasLockfile) {
      const failure = yield* runStep(
        sandbox,
        {
          cmd: "corepack",
          args: ["pnpm", "install"],
          cwd: repoDir,
        },
        "initializer",
        "install",
      );
      if (failure) {
        yield failure;
        return;
      }
    }

    if (params.vercelEnvEnabled && params.vercelTeam) {
      const link = yield* runStep(
        sandbox,
        {
          cmd: "vercel",
          args: ["link", "--yes", "--repo", "--scope", params.vercelTeam],
          cwd: repoDir,
        },
        "initializer",
        "vercel-env",
      );
      if (link) {
        // Linking is best-effort; surface a note but don't fail the repo.
        yield {
          phase: "initializer",
          name: "vercel-env",
          status: "skipped",
          message: "vercel link failed; skipped env pull",
        };
      } else {
        yield* runStep(
          sandbox,
          {
            cmd: "vercel",
            args: ["env", "pull", "--environment", "development", "--yes"],
            cwd: repoDir,
          },
          "initializer",
          "vercel-env",
        );
      }
    }

    yield { phase: "worktree-ready", hasLockfile };
    yield { phase: "complete", hasLockfile };
  } catch (error) {
    yield {
      phase: "failed",
      error: error instanceof Error ? error : new Error(String(error)),
      step: `${mode}:${repo.name}`,
    };
  }
}

/**
 * Run one sandbox command, mapping its streamed output onto the grid vocabulary.
 * Returns a `failed` state when the command exits non-zero (so the caller can
 * stop the repo), or null on success.
 */
async function* runStep(
  sandbox: CloudSandbox,
  command: { cmd: string; args: string[]; cwd: string },
  phase: "git" | "initializer",
  label: "worktree" | "install" | "vercel-env",
): AsyncGenerator<
  RepoPipelineState,
  Extract<RepoPipelineState, { phase: "failed" }> | null
> {
  if (phase === "git") {
    yield { phase: "git", step: "worktree", status: "running" };
  } else {
    yield { phase: "initializer", name: label, status: "running" };
  }

  const stream = streamCommand(sandbox, command);
  let next = await stream.next();
  while (!next.done) {
    if (phase === "git") {
      yield {
        phase: "git",
        step: "worktree",
        status: "output",
        output: next.value,
      };
    } else {
      yield {
        phase: "initializer",
        name: label,
        status: "output",
        output: next.value,
      };
    }
    next = await stream.next();
  }

  const exitCode = next.value;
  if (exitCode !== 0) {
    return {
      phase: "failed",
      error: new Error(
        `${command.cmd} ${command.args.join(" ")} (exit ${exitCode})`,
      ),
      step: label,
    };
  }
  if (phase === "git") {
    yield { phase: "git", step: "worktree", status: "completed" };
  } else {
    yield { phase: "initializer", name: label, status: "completed" };
  }
  return null;
}

async function repoHasLockfile(
  sandbox: CloudSandbox,
  repoDir: string,
): Promise<boolean> {
  const stream = streamCommand(sandbox, {
    cmd: "sh",
    args: ["-c", "[ -f pnpm-lock.yaml ] || [ -f pnpm-lock.yml ]"],
    cwd: repoDir,
  });
  let next = await stream.next();
  while (!next.done) {
    next = await stream.next();
  }
  return next.value === 0;
}

async function drainPipelinesToConsole(
  pipelines: Map<string, AsyncGenerator<RepoPipelineState>>,
  onEvent: ServiceEventSink | undefined,
): Promise<void> {
  await Promise.all(
    [...pipelines].map(async ([name, generator]) => {
      for await (const state of generator) {
        if (state.phase === "failed") {
          emitServiceEvent(onEvent, {
            type: "message",
            level: "error",
            message: `${name}: ${state.error.message}`,
          });
        } else if (state.phase === "complete") {
          emitServiceEvent(onEvent, {
            type: "message",
            level: "success",
            message: `${name}: ready`,
          });
        }
      }
    }),
  );
}

function reportReady(
  sandbox: CloudSandbox,
  changeName: string,
  ports: readonly number[],
  onEvent: ServiceEventSink | undefined,
): void {
  log.success(`Cloud workspace ready: ${cloudSandboxName(changeName)}`);
  for (const port of ports) {
    try {
      log.info(`  ${port} → ${sandbox.domain(port)}`);
    } catch {
      // Port has no route (not requested at create); skip it.
    }
  }
  log.info(`  Attach: wf cloud attach ${changeName}`);
  emitServiceEvent(onEvent, {
    type: "message",
    level: "success",
    message: `Cloud workspace ${cloudSandboxName(changeName)} provisioned.`,
  });
}

/** Repos for a resolved start source, in a single uniform list. */
function reposOf(source: ResolvedStartSource): readonly RepoConfig[] {
  if (source.kind === "repository") return [source.repo];
  return source.repos;
}

/**
 * Resolve the credentials the firewall will broker: a GitHub token from the
 * local `gh` CLI and a Vercel token from the environment. Both are best-effort —
 * a missing token simply means that domain is not brokered (public clones still
 * work; env pull is skipped without a Vercel token).
 */
async function resolveBrokering(): Promise<CredentialBrokering> {
  const result: { githubToken?: string; vercelToken?: string } = {};
  try {
    const { stdout } = await runCommand("gh", ["auth", "token"], {
      timeout: 10_000,
    });
    const token = stdout.trim();
    if (token) result.githubToken = token;
  } catch {
    // gh not installed or not authenticated; clone public repos only.
  }
  const vercelToken = process.env["VERCEL_TOKEN"]?.trim();
  if (vercelToken) result.vercelToken = vercelToken;
  return result;
}
