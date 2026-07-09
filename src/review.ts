import { promises as fs } from "node:fs";
import path from "node:path";
import { hasAny, pathExists } from "@wf-plugin/core";
import { getCacheDir } from "./config.ts";
import { resolveMirrorDir } from "./repositories.ts";
import { validateRepositoryComponent } from "./repository-components.ts";
import type { ServiceEventSink } from "./services/events.ts";
import {
  addWorktree,
  deleteBranchIfPossible,
  getCurrentBranch,
  isGitDirty,
  removeWorktree,
} from "./services/worktree.ts";
import { isShellAutoCdEnabled } from "./shell.ts";
import type { RepositorySource } from "./types.ts";
import { type PresentRunOutcome, presentRun } from "./ui/setup-view/present.ts";
import { compactHome } from "./utils/display-path.ts";
import { runCommand } from "./utils/exec.ts";
import { ensureDir } from "./utils/fs.ts";
import { resolveContainedPath } from "./utils/path-safety.ts";
import { runScopedRepoSetupPipeline } from "./workspace/index.ts";
import {
  initializeWorktreeSetup,
  workspaceInitializationScope,
  worktreeInitializationScope,
} from "./workspace/initialization.ts";
import {
  readWorkspaceMetadata,
  removeReviewWorktreeMetadata,
  saveWorkspaceMetadata,
  upsertReviewWorktree,
  writeWorkspaceMetadata,
  writeWorktreeMetadata,
} from "./workspace/metadata.ts";
import {
  mapTaskStateToPipelineState,
  type RepoPipelineState,
} from "./workspace/pipeline.ts";
import { ensureMirrorRepo } from "./workspace/repository.ts";
import type { RunEventBody } from "./workspace/run-log/events.ts";
import {
  createPipelineEventBridge,
  createPipelineStateConverter,
} from "./workspace/run-log/instrument.ts";
import {
  createRunSession,
  type RunSession,
} from "./workspace/run-log/session.ts";

export type ReviewTarget = {
  owner: string;
  repo: string;
  prNumber: number;
};

export type ReviewRepoTarget = Pick<ReviewTarget, "owner" | "repo">;

export type ReviewMetadata = ReviewTarget & {
  path: string;
  branch?: string;
  created_at: string;
};

export type CreateReviewWorktreeResult = {
  metadata: ReviewMetadata;
  reused: boolean;
  outcome: Exclude<PresentRunOutcome, "cancelled" | "failed">;
};

export type CancelledReviewWorktreeResult = {
  path: string;
  reused: false;
  outcome: "cancelled";
};

export type ReviewListEntry = ReviewMetadata & {
  state: "ready" | "stale";
};

export type CreateReviewWorktreeOptions = {
  target: ReviewTarget;
  reviewsRoot: string;
  /** Render the setup grid when the terminal supports it (default false). */
  interactive?: boolean;
  onEvent?: ServiceEventSink;
};

export type EnsureReviewWorkspaceOptions = {
  target: ReviewRepoTarget;
  reviewsRoot: string;
  /** Render the setup grid when the terminal supports it (default false). */
  interactive?: boolean;
  onEvent?: ServiceEventSink;
};

export type ReviewWorkspace = ReviewRepoTarget & {
  path: string;
  outcome: Exclude<PresentRunOutcome, "failed">;
};

export type ReviewTargetContext = {
  owner: string;
  repo: string;
};

export type RemoveReviewWorktreeOptions = {
  target: ReviewTarget;
  reviewsRoot: string;
  dryRun?: boolean;
  force?: boolean;
};

export type RemoveReviewWorktreeResult = {
  path: string;
  branch?: string;
  dryRun: boolean;
};

export function parseReviewTarget(args: readonly string[]): ReviewTarget {
  if (args.length === 1) {
    return parseSingleTarget(args[0] ?? "");
  }

  if (args.length === 2) {
    const repo = parseRepoTarget(args[0] ?? "");
    const prNumber = parsePrNumber(args[1] ?? "");
    return { ...repo, prNumber };
  }

  throw new Error("Expected a GitHub PR URL or <owner>/<repo> <pr-number>.");
}

export function resolveReviewTarget(
  args: readonly string[],
  context?: ReviewTargetContext,
): ReviewTarget {
  try {
    return parseReviewTarget(args);
  } catch (error) {
    if (args.length === 1 && context) {
      return {
        ...context,
        prNumber: parsePrNumber(args[0] ?? ""),
      };
    }

    throw error;
  }
}

export function parseReviewRepoTarget(
  args: readonly string[],
): ReviewRepoTarget {
  if (args.length !== 1) {
    throw new Error("Expected <owner>/<repo> or a GitHub git URL.");
  }

  return parseRepoTarget(args[0] ?? "");
}

export async function createReviewWorktree({
  target,
  reviewsRoot,
  interactive = false,
  onEvent,
}: CreateReviewWorktreeOptions): Promise<
  CreateReviewWorktreeResult | CancelledReviewWorktreeResult
> {
  validateReviewTarget(target);
  const repo = targetToRepoConfig(target);
  const workspaceDir = getRepoReviewsDir(reviewsRoot, target.repo);
  const baseRepoDir = resolveContainedPath(workspaceDir, target.repo);
  const targetDir = getReviewWorktreePath(reviewsRoot, target);

  await ensureDir(workspaceDir);
  if (await pathExists(targetDir)) {
    const recordedMetadata = await readReviewWorktreeMetadata(
      workspaceDir,
      target,
    );
    const branch = recordedMetadata
      ? undefined
      : await getCurrentBranchIfExists(targetDir);
    const metadata = recordedMetadata ?? {
      ...target,
      path: targetDir,
      ...(branch ? { branch } : {}),
      created_at: new Date().toISOString(),
    };

    await reconcileReviewWorkspaceMetadata(
      workspaceDir,
      { owner: target.owner, repo: target.repo },
      repo,
    );
    await upsertReviewWorktree(workspaceDir, {
      pr_number: target.prNumber,
      path: path.relative(workspaceDir, targetDir),
      ...(metadata.branch ? { branch: metadata.branch } : {}),
      created_at: metadata.created_at,
    });

    return { metadata, reused: true, outcome: "ready" };
  }

  const mirrorDir = await resolveMirrorDir(repo, getCacheDir());
  const changeName = `pr-${target.prNumber}`;
  const scope = worktreeInitializationScope({
    repoRootDir: workspaceDir,
    changeName,
  });
  await reconcileReviewWorkspaceMetadata(
    workspaceDir,
    { owner: target.owner, repo: target.repo },
    repo,
  );
  await writeWorktreeMetadata(workspaceDir, {
    featureName: changeName,
    repos: [{ ...repo, hasLockfile: false }],
  });
  await initializeWorktreeSetup({
    repoRootDir: workspaceDir,
    changeName,
    repo,
  });

  // The foreground run is only mirror/base/PR checkout. Once the worktree is
  // ready, the shared scoped pipeline hands its initializers to a worker so a
  // review can detach without interrupting the checkout itself.
  let metadata: ReviewMetadata | undefined;
  let failure: Error | undefined;
  let outcome: PresentRunOutcome = "background";
  const session = await createRunSession({
    scope,
    command: "review",
    repos: [repo.name],
  });
  try {
    const presented = await presentRun({
      session,
      scope,
      pipelines: new Map([
        [
          repo.name,
          runScopedRepoSetupPipeline({
            repo,
            scope,
            rootDir: workspaceDir,
            repoDir: targetDir,
            branchName: changeName,
            isNewWorkspace: true,
            monitorBackground: false,
            session,
            gitPhaseEvents: reviewPipelineEvents(
              repo,
              reviewCheckoutGitPipeline(
                {
                  target,
                  repo,
                  mirrorDir,
                  baseRepoDir,
                  targetDir,
                },
                {
                  recordMetadata: (value) => {
                    metadata = value;
                  },
                },
              ),
            ),
          }),
        ],
      ]),
      repoNames: [repo.name],
      interactive,
      targetDir,
      ...(onEvent ? { onEvent } : {}),
      nextSteps: isShellAutoCdEnabled() ? [] : [`cd ${compactHome(targetDir)}`],
      onFailure: (_repoName, state) => {
        failure = state.error;
      },
      onBeforeCompletionPrompt: async () => {
        if (!metadata) return;
        await upsertReviewWorktree(workspaceDir, {
          pr_number: target.prNumber,
          path: path.relative(workspaceDir, targetDir),
          ...(metadata.branch ? { branch: metadata.branch } : {}),
          created_at: metadata.created_at,
        });
      },
    });
    outcome = presented.outcome;
  } finally {
    await session.close().catch(() => undefined);
  }

  if (failure) {
    await cleanupFailedReviewWorktree(mirrorDir, targetDir);
    throw failure;
  }
  if (outcome === "failed") {
    await cleanupFailedReviewWorktree(mirrorDir, targetDir);
    throw new Error(
      `Review checkout for ${target.repo}#${target.prNumber} failed.`,
    );
  }
  if (outcome === "cancelled") {
    await cleanupFailedReviewWorktree(mirrorDir, targetDir);
    return { path: targetDir, reused: false, outcome };
  }
  if (!metadata) {
    throw new Error(
      `Review checkout for ${target.repo}#${target.prNumber} did not complete.`,
    );
  }

  return { metadata, reused: false, outcome };
}

export async function ensureReviewWorkspace({
  target,
  reviewsRoot,
  interactive = false,
  onEvent,
}: EnsureReviewWorkspaceOptions): Promise<ReviewWorkspace> {
  validateReviewRepoTarget(target);
  const repo = targetToRepoConfig(target);
  const mirrorDir = await resolveMirrorDir(repo, getCacheDir());
  const workspaceDir = getRepoReviewsDir(reviewsRoot, target.repo);

  await ensureDir(workspaceDir);
  const scope = workspaceInitializationScope(workspaceDir);
  const session = await createRunSession({
    scope,
    command: "review",
    repos: [repo.name],
  });
  let failure: Error | undefined;
  let outcome: PresentRunOutcome = "background";
  try {
    const presented = await presentRun({
      session,
      scope,
      pipelines: new Map([
        [
          repo.name,
          reviewEventPipeline(
            session,
            reviewPipelineEvents(
              repo,
              reviewWorkspaceSetupPipeline({ repo, mirrorDir }),
            ),
          ),
        ],
      ]),
      repoNames: [repo.name],
      interactive,
      targetDir: workspaceDir,
      canDetach: false,
      ...(onEvent ? { onEvent } : {}),
      nextSteps: isShellAutoCdEnabled()
        ? []
        : [`cd ${compactHome(workspaceDir)}`],
      onFailure: (_repoName, state) => {
        failure = state.error;
      },
    });
    outcome = presented.outcome;
  } finally {
    await session.close().catch(() => undefined);
  }
  if (failure) throw failure;
  if (outcome === "failed") {
    throw new Error(`Review workspace setup for ${target.repo} failed.`);
  }
  if (outcome === "cancelled")
    return { ...target, path: workspaceDir, outcome };

  await reconcileReviewWorkspaceMetadata(workspaceDir, target, repo);

  return {
    ...target,
    path: workspaceDir,
    outcome,
  };
}

/**
 * Write (or repair) the review workspace's `workspace.json` so it is typed as a
 * review with the correct repo. Idempotent — a no-op when already consistent.
 */
async function reconcileReviewWorkspaceMetadata(
  workspaceDir: string,
  target: ReviewRepoTarget,
  repo: RepositorySource,
): Promise<void> {
  const existingMetadata = await readWorkspaceMetadata(workspaceDir);
  if (!existingMetadata) {
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: target.repo,
      type: "review",
      review: target,
      repos: [
        {
          name: repo.name,
          remote: repo.remote,
          hasLockfile: false,
        },
      ],
    });
    return;
  }

  if (
    existingMetadata.workspace.type !== "review" ||
    existingMetadata.workspace.review?.owner !== target.owner ||
    existingMetadata.workspace.review?.repo !== target.repo ||
    existingMetadata.repos.length !== 1 ||
    existingMetadata.repos[0]?.name !== repo.name
  ) {
    await saveWorkspaceMetadata(workspaceDir, {
      ...existingMetadata,
      workspace: {
        ...existingMetadata.workspace,
        type: "review",
        review: target,
      },
      repos: [
        {
          name: repo.name,
          remote: repo.remote,
          has_lockfile: false,
        },
      ],
    });
  }
}

/**
 * Mirror → base detached checkout, emitting {@link RepoPipelineState} so `wf
 * review` renders the same git progress as every other creation command. The
 * PR worktree's own initializers run only after the foreground handoff.
 */
async function* reviewMirrorSteps({
  repo,
  mirrorDir,
}: {
  repo: RepositorySource;
  mirrorDir: string;
}): AsyncGenerator<RepoPipelineState> {
  for await (const state of ensureMirrorRepo(repo, mirrorDir)) {
    if (state.status === "failed") throw state.error;
    const mapped = mapTaskStateToPipelineState(state, "mirror");
    if (mapped) yield mapped;
  }
}

async function* reviewBaseSetupSteps({
  repo,
  mirrorDir,
  repoDir,
}: {
  repo: RepositorySource;
  mirrorDir: string;
  repoDir: string;
}): AsyncGenerator<RepoPipelineState> {
  yield* reviewMirrorSteps({ repo, mirrorDir });

  if (!(await pathExists(repoDir))) {
    for await (const state of addWorktree({
      gitDir: mirrorDir,
      targetDir: repoDir,
      base: { defaultBranchOf: mirrorDir, fallback: "main" },
      branch: { kind: "detach" },
      onExistingDir: "reuse",
    })) {
      const mapped = mapTaskStateToPipelineState(state, "worktree");
      if (mapped) yield mapped;
    }
  }
}

/**
 * Record a legacy review pipeline as run events, then immediately derive its
 * compatibility states for `presentRun`. Review checkout uses the event stream
 * directly through `runScopedRepoSetupPipeline`; the metadata-only workspace
 * path has no initialization worker and uses this adapter instead.
 */
async function* reviewPipelineEvents(
  repo: RepositorySource,
  pipeline: AsyncGenerator<RepoPipelineState>,
): AsyncGenerator<RunEventBody> {
  yield { kind: "repo-start", repo: repo.name };
  const bridge = createPipelineEventBridge(repo.name);
  for await (const state of pipeline) {
    yield* bridge.convert(state);
  }
}

async function* reviewEventPipeline(
  session: RunSession,
  events: AsyncGenerator<RunEventBody>,
): AsyncGenerator<RepoPipelineState> {
  const converter = createPipelineStateConverter();
  for await (const event of session.record(events)) {
    yield* converter.convert(event);
  }
}

/**
 * `wf review` (no PR): ensure the bare mirror exists as a single setup pane.
 * The review workspace is metadata-only — no base repo worktree is checked out.
 */
async function* reviewWorkspaceSetupPipeline(args: {
  repo: RepositorySource;
  mirrorDir: string;
}): AsyncGenerator<RepoPipelineState> {
  try {
    yield* reviewMirrorSteps(args);
    yield { phase: "complete", hasLockfile: false };
  } catch (error) {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    yield { phase: "failed", error: normalized };
  }
}

/**
 * `wf review checkout`: base workspace prep (if needed) → PR worktree →
 * `gh pr checkout`, then emits a foreground handoff. The scoped pipeline starts
 * repository initialization after that event, so detach never interrupts git.
 */
async function* reviewCheckoutGitPipeline(
  {
    target,
    repo,
    mirrorDir,
    baseRepoDir,
    targetDir,
  }: {
    target: ReviewTarget;
    repo: RepositorySource;
    mirrorDir: string;
    baseRepoDir: string;
    targetDir: string;
  },
  {
    recordMetadata,
  }: {
    recordMetadata: (metadata: ReviewMetadata) => void;
  },
): AsyncGenerator<RepoPipelineState> {
  try {
    yield* reviewBaseSetupSteps({
      repo,
      mirrorDir,
      repoDir: baseRepoDir,
    });

    // Detached checkout of the trunk; `gh pr checkout` immediately moves it to
    // the PR head (possibly a fork branch), which the shared primitive can't
    // express.
    for await (const state of addWorktree({
      gitDir: mirrorDir,
      targetDir,
      base: { defaultBranchOf: mirrorDir, fallback: "main" },
      branch: { kind: "detach" },
    })) {
      const mapped = mapTaskStateToPipelineState(state, "worktree");
      if (mapped) yield mapped;
    }

    yield {
      phase: "git",
      step: "worktree",
      status: "running",
      message: `Checking out PR #${target.prNumber}`,
    };
    await runCommand("gh", ["pr", "checkout", String(target.prNumber)], {
      cwd: targetDir,
    });

    const branch = await getCurrentBranch(targetDir);
    recordMetadata({
      ...target,
      path: targetDir,
      ...(branch ? { branch } : {}),
      created_at: new Date().toISOString(),
    });
    yield {
      phase: "worktree-ready",
      hasLockfile: await hasAny(targetDir, ["pnpm-lock.yaml", "pnpm-lock.yml"]),
    };
  } catch (error) {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    yield { phase: "failed", error: normalized };
  }
}

export async function listReviewWorktrees(
  reviewsRoot: string,
  repo?: string,
): Promise<ReviewListEntry[]> {
  const resolvedReviewsDir = path.resolve(reviewsRoot);
  if (!(await pathExists(resolvedReviewsDir))) {
    return [];
  }

  const repoDirs = repo
    ? [validateRepositoryComponent(repo, "Repository name")]
    : (await fs.readdir(resolvedReviewsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

  const entries: ReviewListEntry[] = [];
  for (const repoName of repoDirs) {
    const workspaceDir = resolveContainedPath(resolvedReviewsDir, repoName);
    const metadata = await readWorkspaceMetadata(workspaceDir);
    if (!metadata?.workspace.review) {
      continue;
    }

    for (const worktree of metadata.review_worktrees ?? []) {
      const absolutePath = resolveContainedPath(workspaceDir, worktree.path);
      entries.push({
        owner: metadata.workspace.review.owner,
        repo: metadata.workspace.review.repo,
        prNumber: worktree.pr_number,
        path: absolutePath,
        ...(worktree.branch ? { branch: worktree.branch } : {}),
        created_at: worktree.created_at,
        state: (await pathExists(absolutePath)) ? "ready" : "stale",
      });
    }
  }

  entries.sort((a, b) =>
    a.repo === b.repo ? a.prNumber - b.prNumber : a.repo.localeCompare(b.repo),
  );
  return entries;
}

export async function removeReviewWorktree({
  target,
  reviewsRoot,
  dryRun = false,
  force = false,
}: RemoveReviewWorktreeOptions): Promise<RemoveReviewWorktreeResult> {
  validateReviewTarget(target);
  const targetDir = getReviewWorktreePath(reviewsRoot, target);
  const workspaceDir = getRepoReviewsDir(reviewsRoot, target.repo);
  const metadata = await readReviewWorktreeMetadata(workspaceDir, target);
  const branch =
    metadata?.branch ?? (await getCurrentBranchIfExists(targetDir));
  const exists = await pathExists(targetDir);
  const repo = targetToRepoConfig(target);
  const mirrorDir = await resolveMirrorDir(repo, getCacheDir());

  if (!exists && !metadata) {
    throw new Error(
      `No review worktree found for ${target.repo}#${target.prNumber}.`,
    );
  }

  if (dryRun) {
    return {
      path: targetDir,
      ...(branch ? { branch } : {}),
      dryRun: true,
    };
  }

  if (exists) {
    if (!force && (await isGitDirty(targetDir))) {
      throw new Error(
        `Review worktree "${target.repo}#${target.prNumber}" has uncommitted changes. Commit, discard, or pass --force.`,
      );
    }

    for await (const _state of removeWorktree({
      gitDir: mirrorDir,
      worktreePath: targetDir,
      force,
      timeoutMs: 30_000,
    })) {
      // Drained; review worktree removal does not surface per-step progress.
    }
  }

  if (branch) {
    await deleteBranchIfPossible(mirrorDir, branch, force);
  }

  if (await readWorkspaceMetadata(workspaceDir)) {
    await removeReviewWorktreeMetadata(workspaceDir, target.prNumber);
  }

  return {
    path: targetDir,
    ...(branch ? { branch } : {}),
    dryRun: false,
  };
}

function parseSingleTarget(input: string): ReviewTarget {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Missing GitHub PR target.");
  }

  const normalized = trimmed.startsWith("github.com/")
    ? `https://${trimmed}`
    : trimmed;

  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    let url: URL;
    try {
      url = new URL(normalized);
    } catch {
      throw new Error(`Invalid GitHub PR URL: ${input}`);
    }

    if (url.hostname.toLowerCase() !== "github.com") {
      throw new Error(`Invalid GitHub PR URL: ${input}`);
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 4 || parts[2] !== "pull") {
      throw new Error(`Invalid GitHub PR URL: ${input}`);
    }

    return {
      owner: validateRepoPart(parts[0] ?? "", "owner"),
      repo: validateRepoPart(parts[1] ?? "", "repo"),
      prNumber: parsePrNumber(parts[3] ?? ""),
    };
  }

  const compact = trimmed.match(/^([^/\s#]+)\/([^/\s#]+)#(.+)$/);
  if (compact) {
    return {
      owner: validateRepoPart(compact[1] ?? "", "owner"),
      repo: validateRepoPart(compact[2] ?? "", "repo"),
      prNumber: parsePrNumber(compact[3] ?? ""),
    };
  }

  throw new Error("Expected a GitHub PR URL or <owner>/<repo> <pr-number>.");
}

function parseRepoTarget(input: string): Pick<ReviewTarget, "owner" | "repo"> {
  const target = parseRepoSlugTarget(input) ?? parseGitHubRepoUrlTarget(input);
  if (target) {
    return target;
  }
  throw new Error(
    `Invalid repository "${input}". Expected <owner>/<repo> or a GitHub git URL.`,
  );
}

function parseRepoSlugTarget(
  input: string,
): Pick<ReviewTarget, "owner" | "repo"> | null {
  const trimmed = input.trim();
  if (
    trimmed.includes("://") ||
    trimmed.includes("@") ||
    trimmed.startsWith("github.com/") ||
    trimmed.startsWith("git:") ||
    trimmed.includes("#")
  ) {
    return null;
  }

  const parts = input.trim().split("/");
  if (parts.length !== 2) {
    return null;
  }

  return {
    owner: validateRepoPart(parts[0] ?? "", "owner"),
    repo: validateRepoPart(parts[1] ?? "", "repo"),
  };
}

function parseGitHubRepoUrlTarget(
  input: string,
): Pick<ReviewTarget, "owner" | "repo"> | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const sshMatch = trimmed.match(
    /^git@github\.com:([^/\s#]+)\/([^/\s#]+?)(?:\.git)?$/i,
  );
  if (sshMatch?.[1] && sshMatch[2]) {
    return {
      owner: validateRepoPart(sshMatch[1], "owner"),
      repo: validateRepoPart(sshMatch[2], "repo"),
    };
  }

  const normalized = trimmed.startsWith("github.com/")
    ? `https://${trimmed}`
    : trimmed;
  if (!/^(?:https?|ssh|git):\/\//i.test(normalized)) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== "github.com") {
    return null;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }

  return {
    owner: validateRepoPart(parts[0] ?? "", "owner"),
    repo: validateRepoPart(parts[1] ?? "", "repo"),
  };
}

function validateRepoPart(value: string, label: "owner" | "repo"): string {
  return validateRepositoryComponent(
    value.trim().replace(/\.git$/i, ""),
    label === "owner" ? "GitHub owner" : "GitHub repository",
  );
}

function parsePrNumber(input: string): number {
  const normalized = input.trim().replace(/^#/, "");
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new Error(`Invalid pull request number: ${input}`);
  }
  return Number(normalized);
}

function targetToRepoConfig(target: ReviewRepoTarget): RepositorySource {
  return {
    name: target.repo,
    remote: `git@github.com:${target.owner}/${target.repo}.git`,
  };
}

async function cleanupFailedReviewWorktree(
  mirrorDir: string,
  targetDir: string,
): Promise<void> {
  try {
    for await (const _state of removeWorktree({
      gitDir: mirrorDir,
      worktreePath: targetDir,
      force: true,
      timeoutMs: 30_000,
    })) {
      // Drained; the original gh failure is preserved on error.
    }
  } catch {
    // Preserve the original gh failure.
  }
}

async function getCurrentBranchIfExists(
  repoDir: string,
): Promise<string | undefined> {
  if (!(await pathExists(repoDir))) return undefined;
  try {
    return await getCurrentBranch(repoDir);
  } catch {
    return undefined;
  }
}

function getRepoReviewsDir(reviewsRoot: string, repo: string): string {
  return resolveContainedPath(
    path.resolve(reviewsRoot),
    validateRepositoryComponent(repo, "Repository name"),
  );
}

function getReviewWorktreePath(
  reviewsRoot: string,
  target: ReviewTarget,
): string {
  return resolveContainedPath(
    getRepoReviewsDir(reviewsRoot, target.repo),
    `pr-${target.prNumber}`,
  );
}

async function readReviewWorktreeMetadata(
  workspaceDir: string,
  target: ReviewTarget,
): Promise<ReviewMetadata | null> {
  const metadata = await readWorkspaceMetadata(workspaceDir);
  if (!metadata?.workspace.review) return null;

  const worktree = (metadata.review_worktrees ?? []).find(
    (entry) => entry.pr_number === target.prNumber,
  );
  if (!worktree) return null;

  return {
    owner: metadata.workspace.review.owner,
    repo: metadata.workspace.review.repo,
    prNumber: worktree.pr_number,
    path: resolveContainedPath(workspaceDir, worktree.path),
    ...(worktree.branch ? { branch: worktree.branch } : {}),
    created_at: worktree.created_at,
  };
}

function validateReviewRepoTarget(target: ReviewRepoTarget): void {
  validateRepositoryComponent(target.owner, "GitHub owner");
  validateRepositoryComponent(target.repo, "GitHub repository");
}

function validateReviewTarget(target: ReviewTarget): void {
  validateReviewRepoTarget(target);
  if (!Number.isSafeInteger(target.prNumber) || target.prNumber < 1) {
    throw new Error(`Invalid pull request number: ${target.prNumber}`);
  }
}
