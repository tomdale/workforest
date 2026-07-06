import path from "node:path";
import { hasAny } from "@wf-plugin/core";
import { getCacheDir, loadWorkspaceConfig } from "../config.ts";
import { restoreNodeModules } from "../node-modules-cache.ts";
import { resolveMirrorDir } from "../repositories.ts";
import { validateRepositoryComponent } from "../repository-components.ts";
import {
  runSingleRepoInitializers,
  type SingleRepoInitializerState,
} from "../services/initializers/index.ts";
import { addWorktree } from "../services/worktree.ts";
import type { RepositorySource } from "../types.ts";
import { resolveContainedPath } from "../utils/path-safety.ts";
import type { TaskState } from "../utils/task-generator.ts";
import { cleanupWorkspaceWorktrees, ensureMirrorRepo } from "./repository.ts";
import {
  GIT_STEP_IDS,
  PREFLIGHT_STEP_ID,
  type RunEventBody,
  type StepId,
  toRunEventError,
} from "./run-log/events.ts";
import {
  createPipelineStateConverter,
  initializerStatesToEvents,
  taskToEvents,
} from "./run-log/instrument.ts";

/**
 * State emitted by a per-repo pipeline.
 * Each repo runs its entire pipeline (git + initializers) independently.
 */
export type RepoPipelineState =
  | {
      phase: "git";
      step: "mirror" | "cleanup" | "worktree";
      status: TaskState["status"];
      output?: string;
      message?: string;
    }
  | {
      phase: "initializer";
      name: string;
      status: TaskState["status"];
      output?: string;
      message?: string;
    }
  | { phase: "worktree-ready"; hasLockfile: boolean }
  | { phase: "complete"; hasLockfile: boolean }
  | { phase: "cancelled"; message?: string }
  | { phase: "failed"; error: Error; step?: string };

export type RepoPipelineOptions = {
  repo: RepositorySource;
  workspaceDir: string;
  repoDir?: string;
  branchName: string;
  isNewWorkspace: boolean;
  disabledInitializers?: boolean | string[];
  skipInitializers?: boolean;
  beforeInitializers?: (context: {
    repo: RepositorySource;
    repoDir: string;
    workspaceDir: string;
  }) => Promise<void>;
  afterWorktree?: (context: {
    repo: RepositorySource;
    repoDir: string;
    workspaceDir: string;
  }) => Promise<void>;
};

export type RepoInitializationOptions = {
  repo: RepositorySource;
  workspaceDir: string;
  repoDir?: string;
  disabledInitializers?: boolean | string[];
};

/**
 * Event-native pipeline for a single repository's setup: git phase (mirror →
 * cleanup → worktree), pooled node_modules restore, pre-initializer
 * preparation, then either a `worktree-ready` handoff (skipInitializers) or
 * the inline initializer phase ending in `repo-end`.
 *
 * Total by construction: failures become events, never throws, so callers
 * running many of these in parallel need no per-repo error handling.
 */
export async function* repoSetupEvents({
  repo,
  workspaceDir,
  repoDir,
  branchName,
  isNewWorkspace,
  disabledInitializers,
  skipInitializers,
  beforeInitializers,
  afterWorktree,
}: RepoPipelineOptions): AsyncGenerator<RunEventBody> {
  const repoName = validateRepositoryComponent(repo.name, "Repository name");
  yield { kind: "repo-start", repo: repoName };

  let failStep: StepId = "setup:start";
  try {
    const cacheDir = getCacheDir();
    const mirrorDir = await resolveMirrorDir(repo, cacheDir);
    const targetDir = repoDir
      ? path.resolve(repoDir)
      : resolveContainedPath(workspaceDir, repoName);

    failStep = GIT_STEP_IDS.mirror;
    const mirror = yield* taskToEvents(ensureMirrorRepo(repo, mirrorDir), {
      repo: repoName,
      step: GIT_STEP_IDS.mirror,
      title: "mirror",
    });
    if (mirror.outcome === "failed") {
      yield repoFailure(repoName, GIT_STEP_IDS.mirror, mirror.error);
      return;
    }

    if (!isNewWorkspace) {
      failStep = GIT_STEP_IDS.cleanup;
      const cleanup = yield* taskToEvents(
        cleanupWorkspaceWorktrees(mirrorDir, workspaceDir),
        { repo: repoName, step: GIT_STEP_IDS.cleanup, title: "cleanup" },
      );
      if (cleanup.outcome === "failed") {
        yield repoFailure(repoName, GIT_STEP_IDS.cleanup, cleanup.error);
        return;
      }
    }

    failStep = GIT_STEP_IDS.worktree;
    const worktree = yield* taskToEvents(
      addWorktree({
        gitDir: mirrorDir,
        targetDir,
        base: { defaultBranchOf: mirrorDir, fallback: "main" },
        // `reset` + `reuse` preserves the long-standing idempotent behavior
        // (re-running over an existing checkout is a no-op), while the
        // primitive's guard refuses to reset a branch that carries commits
        // not on the base.
        branch: { kind: "reset", name: branchName },
        onExistingDir: "reuse",
        label: `worktree:${repo.name}`,
      }),
      { repo: repoName, step: GIT_STEP_IDS.worktree, title: "worktree" },
    );
    if (worktree.outcome === "failed") {
      yield repoFailure(repoName, GIT_STEP_IDS.worktree, worktree.error);
      return;
    }

    if (afterWorktree) {
      failStep = PREFLIGHT_STEP_ID;
      await afterWorktree({ repo, repoDir: targetDir, workspaceDir });
    }

    const { config } = await loadWorkspaceConfig();
    const restoreResult = await restoreNodeModules({
      repo,
      repoDir: targetDir,
      config: config.cache?.nodeModules,
      ...(disabledInitializers !== undefined ? { disabledInitializers } : {}),
    });
    if (restoreResult.status === "restored") {
      yield {
        kind: "step-log",
        repo: repoName,
        step: GIT_STEP_IDS.worktree,
        level: "info",
        message: `Restored pooled node_modules for ${repo.name}`,
      };
    } else if (restoreResult.status === "warning") {
      yield {
        kind: "step-log",
        repo: repoName,
        step: GIT_STEP_IDS.worktree,
        level: "warn",
        message: restoreResult.warning,
      };
    }

    if (beforeInitializers) {
      failStep = PREFLIGHT_STEP_ID;
      await beforeInitializers({ repo, repoDir: targetDir, workspaceDir });
    }

    if (skipInitializers) {
      failStep = "setup:lockfile";
      const hasLockfile = await hasAny(targetDir, [
        "pnpm-lock.yaml",
        "pnpm-lock.yml",
      ]);
      yield { kind: "worktree-ready", repo: repoName, hasLockfile };
      return;
    }

    yield* repoInitializationEvents({
      repo,
      workspaceDir,
      ...(disabledInitializers !== undefined ? { disabledInitializers } : {}),
    });
  } catch (error) {
    yield repoFailure(
      repoName,
      failStep,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/**
 * Event-native initializer phase for a single repository. Intentionally
 * independent from worktree creation so it can run in a detached worker
 * after the foreground command returns. Total: never throws.
 */
export async function* repoInitializationEvents({
  repo,
  workspaceDir,
  repoDir,
  disabledInitializers,
}: RepoInitializationOptions): AsyncGenerator<RunEventBody> {
  const repoName = validateRepositoryComponent(repo.name, "Repository name");
  const resolvedRepoDir = repoDir
    ? path.resolve(repoDir)
    : resolveContainedPath(workspaceDir, repoName);

  try {
    const result = yield* initializerStatesToEvents(
      runSingleRepoInitializers({
        context: { repoDir: resolvedRepoDir, workspaceDir, repo },
        ...(disabledInitializers !== undefined ? { disabledInitializers } : {}),
      }),
      repoName,
    );
    if (result.outcome === "failed") {
      yield repoFailure(repoName, result.step, result.error);
      return;
    }

    const hasLockfile = await hasAny(resolvedRepoDir, [
      "pnpm-lock.yaml",
      "pnpm-lock.yml",
    ]);
    yield { kind: "repo-end", repo: repoName, outcome: "ready", hasLockfile };
  } catch (error) {
    yield repoFailure(
      repoName,
      "setup:lockfile",
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

function repoFailure(
  repo: string,
  step: StepId,
  error: Error | undefined,
): RunEventBody {
  return {
    kind: "repo-end",
    repo,
    outcome: "failed",
    step,
    error: toRunEventError(error ?? new Error("Repository setup failed.")),
  };
}

/**
 * Runs the full pipeline for a single repository, yielding progress.
 * Stages: git (mirror → cleanup → worktree) → initializers (install → linking)
 *
 * Legacy-state view over {@link repoSetupEvents} for surfaces that still
 * consume RepoPipelineState.
 */
export async function* repoPipeline(
  options: RepoPipelineOptions,
): AsyncGenerator<RepoPipelineState> {
  yield* eventsToStates(repoSetupEvents(options));
}

/**
 * Run only the initializer portion of a repository pipeline, as legacy
 * states. See {@link repoInitializationEvents}.
 */
export async function* repoInitialization(
  options: RepoInitializationOptions,
): AsyncGenerator<RepoPipelineState> {
  yield* eventsToStates(repoInitializationEvents(options));
}

async function* eventsToStates(
  events: AsyncGenerator<RunEventBody>,
): AsyncGenerator<RepoPipelineState> {
  const converter = createPipelineStateConverter();
  for await (const event of events) {
    yield* converter.convert(event);
  }
}

/**
 * Map a TaskState from git operations to a RepoPipelineState.
 */
export function mapTaskStateToPipelineState(
  state: TaskState,
  step: "mirror" | "cleanup" | "worktree",
): RepoPipelineState | null {
  switch (state.status) {
    case "running":
      return {
        phase: "git",
        step,
        status: "running",
        ...(state.message !== undefined ? { message: state.message } : {}),
      };
    case "output":
      return {
        phase: "git",
        step,
        status: "output",
        output: state.data,
      };
    case "log":
      return {
        phase: "git",
        step,
        status: "running",
        ...(state.message !== undefined ? { message: state.message } : {}),
      };
    case "retrying":
      return {
        phase: "git",
        step,
        status: "retrying",
        message: `Retry ${state.attempt}: ${state.reason}`,
      };
    case "completed":
      return {
        phase: "git",
        step,
        status: "completed",
      };
    case "failed":
      return {
        phase: "git",
        step,
        status: "failed",
      };
    case "skipped":
      return {
        phase: "git",
        step,
        status: "skipped",
        message: state.reason,
      };
    case "pending":
      return null;
  }
}

/**
 * Map a SingleRepoInitializerState to a RepoPipelineState.
 */
export function mapInitializerStateToPipelineState(
  state: SingleRepoInitializerState,
): RepoPipelineState | null {
  switch (state.phase) {
    case "detecting":
      return {
        phase: "initializer",
        name: "detecting",
        status: "running",
        message: "Detecting project type...",
      };
    case "running":
      return {
        phase: "initializer",
        name: state.initializerName,
        status: state.state.status,
        ...(state.state.status === "output"
          ? { output: state.state.data }
          : {}),
        ...(state.state.status === "running" &&
        state.state.message !== undefined
          ? { message: state.state.message }
          : {}),
      };
    case "skipped":
      return {
        phase: "initializer",
        name: state.initializerId,
        status: "skipped",
        message: state.reason,
      };
    case "complete":
      return null;
  }
}
