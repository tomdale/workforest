import path from "node:path";
import { getCacheDir } from "../config.ts";
import {
  runSingleRepoInitializersGenerator,
  type SingleRepoInitializerState,
} from "../services/initializers/index.ts";
import { hasAny } from "../services/pnpm.ts";
import type { RepoConfig } from "../types.ts";
import type { TaskState } from "../utils/task-generator.ts";
import {
  cleanupWorkspaceWorktreesGenerator,
  ensureMirrorRepoGenerator,
  ensureWorkingCopyGenerator,
} from "./repository.ts";

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
  | { phase: "complete"; hasLockfile: boolean }
  | { phase: "failed"; error: Error };

export type RepoPipelineOptions = {
  repo: RepoConfig;
  workspaceDir: string;
  branchName: string;
  isNewWorkspace: boolean;
  disabledInitializers?: boolean | string[];
  skipInitializers?: boolean;
};

/**
 * Generator that runs the full pipeline for a single repository.
 * Stages: git (mirror → cleanup → worktree) → initializers (install → linking)
 *
 * This enables cross-phase parallelism: repo A can start initializers while
 * repo B is still doing git operations.
 */
export async function* repoPipelineGenerator({
  repo,
  workspaceDir,
  branchName,
  isNewWorkspace,
  disabledInitializers,
  skipInitializers,
}: RepoPipelineOptions): AsyncGenerator<RepoPipelineState> {
  const cacheDir = getCacheDir();
  const mirrorDir = path.join(cacheDir, `${repo.name}.git`);
  const targetDir = path.join(workspaceDir, repo.name);

  // ─────────────────────────────────────────────────────────────────────────
  // Git Phase: mirror → cleanup → worktree
  // ─────────────────────────────────────────────────────────────────────────

  // Step 1: Mirror (fetch or clone)
  for await (const state of ensureMirrorRepoGenerator(repo, mirrorDir)) {
    const pipelineState = mapTaskStateToPipelineState(state, "mirror");
    if (pipelineState) yield pipelineState;
    if (state.status === "failed") {
      yield { phase: "failed", error: state.error };
      return;
    }
  }

  // Step 2: Cleanup stale worktrees (skip for new workspaces)
  if (!isNewWorkspace) {
    for await (const state of cleanupWorkspaceWorktreesGenerator(
      mirrorDir,
      workspaceDir,
    )) {
      const pipelineState = mapTaskStateToPipelineState(state, "cleanup");
      if (pipelineState) yield pipelineState;
      if (state.status === "failed") {
        yield { phase: "failed", error: state.error };
        return;
      }
    }
  }

  // Step 3: Create worktree
  for await (const state of ensureWorkingCopyGenerator(
    repo,
    mirrorDir,
    targetDir,
    branchName,
  )) {
    const pipelineState = mapTaskStateToPipelineState(state, "worktree");
    if (pipelineState) yield pipelineState;
    if (state.status === "failed") {
      yield { phase: "failed", error: state.error };
      return;
    }
  }

  const context = {
    repoDir: targetDir,
    workspaceDir,
    repo,
  };

  if (skipInitializers) {
    const hasLockfile = await hasAny(targetDir, [
      "pnpm-lock.yaml",
      "pnpm-lock.yml",
    ]);

    yield { phase: "complete", hasLockfile };
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Initializers Phase: install → linking
  // ─────────────────────────────────────────────────────────────────────────

  for await (const state of runSingleRepoInitializersGenerator({
    context,
    disabledInitializers,
  })) {
    const pipelineState = mapInitializerStateToPipelineState(state);
    if (pipelineState) yield pipelineState;

    // Check for initializer failure
    if (state.phase === "running" && state.state.status === "failed") {
      yield { phase: "failed", error: state.state.error };
      return;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Complete
  // ─────────────────────────────────────────────────────────────────────────

  const hasLockfile = await hasAny(targetDir, [
    "pnpm-lock.yaml",
    "pnpm-lock.yml",
  ]);

  yield { phase: "complete", hasLockfile };
}

/**
 * Map a TaskState from git operations to a RepoPipelineState.
 */
function mapTaskStateToPipelineState(
  state: TaskState,
  step: "mirror" | "cleanup" | "worktree",
): RepoPipelineState | null {
  switch (state.status) {
    case "running":
      return {
        phase: "git",
        step,
        status: "running",
        message: state.message,
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
        message: state.message,
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
function mapInitializerStateToPipelineState(
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
        output: state.state.status === "output" ? state.state.data : undefined,
        message:
          state.state.status === "running" ? state.state.message : undefined,
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
