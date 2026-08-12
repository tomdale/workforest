import { promises as fs } from "node:fs";
import { pathExists } from "@wf-plugin/core";
import {
  type PreserveNodeModulesResult,
  preserveNodeModules,
  rollbackPreservedNodeModules,
} from "../node-modules-cache.ts";
import {
  deleteBranchIfPossible,
  removeWorktree,
} from "../services/worktree.ts";
import type { NodeModulesCacheConfig, RepositorySource } from "../types.ts";

/**
 * Physical disposal of one linked checkout. Every surface that tears down a
 * worktree (standalone change, nested task, review PR) must go through this so
 * node_modules preservation, git worktree removal, residual directory cleanup,
 * and optional branch deletion cannot drift apart again.
 */
export type DisposeWorktreeCheckoutOptions = Readonly<{
  /** Bare mirror or parent checkout that owns the worktree admin entry. */
  gitDir: string;
  worktreePath: string;
  /**
   * When set, eligible `node_modules` are renamed into the cache before git
   * walks the tree. Skipping this is what made review delete hang on large
   * installs.
   */
  repo?: RepositorySource;
  nodeModulesConfig?: NodeModulesCacheConfig;
  /**
   * Forwarded to `git worktree remove`. Callers that already enforced their
   * own dirty-tree policy (review, task) pass `true` after that check so git
   * cannot re-evaluate mid-delete.
   */
  force?: boolean;
  /** Delete this local branch from `gitDir` after the checkout is gone. */
  branch?: string;
  /**
   * When deleting `branch`, use `git branch -D` instead of `-d`. Defaults to
   * `force` so a single abandon flag still means abandon, but callers that
   * force-remove after an explicit dirty check can keep safe branch deletion.
   */
  forceBranchDelete?: boolean;
  timeoutMs?: number;
  /** When false, the caller already holds the worktree lock. */
  lock?: boolean;
}>;

export type DisposeWorktreeCheckoutResult = Readonly<{
  status: "removed" | "stale" | "missing";
  nodeModules: PreserveNodeModulesResult["status"];
  branchDeleted: boolean;
}>;

/**
 * Preserve → remove worktree → sweep residual directory → optional branch
 * delete. Rolls preserved node_modules back if git removal fails so a partial
 * delete never strands dependencies in the cache while the checkout remains.
 */
export async function disposeWorktreeCheckout(
  options: DisposeWorktreeCheckoutOptions,
): Promise<DisposeWorktreeCheckoutResult> {
  const {
    gitDir,
    worktreePath,
    repo,
    nodeModulesConfig,
    force = false,
    branch,
    forceBranchDelete = force,
    timeoutMs,
    lock = true,
  } = options;

  const exists = await pathExists(worktreePath);
  let preserved: PreserveNodeModulesResult = { status: "missing" };

  if (exists && repo) {
    preserved = await preserveNodeModules({
      repo,
      repoDir: worktreePath,
      config: nodeModulesConfig,
    });
  }

  let status: DisposeWorktreeCheckoutResult["status"] = exists
    ? "removed"
    : "missing";

  if (exists) {
    try {
      for await (const _state of removeWorktree({
        gitDir,
        worktreePath,
        force,
        lock,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      })) {
        // Physical disposal is a single step for callers; progress is owned by
        // higher-level cleanup generators when they need it.
      }
    } catch (error) {
      await rollbackPreservedNodeModules(preserved);
      throw error;
    }
  } else {
    // Directory is already gone (interrupted review, manual rm). Still prune
    // the mirror's admin entry so the next create is not blocked by a stale
    // gitlink.
    try {
      for await (const _state of removeWorktree({
        gitDir,
        worktreePath,
        force: true,
        lock,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      })) {
        // Drained.
      }
      status = "stale";
    } catch {
      status = "missing";
    }
  }

  // `git worktree remove` can leave an empty or partial directory when the
  // checkout was already half-deleted; finish the job unconditionally.
  if (await pathExists(worktreePath)) {
    await fs.rm(worktreePath, { recursive: true, force: true });
  }

  let branchDeleted = false;
  if (branch) {
    await deleteBranchIfPossible(gitDir, branch, forceBranchDelete);
    branchDeleted = true;
  }

  return {
    status,
    nodeModules: preserved.status,
    branchDeleted,
  };
}
