import { OperationalError } from "../cli/errors.ts";
import { emitServiceEvent, type ServiceEventSink } from "../services/events.ts";
import type { RepositorySource, WorkspaceConfig } from "../types.ts";
import { presentPipelines } from "../ui/grid-consumer.ts";
import { runCommand } from "../utils/exec.ts";
import type { CreateInput, ResolvedSource } from "../workspace/create.ts";
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
  type StreamCommand,
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

export type CreateCloudOptions = Readonly<{
  interactive: boolean;
  onEvent?: ServiceEventSink;
  config: WorkspaceConfig;
}>;

/**
 * Provision a cloud workspace: a single persistent Vercel Sandbox with every
 * source repo cloned onto a new branch and dependencies installed — the remote
 * counterpart of {@link create}. Near-instant spin-up comes from forking a
 * per-template base snapshot; the per-repo pipeline then fetches, branches, and
 * pulls env on top, rendered through the same grid the local path uses.
 */
export async function createCloud(
  input: CreateInput,
  options: CreateCloudOptions,
): Promise<void> {
  const credentials = await resolveCloudCredentials(options.config);
  try {
    await provisionCloud(input, options, credentials);
  } catch (error) {
    throw describeCloudError(error, credentials);
  }
}

async function provisionCloud(
  input: CreateInput,
  options: CreateCloudOptions,
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
    const vercelTeam = resolveVercelTeam(repo.remote, options.config);
    pipelines.set(
      repo.name,
      cloudRepoPipeline({
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

  // `presentPipelines` returns only the repos whose pipeline completed, so any
  // repo absent from this map failed its git/install setup.
  const completed = await presentPipelines({
    pipelines,
    repoNames: repos.map((repo) => repo.name),
    interactive: options.interactive,
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });

  await finalizeCloudProvisioning({
    sandbox,
    changeName: input.changeName,
    ports,
    repoNames: repos.map((repo) => repo.name),
    completed,
    onEvent: options.onEvent,
  });
}

type FinalizeCloudParams = Readonly<{
  sandbox: CloudSandbox;
  changeName: string;
  ports: readonly number[];
  repoNames: readonly string[];
  completed: ReadonlyMap<string, { hasLockfile: boolean }>;
  onEvent: ServiceEventSink | undefined;
}>;

/**
 * Decide a cloud run's outcome from the repos that actually completed, so a run
 * is never reported as ready when it produced nothing usable.
 *
 * A persistent sandbox is billed for as long as it exists, so a run where
 * *every* repo failed must not print "ready" over an orphaned box: tear it down
 * (best-effort) and throw so the CLI exits non-zero. A partial failure still
 * leaves a usable sandbox — report it ready, but call out which repos need
 * attention rather than implying a clean run.
 */
export async function finalizeCloudProvisioning(
  params: FinalizeCloudParams,
): Promise<void> {
  const { sandbox, changeName, ports, repoNames, completed, onEvent } = params;
  const failedRepos = repoNames.filter((name) => !completed.has(name));

  if (completed.size === 0) {
    await teardownSandbox(sandbox, onEvent);
    const noun = repoNames.length === 1 ? "repository" : "repositories";
    throw new OperationalError(
      `Cloud provisioning failed: all ${repoNames.length} ${noun} failed to set up in ${cloudSandboxName(changeName)}.`,
    );
  }

  reportReady(sandbox, changeName, ports, onEvent);

  if (failedRepos.length > 0) {
    const failed = failedRepos.join(", ");
    const message = `Some repositories failed to set up: ${failed}. The workspace is usable for the repositories that succeeded.`;
    emitServiceEvent(onEvent, {
      type: "message",
      level: "warning",
      message,
    });
  }
}

/**
 * Best-effort teardown of a sandbox whose provisioning wholly failed. A teardown
 * error must not mask the original failure, so it is surfaced as a warning
 * rather than thrown.
 */
async function teardownSandbox(
  sandbox: CloudSandbox,
  onEvent: ServiceEventSink | undefined,
): Promise<void> {
  try {
    await sandbox.delete();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    emitServiceEvent(onEvent, {
      type: "message",
      level: "warning",
      message: `Failed to tear down cloud sandbox after provisioning failure: ${reason}`,
    });
  }
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
  repo: RepositorySource;
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
export async function* cloudRepoPipeline(
  params: CloudRepoPipelineParams,
): AsyncGenerator<RepoPipelineState> {
  const { sandbox, repo, branchName, mode } = params;
  const repoDir = `${SANDBOX_WORKDIR}/${repo.name}`;
  const cloneUrl = httpsCloneUrl(repo.remote);

  try {
    // The configured default branch is only a guess (e.g. "main" for an
    // org/repo slug); the remote's real default may differ. Detect it once from
    // the remote HEAD — quietly, so the pane shows only the visible git steps —
    // and branch from that. The local path self-corrects the same way via
    // `detectDefaultBranch`.
    const defaultBranch = await detectRemoteDefaultBranch(
      sandbox,
      cloneUrl,
      "main",
    );

    // Git phase: get the repo onto a fresh branch at latest default-branch HEAD.
    const gitCommands: { cmd: string; args: string[]; cwd: string }[] =
      mode === "cold"
        ? [
            {
              cmd: "git",
              args: ["clone", "--branch", defaultBranch, cloneUrl, repo.name],
              cwd: SANDBOX_WORKDIR,
            },
            { cmd: "git", args: ["checkout", "-B", branchName], cwd: repoDir },
          ]
        : [
            {
              cmd: "git",
              args: ["fetch", "origin", defaultBranch],
              cwd: repoDir,
            },
            {
              cmd: "git",
              args: ["checkout", "-B", branchName, `origin/${defaultBranch}`],
              cwd: repoDir,
            },
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

/** `ref: refs/heads/<name>\tHEAD` — the symref line `ls-remote --symref` prints. */
const SYMREF_HEAD = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m;

/**
 * Detect a repo's real default branch by reading the remote HEAD symref, without
 * needing a clone: `git ls-remote --symref <url> HEAD` prints a line like
 * `ref: refs/heads/<name>\tHEAD`. The sandbox already has brokered network to
 * origin, so this runs there.
 *
 * Detection is advisory, never fatal: a failed command, missing symref, or
 * unparseable output all fall back to the configured branch so a flaky probe
 * can't block provisioning.
 */
async function detectRemoteDefaultBranch(
  sandbox: CloudSandbox,
  cloneUrl: string,
  fallback: string,
): Promise<string> {
  try {
    const { exitCode, output } = await captureCommand(sandbox, {
      cmd: "git",
      args: ["ls-remote", "--symref", cloneUrl, "HEAD"],
      cwd: SANDBOX_WORKDIR,
    });
    if (exitCode !== 0) return fallback;
    return SYMREF_HEAD.exec(output)?.[1] ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Run a sandbox command to completion, collecting its streamed output. Unlike
 * {@link runToCompletion} (which discards output), this is used for quiet probes
 * like `ls-remote` whose stdout must be parsed.
 */
async function captureCommand(
  sandbox: CloudSandbox,
  command: StreamCommand,
): Promise<{ exitCode: number; output: string }> {
  const stream = streamCommand(sandbox, command);
  let output = "";
  let next = await stream.next();
  while (!next.done) {
    output += next.value;
    next = await stream.next();
  }
  return { exitCode: next.value, output };
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

function reportReady(
  sandbox: CloudSandbox,
  changeName: string,
  ports: readonly number[],
  onEvent: ServiceEventSink | undefined,
): void {
  // Route every line through the one event sink so it reaches the console once
  // (via the human sink) and structured consumers still see the success event.
  emitServiceEvent(onEvent, {
    type: "message",
    level: "success",
    message: `Cloud workspace ready: ${cloudSandboxName(changeName)}`,
  });
  for (const port of ports) {
    try {
      emitServiceEvent(onEvent, {
        type: "message",
        level: "info",
        message: `  ${port} → ${sandbox.domain(port)}`,
      });
    } catch {
      // Port has no route (not requested at create); skip it.
    }
  }
  emitServiceEvent(onEvent, {
    type: "message",
    level: "info",
    message: `  Attach: wf cloud attach ${changeName}`,
  });
}

/** Repos for a resolved start source, in a single uniform list. */
function reposOf(source: ResolvedSource): readonly RepositorySource[] {
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
