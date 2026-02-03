import { promises as fs } from "node:fs";
import path from "node:path";
import {
  cloneRepositoryGenerator,
  fixBareRepoRefsGenerator,
  runGit,
} from "../services/git.ts";
import type { RepoConfig } from "../types.ts";
import { pathExists } from "../utils/fs.ts";
import { asGenerator, withRetryGenerator } from "../utils/retry.ts";
import type { TaskState } from "../utils/task-generator.ts";

/**
 * Generator version of ensureMirrorRepo that yields log messages.
 */
export async function* ensureMirrorRepoGenerator(
  repo: RepoConfig,
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
      cloneRepositoryGenerator(
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

    yield* withRetryGenerator(cloneGen, {
      attempts: 3,
      label: `clone-pristine:${repo.name}`,
    });

    // Fix refs: move from refs/heads/* to refs/remotes/origin/*
    // This is needed because git clone --bare creates local branches
    yield* fixBareRepoRefsGenerator(mirrorDir);
  } else {
    yield* updatePristineRepoGenerator(repo, mirrorDir);
  }

  // Prune stale worktree entries only if needed
  yield* pruneStaleWorktreesIfNeededGenerator(mirrorDir);
}

/**
 * Prune stale worktree entries only if there are any pointing to non-existent paths.
 * This avoids the overhead of running `git worktree prune` when it's not needed.
 */
async function* pruneStaleWorktreesIfNeededGenerator(
  mirrorDir: string,
): AsyncGenerator<TaskState, void, undefined> {
  // Get list of worktrees
  const { stdout } = await runGit(["worktree", "list", "--porcelain"], {
    cwd: mirrorDir,
  });

  const worktreePaths = stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.substring("worktree ".length).trim())
    .filter(Boolean);

  // Check if any worktree paths don't exist (stale entries)
  let hasStale = false;
  for (const worktreePath of worktreePaths) {
    if (!(await pathExists(worktreePath))) {
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
  await runGit(["worktree", "prune"], { cwd: mirrorDir });
}

/**
 * @deprecated Use ensureMirrorRepoGenerator for generator-based workflows.
 */
export async function ensureMirrorRepo(
  repo: RepoConfig,
  mirrorDir: string,
): Promise<void> {
  const gen = ensureMirrorRepoGenerator(repo, mirrorDir);
  // Consume the generator, discarding states
  let result = await gen.next();
  while (!result.done) {
    result = await gen.next();
  }
}

/**
 * Generator version of ensureWorkingCopy that yields log messages.
 */
export async function* ensureWorkingCopyGenerator(
  repo: RepoConfig,
  mirrorDir: string,
  targetDir: string,
  branchName: string,
): AsyncGenerator<TaskState, void, undefined> {
  const workingCopyExists = await pathExists(targetDir);

  if (workingCopyExists) {
    yield {
      status: "log",
      level: "info",
      message: `Reusing existing checkout for ${repo.name}`,
    };
    return;
  }

  yield {
    status: "log",
    level: "info",
    message: `Creating worktree for ${repo.name} on branch "${branchName}" from origin/${repo.defaultBranch}`,
  };

  // Wrap the git command in a generator for withRetryGenerator
  const worktreeGen = asGenerator(() =>
    runGit(
      [
        "worktree",
        "add",
        "-B",
        branchName,
        targetDir,
        `origin/${repo.defaultBranch}`,
      ],
      { cwd: mirrorDir },
    ),
  );

  yield* withRetryGenerator(worktreeGen, {
    attempts: 3,
    label: `worktree:${repo.name}`,
  });
}

/**
 * @deprecated Use ensureWorkingCopyGenerator for generator-based workflows.
 */
export async function ensureWorkingCopy(
  repo: RepoConfig,
  mirrorDir: string,
  targetDir: string,
  branchName: string,
): Promise<void> {
  const gen = ensureWorkingCopyGenerator(
    repo,
    mirrorDir,
    targetDir,
    branchName,
  );
  let result = await gen.next();
  while (!result.done) {
    result = await gen.next();
  }
}

/**
 * Generator version of cleanupWorkspaceWorktrees that yields log messages.
 */
export async function* cleanupWorkspaceWorktreesGenerator(
  mirrorDir: string,
  workspaceDir: string,
): AsyncGenerator<TaskState, void, undefined> {
  const normalizedWorkspaceDir = path.resolve(workspaceDir);
  const { stdout } = await runGit(["worktree", "list", "--porcelain"], {
    cwd: mirrorDir,
  });

  const worktreePaths = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.substring("worktree ".length).trim())
    .filter(Boolean);

  const targets = worktreePaths.filter((worktreePath) => {
    const normalizedWorktree = path.resolve(worktreePath);
    return (
      normalizedWorktree === normalizedWorkspaceDir ||
      normalizedWorktree.startsWith(`${normalizedWorkspaceDir}${path.sep}`)
    );
  });

  if (targets.length === 0) {
    return;
  }

  yield {
    status: "log",
    level: "info",
    message: `Cleaning up ${targets.length} existing worktree(s) under ${workspaceDir}`,
  };

  for (const worktreePath of targets) {
    const removeGen = asGenerator(() =>
      runGit(["worktree", "remove", "--force", worktreePath], {
        cwd: mirrorDir,
      }),
    );

    yield* withRetryGenerator(removeGen, {
      attempts: 3,
      label: `worktree-remove:${path.basename(worktreePath)}`,
    });
  }
}

/**
 * @deprecated Use cleanupWorkspaceWorktreesGenerator for generator-based workflows.
 */
export async function cleanupWorkspaceWorktrees(
  mirrorDir: string,
  workspaceDir: string,
): Promise<void> {
  const gen = cleanupWorkspaceWorktreesGenerator(mirrorDir, workspaceDir);
  let result = await gen.next();
  while (!result.done) {
    result = await gen.next();
  }
}

/**
 * Generator version of updatePristineRepo that yields log messages.
 */
async function* updatePristineRepoGenerator(
  repo: RepoConfig,
  mirrorDir: string,
): AsyncGenerator<TaskState, void, undefined> {
  // --no-tags: Skip fetching tags (faster, we only need branches)
  // --prune: Remove stale remote-tracking refs
  const fetchGen = asGenerator(() =>
    runGit(["fetch", "origin", "--prune", "--no-tags"], { cwd: mirrorDir }),
  );

  try {
    yield* withRetryGenerator(fetchGen, {
      attempts: 3,
      label: `update-pristine:${repo.name}`,
    });
  } catch (error_) {
    yield {
      status: "log",
      level: "warn",
      message: `Unable to update pristine repo for ${repo.name}. Using the last cached snapshot.`,
    };
    yield {
      status: "log",
      level: "warn",
      message: String(error_),
    };
  }
}

export type MirrorWithWorktrees = {
  mirrorPath: string;
  worktrees: string[];
};

/**
 * List all mirror repositories in the cache directory with their associated worktrees.
 * This is useful for identifying orphaned mirrors (mirrors with no worktrees) for cleanup.
 */
export async function listMirrorsWithWorktrees(
  cacheDir: string,
): Promise<MirrorWithWorktrees[]> {
  const cacheDirExists = await pathExists(cacheDir);
  if (!cacheDirExists) {
    return [];
  }

  const entries = await fs.readdir(cacheDir, { withFileTypes: true });
  const mirrors: MirrorWithWorktrees[] = [];

  for (const entry of entries) {
    // Look for directories ending with .git (bare git mirrors)
    if (entry.isDirectory() && entry.name.endsWith(".git")) {
      const mirrorPath = path.join(cacheDir, entry.name);

      try {
        // Get worktree list using --porcelain format for easier parsing
        const { stdout } = await runGit(["worktree", "list", "--porcelain"], {
          cwd: mirrorPath,
        });

        // Parse worktree paths from porcelain output
        // Format: "worktree /path/to/worktree"
        const worktrees = stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("worktree "))
          .map((line) => line.substring("worktree ".length).trim())
          .filter(Boolean);

        mirrors.push({ mirrorPath, worktrees });
      } catch {
        // If git worktree list fails (e.g., corrupted repo), skip this mirror
      }
    }
  }

  return mirrors;
}
