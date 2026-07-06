import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "@wf-plugin/core";
import { getCacheDir } from "../config.ts";
import {
  cloneRepository,
  fixBareRepoRefs,
  forwardSubtask,
  runGit,
  streamGit,
} from "../services/git.ts";
import {
  hasBrokenWorktreeLink,
  removeWorktree,
  withGitWorktreeLock,
} from "../services/worktree.ts";
import type { RepositorySource } from "../types.ts";
import { comparablePath, resolveContainedPath } from "../utils/path-safety.ts";
import { withRetry } from "../utils/retry.ts";
import type { TaskState } from "../utils/task-generator.ts";
import {
  GIT_CLONE_INACTIVITY_TIMEOUT_MS,
  GIT_CLONE_TIMEOUT_MS,
  GIT_FETCH_INACTIVITY_TIMEOUT_MS,
  GIT_FETCH_TIMEOUT_MS,
} from "./setup-limits.ts";

type WorktreeEntry = {
  path: string;
  prunable: boolean;
};

export type CleanupWorkspaceWorktreesOptions = {
  targetPaths?: readonly string[];
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
        {
          timeoutMs: GIT_CLONE_TIMEOUT_MS,
          inactivityTimeoutMs: GIT_CLONE_INACTIVITY_TIMEOUT_MS,
        },
      );

    yield* withRetry(cloneGen, {
      attempts: 3,
      label: `clone-pristine:${repo.name}`,
      // A failed attempt can leave a partial clone that would make the next
      // attempt fail on "destination path already exists".
      onRetry: () => removePartialMirror(mirrorDir),
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
  options: CleanupWorkspaceWorktreesOptions = {},
): AsyncGenerator<TaskState, void, undefined> {
  if (options.targetPaths?.length) {
    const result = yield* cleanupTargetedWorkspaceWorktrees(
      mirrorDir,
      workspaceDir,
      options.targetPaths,
    );
    if (result === "cleaned") {
      return;
    }
  }

  yield* cleanupScannedWorkspaceWorktrees(mirrorDir, workspaceDir);
}

async function* cleanupTargetedWorkspaceWorktrees(
  mirrorDir: string,
  workspaceDir: string,
  targetPaths: readonly string[],
): AsyncGenerator<TaskState, "cleaned" | "fallback", undefined> {
  const targets = await normalizeDirectCleanupTargets(
    workspaceDir,
    targetPaths,
  );
  if (targets.length === 0) {
    return "fallback";
  }

  for (const target of targets) {
    if (!(await pathExists(target)) || (await hasBrokenWorktreeLink(target))) {
      return "fallback";
    }
  }

  yield {
    status: "log",
    level: "info",
    message: `Cleaning up ${targets.length} existing worktree(s) under ${workspaceDir}`,
  };

  for (const target of targets) {
    const result = yield* removeWorktree({
      gitDir: mirrorDir,
      worktreePath: target,
      force: true,
    });
    if (result.status === "stale") {
      return "fallback";
    }
  }

  return "cleaned";
}

async function normalizeDirectCleanupTargets(
  workspaceDir: string,
  targetPaths: readonly string[],
): Promise<string[]> {
  const normalizedWorkspaceDir = await comparablePath(workspaceDir);
  const targets: string[] = [];
  const seen = new Set<string>();

  for (const targetPath of targetPaths) {
    const resolvedTarget = path.resolve(targetPath);
    const normalizedTarget = await comparablePath(resolvedTarget);
    if (
      normalizedTarget !== normalizedWorkspaceDir &&
      !normalizedTarget.startsWith(`${normalizedWorkspaceDir}${path.sep}`)
    ) {
      return [];
    }
    if (seen.has(normalizedTarget)) {
      continue;
    }
    seen.add(normalizedTarget);
    targets.push(resolvedTarget);
  }

  return targets;
}

async function* cleanupScannedWorkspaceWorktrees(
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
    if (target.prunable) {
      yield* pruneWorktreeMetadataWithLock(mirrorDir, target.path);
      continue;
    }

    yield* removeWorktree({
      gitDir: mirrorDir,
      worktreePath: target.path,
      force: true,
    });
  }
}

async function* pruneWorktreeMetadataWithLock(
  gitDir: string,
  worktreePath: string,
): AsyncGenerator<TaskState, void, undefined> {
  yield {
    status: "log",
    level: "warn",
    message: `Stale worktree metadata for ${worktreePath}; pruning mirror metadata instead`,
  };

  await withGitWorktreeLock(gitDir, () =>
    runGit(["worktree", "prune"], { cwd: gitDir }),
  );
}

/**
 * Delete a partially created mirror between clone attempts. Guarded to the
 * cache directory so a bad path can never escape it.
 */
async function removePartialMirror(mirrorDir: string): Promise<void> {
  const cacheDir = getCacheDir();
  const contained = resolveContainedPath(
    cacheDir,
    path.relative(cacheDir, mirrorDir),
  );
  await fs.rm(contained, { recursive: true, force: true });
}

/**
 * Fetches the latest branches into the pristine bare mirror (with retry and
 * case-conflict repair), streaming progress as it runs. A persistent fetch
 * failure downgrades to a warning: the cached snapshot still works.
 */
async function* updatePristineRepo(
  repo: RepositorySource,
  mirrorDir: string,
): AsyncGenerator<TaskState, void, undefined> {
  // --no-tags: Skip fetching tags (faster, we only need branches)
  // --prune: Remove stale remote-tracking refs
  // Explicit refspec/refmap: ignore stale remote.origin.fetch settings that may
  // point remote branches at refs/heads/* in older bare caches.
  const fetchGen = () =>
    streamGit(
      [
        "fetch",
        "--progress",
        "--prune",
        "--no-tags",
        "--refmap=",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
      ],
      {
        cwd: mirrorDir,
        timeoutMs: GIT_FETCH_TIMEOUT_MS,
        inactivityTimeoutMs: GIT_FETCH_INACTIVITY_TIMEOUT_MS,
      },
    );
  const attemptFetch = () =>
    forwardSubtask(
      withRetry(fetchGen, {
        attempts: 3,
        label: `update-pristine:${repo.name}`,
      }),
    );

  let failure: Error | null;
  try {
    failure = yield* attemptFetch();
  } catch (error_) {
    failure = error_ instanceof Error ? error_ : new Error(String(error_));
  }
  if (!failure) return;

  if (yield* repairCaseConflictingRemoteRef(mirrorDir, repo.name, failure)) {
    let retryFailure: Error | null;
    try {
      retryFailure = yield* attemptFetch();
    } catch (retryError) {
      retryFailure =
        retryError instanceof Error
          ? retryError
          : new Error(String(retryError));
    }
    if (!retryFailure) return;
    yield* warnPristineUpdateFailed(repo.name, retryFailure);
    return;
  }

  yield* warnPristineUpdateFailed(repo.name, failure);
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
