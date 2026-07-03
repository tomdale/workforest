import path from "node:path";
import { pathExists } from "@wf-plugin/core";
import { cloneRepository, fixBareRepoRefs, runGit } from "../services/git.ts";
import {
  hasBrokenWorktreeLink,
  isStaleWorktreeRemoveError,
  pruneWorktreeMetadata,
  withGitWorktreeLock,
} from "../services/worktree.ts";
import type { RepositorySource } from "../types.ts";
import { comparablePath } from "../utils/path-safety.ts";
import { asTask, withRetry } from "../utils/retry.ts";
import type { TaskState } from "../utils/task-generator.ts";

type WorktreeEntry = {
  path: string;
  prunable: boolean;
};

function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("worktree ")) {
      if (current) {
        entries.push(current);
      }

      current = {
        path: line.substring("worktree ".length).trim(),
        prunable: false,
      };
      continue;
    }

    if (line.startsWith("prunable ") && current) {
      current.prunable = true;
    }
  }

  if (current) {
    entries.push(current);
  }

  return entries;
}

async function listWorktrees(mirrorDir: string): Promise<WorktreeEntry[]> {
  const { stdout } = await runGit(["worktree", "list", "--porcelain"], {
    cwd: mirrorDir,
  });

  return parseWorktreeList(stdout);
}

/** Ensures a mirror repository exists and yields progress states. */
export async function* ensureMirrorRepo(
  repo: RepositorySource,
  mirrorDir: string,
): AsyncGenerator<TaskState, void, undefined> {
  const mirrorExists = await pathExists(mirrorDir);

  if (!mirrorExists) {
    yield {
      status: "log",
      level: "info",
      message: `Seeding pristine repo for ${repo.name}`,
    };

    // Clone using gh CLI (with git fallback) - handles SAML SSO auth
    const cloneGen = () =>
      cloneRepository(
        repo.remote,
        mirrorDir,
        [
          "--bare",
          "--filter=blob:none",
          "--config",
          "remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*",
        ],
        {},
      );

    yield* withRetry(cloneGen, {
      attempts: 3,
      label: `clone-pristine:${repo.name}`,
    });

    // Fix refs: move from refs/heads/* to refs/remotes/origin/*
    // This is needed because git clone --bare creates local branches
    yield* fixBareRepoRefs(mirrorDir);
  } else {
    yield* updatePristineRepo(repo, mirrorDir);
  }

  // Prune stale worktree entries only if needed
  yield* pruneStaleWorktreesIfNeeded(mirrorDir);
}

/**
 * Prune stale worktree entries only if there are any pointing to non-existent paths.
 * This avoids the overhead of running `git worktree prune` when it's not needed.
 */
async function* pruneStaleWorktreesIfNeeded(
  mirrorDir: string,
): AsyncGenerator<TaskState, void, undefined> {
  const worktrees = await listWorktrees(mirrorDir);

  let hasStale = false;
  for (const worktree of worktrees) {
    if (worktree.prunable || !(await pathExists(worktree.path))) {
      hasStale = true;
      break;
    }
  }

  if (!hasStale) {
    return; // No stale worktrees, skip pruning
  }

  yield {
    status: "log",
    level: "info",
    message: "Pruning stale worktrees",
  };
  // Serialized: a mirror-wide prune reclaims worktree admin dirs for every
  // workspace of this repo, so it must not race a concurrent `worktree add`
  // from another process holding the same mirror.
  await withGitWorktreeLock(mirrorDir, () =>
    runGit(["worktree", "prune"], { cwd: mirrorDir }),
  );
}

/** Removes a workspace's linked worktrees and yields progress states. */
export async function* cleanupWorkspaceWorktrees(
  mirrorDir: string,
  workspaceDir: string,
): AsyncGenerator<TaskState, void, undefined> {
  // Compare via realpath so a symlinked workspace root still matches the
  // worktree paths git records (which may be resolved differently).
  const normalizedWorkspaceDir = await comparablePath(workspaceDir);
  const worktrees = await listWorktrees(mirrorDir);

  const targets: WorktreeEntry[] = [];
  for (const worktree of worktrees) {
    const normalizedWorktree = await comparablePath(worktree.path);
    if (
      normalizedWorktree === normalizedWorkspaceDir ||
      normalizedWorktree.startsWith(`${normalizedWorkspaceDir}${path.sep}`)
    ) {
      targets.push(worktree);
    }
  }

  if (targets.length === 0) {
    return;
  }

  yield {
    status: "log",
    level: "info",
    message: `Cleaning up ${targets.length} existing worktree(s) under ${workspaceDir}`,
  };

  for (const target of targets) {
    if (target.prunable || (await hasBrokenWorktreeLink(target.path))) {
      yield* pruneWorktreeMetadata(mirrorDir, target.path);
      continue;
    }

    const removeGen = asTask(() =>
      runGit(["worktree", "remove", "--force", target.path], {
        cwd: mirrorDir,
      }),
    );

    try {
      yield* withRetry(removeGen, {
        attempts: 3,
        label: `worktree-remove:${path.basename(target.path)}`,
      });
    } catch (error) {
      if (isStaleWorktreeRemoveError(error)) {
        yield* pruneWorktreeMetadata(mirrorDir, target.path);
        continue;
      }

      throw error;
    }
  }
}

/**
 * Fetches the latest branches into the pristine bare mirror (with retry and
 * case-conflict repair), yielding log messages as it runs.
 */
async function* updatePristineRepo(
  repo: RepositorySource,
  mirrorDir: string,
): AsyncGenerator<TaskState, void, undefined> {
  // --no-tags: Skip fetching tags (faster, we only need branches)
  // --prune: Remove stale remote-tracking refs
  // Explicit refspec/refmap: ignore stale remote.origin.fetch settings that may
  // point remote branches at refs/heads/* in older bare caches.
  const fetchGen = asTask(() =>
    runGit(
      [
        "fetch",
        "--prune",
        "--no-tags",
        "--refmap=",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
      ],
      { cwd: mirrorDir },
    ),
  );

  try {
    yield* withRetry(fetchGen, {
      attempts: 3,
      label: `update-pristine:${repo.name}`,
    });
  } catch (error_) {
    if (yield* repairCaseConflictingRemoteRef(mirrorDir, repo.name, error_)) {
      try {
        yield* withRetry(fetchGen, {
          attempts: 3,
          label: `update-pristine:${repo.name}`,
        });
        return;
      } catch (retryError) {
        yield* warnPristineUpdateFailed(repo.name, retryError);
        return;
      }
    }

    yield* warnPristineUpdateFailed(repo.name, error_);
  }
}

function getCannotLockRef(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/cannot lock ref '([^']+)'/);
  return match?.[1] ?? null;
}

async function* repairCaseConflictingRemoteRef(
  mirrorDir: string,
  repoName: string,
  error: unknown,
): AsyncGenerator<TaskState, boolean, undefined> {
  const lockedRef = getCannotLockRef(error);
  if (!lockedRef?.startsWith("refs/remotes/")) {
    return false;
  }

  const { stdout } = await runGit(
    ["for-each-ref", "--format=%(refname)", "refs/remotes"],
    { cwd: mirrorDir },
  );
  const caseConflictingRefs = stdout
    .trim()
    .split("\n")
    .filter((ref) => ref.toLowerCase() === lockedRef.toLowerCase());

  if (caseConflictingRefs.length <= 1) {
    return false;
  }

  yield {
    status: "log",
    level: "warn",
    message: `Repairing case-conflicting cached refs for ${repoName}: ${caseConflictingRefs.join(", ")}`,
  };

  for (const ref of caseConflictingRefs) {
    await runGit(["update-ref", "-d", ref], { cwd: mirrorDir });
  }

  return true;
}

async function* warnPristineUpdateFailed(
  repoName: string,
  error: unknown,
): AsyncGenerator<TaskState, void, undefined> {
  yield {
    status: "log",
    level: "warn",
    message: `Unable to update pristine repo for ${repoName}. Using the last cached snapshot.`,
  };
  yield {
    status: "log",
    level: "warn",
    message: String(error),
  };
}
