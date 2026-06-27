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

async function hasBrokenWorktreeLink(worktreePath: string): Promise<boolean> {
  const gitPath = path.join(worktreePath, ".git");
  if (!(await pathExists(gitPath))) {
    return true;
  }

  let contents: string;
  try {
    contents = await fs.readFile(gitPath, "utf8");
  } catch {
    return false;
  }

  const gitDirPrefix = "gitdir:";
  if (!contents.startsWith(gitDirPrefix)) {
    return false;
  }

  const gitDir = contents.slice(gitDirPrefix.length).trim();
  if (!gitDir) {
    return true;
  }

  const resolvedGitDir = path.isAbsolute(gitDir)
    ? gitDir
    : path.resolve(worktreePath, gitDir);

  return !(await pathExists(resolvedGitDir));
}

function isStaleWorktreeRemoveError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return (
    message.includes("is not a working tree") ||
    (message.includes("cannot remove working tree") &&
      message.includes(".git") &&
      message.includes("does not exist"))
  );
}

async function* pruneWorktreeMetadataGenerator(
  mirrorDir: string,
  worktreePath: string,
): AsyncGenerator<TaskState, void, undefined> {
  yield {
    status: "log",
    level: "warn",
    message: `Stale worktree metadata for ${worktreePath}; pruning mirror metadata instead`,
  };

  await runGit(["worktree", "prune"], { cwd: mirrorDir });
}

/** Ensures a mirror repository exists and yields progress states. */
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
  await runGit(["worktree", "prune"], { cwd: mirrorDir });
}

/**
 * Detect the actual default branch of a bare mirror repo by reading its HEAD symref.
 *
 * After fixBareRepoRefsGenerator moves refs/heads/* to refs/remotes/origin/*,
 * HEAD still preserves the original default branch name. We verify the
 * corresponding remote ref exists before trusting it, falling back to the
 * configured value if anything goes wrong.
 */
async function detectDefaultBranch(
  mirrorDir: string,
  fallback: string,
): Promise<string> {
  try {
    const { stdout } = await runGit(["symbolic-ref", "HEAD"], {
      cwd: mirrorDir,
    });
    const branch = stdout.trim().replace("refs/heads/", "");

    const { stdout: refOutput } = await runGit(
      ["for-each-ref", `refs/remotes/origin/${branch}`],
      { cwd: mirrorDir },
    );

    if (refOutput.trim()) {
      return branch;
    }
  } catch {
    // Fall through to return fallback
  }
  return fallback;
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

  // The configured defaultBranch defaults to "main" for org/repo slugs, but
  // many repos use a different trunk (e.g. "canary", "master", "develop").
  // Read the actual default branch from the mirror's HEAD symref, which is
  // set by git during clone and remains accurate even after fixBareRepoRefsGenerator
  // moves the local branch refs to refs/remotes/origin/*.
  const defaultBranch = await detectDefaultBranch(
    mirrorDir,
    repo.defaultBranch,
  );

  yield {
    status: "log",
    level: "info",
    message: `Creating worktree for ${repo.name} on branch "${branchName}" from origin/${defaultBranch}`,
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
        `origin/${defaultBranch}`,
      ],
      { cwd: mirrorDir },
    ),
  );

  yield* withRetryGenerator(worktreeGen, {
    attempts: 3,
    label: `worktree:${repo.name}`,
  });
}

async function branchExists(
  mirrorDir: string,
  branchName: string,
): Promise<boolean> {
  try {
    await runGit(
      ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
      {
        cwd: mirrorDir,
      },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a new worktree and branch, failing instead of reusing existing state.
 */
export async function* createWorkingCopyGenerator(
  repo: RepoConfig,
  mirrorDir: string,
  targetDir: string,
  branchName: string,
): AsyncGenerator<TaskState, void, undefined> {
  if (await pathExists(targetDir)) {
    throw new Error(`Target directory already exists: ${targetDir}`);
  }

  if (await branchExists(mirrorDir, branchName)) {
    throw new Error(`Branch already exists: ${branchName}`);
  }

  const defaultBranch = await detectDefaultBranch(
    mirrorDir,
    repo.defaultBranch,
  );

  yield {
    status: "log",
    level: "info",
    message: `Creating worktree for ${repo.name} on branch "${branchName}" from origin/${defaultBranch}`,
  };

  await runGit(
    ["worktree", "add", "-b", branchName, targetDir, `origin/${defaultBranch}`],
    { cwd: mirrorDir },
  );
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
  const worktrees = await listWorktrees(mirrorDir);

  const targets = worktrees.filter((worktree) => {
    const normalizedWorktree = path.resolve(worktree.path);
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

  for (const target of targets) {
    if (target.prunable || (await hasBrokenWorktreeLink(target.path))) {
      yield* pruneWorktreeMetadataGenerator(mirrorDir, target.path);
      continue;
    }

    const removeGen = asGenerator(() =>
      runGit(["worktree", "remove", "--force", target.path], {
        cwd: mirrorDir,
      }),
    );

    try {
      yield* withRetryGenerator(removeGen, {
        attempts: 3,
        label: `worktree-remove:${path.basename(target.path)}`,
      });
    } catch (error) {
      if (isStaleWorktreeRemoveError(error)) {
        yield* pruneWorktreeMetadataGenerator(mirrorDir, target.path);
        continue;
      }

      throw error;
    }
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
  // Explicit refspec/refmap: ignore stale remote.origin.fetch settings that may
  // point remote branches at refs/heads/* in older bare caches.
  const fetchGen = asGenerator(() =>
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
    yield* withRetryGenerator(fetchGen, {
      attempts: 3,
      label: `update-pristine:${repo.name}`,
    });
  } catch (error_) {
    if (
      yield* repairCaseConflictingRemoteRefGenerator(
        mirrorDir,
        repo.name,
        error_,
      )
    ) {
      try {
        yield* withRetryGenerator(fetchGen, {
          attempts: 3,
          label: `update-pristine:${repo.name}`,
        });
        return;
      } catch (retryError) {
        yield* warnPristineUpdateFailedGenerator(repo.name, retryError);
        return;
      }
    }

    yield* warnPristineUpdateFailedGenerator(repo.name, error_);
  }
}

function getCannotLockRef(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/cannot lock ref '([^']+)'/);
  return match?.[1] ?? null;
}

async function* repairCaseConflictingRemoteRefGenerator(
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

async function* warnPristineUpdateFailedGenerator(
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
        // Ask Git for porcelain worktree data so path parsing stays stable.
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
        // If Git cannot list worktrees for a corrupted repo, skip this mirror.
      }
    }
  }

  return mirrors;
}
