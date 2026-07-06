import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathExists } from "@wf-plugin/core";
import { asTask, withRetry } from "../utils/retry.ts";
import type { TaskState } from "../utils/task-generator.ts";
import { runGit } from "./git.ts";

// ============================================================================
// Shared git-worktree primitives
//
// Every worktree-creating path in the app (workspace create/add, tasks, review,
// AGENTS.md extraction) mutates the same per-repo bare mirror. Historically each
// hand-rolled its own `git worktree add`/`remove`/`prune` argv, default-branch
// resolution, and (mostly absent) serialization, which produced divergent and
// occasionally destructive behavior. These primitives are the single place those
// operations live so every caller inherits the same guards.
// ============================================================================

const GIT_WORKTREE_LOCK_FILENAME = "workforest-worktree.lock";
const LOCK_RETRY_MS = 50;
// How long a caller waits to acquire the lock. Must comfortably exceed a normal
// `git worktree add` (which may fetch blobs from a blobless mirror) so a waiter
// does not give up while the holder is legitimately working.
const LOCK_WAIT_TIMEOUT_MS = 120_000;
// A lock older than this with no refresh is assumed abandoned (holder crashed).
const LOCK_STALE_MS = 30_000;
// A live holder rewrites the lock mtime on this cadence so it is never mistaken
// for stale mid-operation.
const LOCK_REFRESH_MS = 10_000;

const DEFAULT_WORKTREE_TIMEOUT_MS = 120_000;
const DEFAULT_RETRY_ATTEMPTS = 3;

// ----------------------------------------------------------------------------
// Serialization lock
// ----------------------------------------------------------------------------

/**
 * Resolve the git common directory shared by every linked worktree of a repo.
 * All worktrees of one repo contend on the same index.lock / packed-refs, so the
 * lock file lives here and serializes them regardless of which checkout the
 * caller is operating from.
 */
async function resolveGitCommonDir(gitDir: string): Promise<string> {
  try {
    const { stdout } = await runGit(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: gitDir },
    );
    return stdout.trim() || path.join(gitDir, ".git");
  } catch {
    return path.join(gitDir, ".git");
  }
}

/** Reclaim a lock whose mtime is older than the stale threshold. */
async function removeStaleGitWorktreeLock(lockPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) {
      return false;
    }
    await fs.rm(lockPath, { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

type LockRelease = () => Promise<void>;

async function acquireGitWorktreeLock(gitDir: string): Promise<LockRelease> {
  const gitCommonDir = await resolveGitCommonDir(gitDir);
  const lockPath = path.join(gitCommonDir, GIT_WORKTREE_LOCK_FILENAME);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  // A unique token identifies this holder. Release only deletes the lock file
  // when it still contains our token, so a stale reclaim that replaced us never
  // has its lock deleted out from under it.
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;

  while (!handle) {
    try {
      handle = await fs.open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (await removeStaleGitWorktreeLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for git worktree lock at ${lockPath}`,
        );
      }
      await delay(LOCK_RETRY_MS);
    }
  }

  const lockHandle = handle;
  await lockHandle.writeFile(token);

  const refresh = setInterval(() => {
    void (async () => {
      try {
        const current = await fs.readFile(lockPath, "utf8");
        if (current === token) {
          const now = new Date();
          await fs.utimes(lockPath, now, now);
        }
      } catch {
        // Best effort; a missing lock means we were reclaimed and release()
        // will notice the token no longer matches.
      }
    })();
  }, LOCK_REFRESH_MS);
  refresh.unref?.();

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    clearInterval(refresh);
    await lockHandle.close();
    try {
      const current = await fs.readFile(lockPath, "utf8");
      if (current === token) {
        await fs.rm(lockPath, { force: true });
      }
    } catch {
      // Already gone.
    }
  };
}

/**
 * Run `operation` while holding the repo's worktree lock. Serializes concurrent
 * worktree mutations against the same mirror (across processes), preventing the
 * `index.lock` / `cannot lock ref` races that arise when several commands touch
 * one repo's linked worktrees at once.
 */
export async function withGitWorktreeLock<T>(
  gitDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquireGitWorktreeLock(gitDir);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function* withOptionalGitWorktreeLock<T>(
  gitDir: string,
  shouldLock: boolean,
  body: () => AsyncGenerator<TaskState, T, undefined>,
): AsyncGenerator<TaskState, T, undefined> {
  if (!shouldLock) {
    return yield* body();
  }
  const release = await acquireGitWorktreeLock(gitDir);
  try {
    return yield* body();
  } finally {
    await release();
  }
}

// ----------------------------------------------------------------------------
// Default-branch resolution
// ----------------------------------------------------------------------------

type DefaultBranchInfo = {
  branch: string;
  usedFallback: boolean;
  reason?: "head-unreadable" | "no-remote-ref";
};

/**
 * Determine a mirror's default branch by reading its HEAD symref (preserved by
 * `fixBareRepoRefs`) and verifying the matching remote-tracking ref
 * exists. Falls back to the configured value, reporting *why* so callers can
 * warn instead of silently branching from the wrong base.
 */
async function resolveDefaultBranchInfo(
  gitDir: string,
  fallback: string,
): Promise<DefaultBranchInfo> {
  let branch: string;
  try {
    const { stdout } = await runGit(["symbolic-ref", "HEAD"], { cwd: gitDir });
    branch = stdout.trim().replace("refs/heads/", "");
    if (!branch) {
      return {
        branch: fallback,
        usedFallback: true,
        reason: "head-unreadable",
      };
    }
  } catch {
    return { branch: fallback, usedFallback: true, reason: "head-unreadable" };
  }

  try {
    const { stdout } = await runGit(
      ["for-each-ref", `refs/remotes/origin/${branch}`],
      { cwd: gitDir },
    );
    if (stdout.trim()) {
      return { branch, usedFallback: false };
    }
  } catch {
    return { branch: fallback, usedFallback: true, reason: "head-unreadable" };
  }

  return { branch: fallback, usedFallback: true, reason: "no-remote-ref" };
}

export async function detectDefaultBranch(
  gitDir: string,
  fallback: string,
): Promise<string> {
  return (await resolveDefaultBranchInfo(gitDir, fallback)).branch;
}

// ----------------------------------------------------------------------------
// Small git helpers (shared by every worktree path)
// ----------------------------------------------------------------------------

export async function branchExists(
  gitDir: string,
  branch: string,
): Promise<boolean> {
  try {
    await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: gitDir,
    });
    return true;
  } catch {
    return false;
  }
}

export async function isGitDirty(dir: string): Promise<boolean> {
  const { stdout } = await runGit(["status", "--porcelain"], { cwd: dir });
  return stdout.trim().length > 0;
}

export async function deleteBranchIfPossible(
  dir: string,
  branch: string,
  force: boolean,
): Promise<void> {
  try {
    await runGit(["branch", force ? "-D" : "-d", branch], { cwd: dir });
  } catch {
    // The branch may already be gone, or a stale unmerged branch may be kept.
  }
}

export async function getCurrentBranch(
  dir: string,
): Promise<string | undefined> {
  const { stdout } = await runGit(["branch", "--show-current"], { cwd: dir });
  return stdout.trim() || undefined;
}

export async function requireCurrentBranch(dir: string): Promise<string> {
  const branch = await getCurrentBranch(dir);
  if (!branch) {
    throw new Error(
      `Repository at ${dir} is on a detached HEAD. Check out a branch first.`,
    );
  }
  return branch;
}

/** True when `ref` contains no commits beyond `ancestorOf` (safe to reset). */
async function isAncestorOf(
  gitDir: string,
  ref: string,
  ancestorOf: string,
): Promise<boolean> {
  try {
    await runGit(["merge-base", "--is-ancestor", ref, ancestorOf], {
      cwd: gitDir,
    });
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------
// Worktree removal / prune internals
// ----------------------------------------------------------------------------

/**
 * A worktree whose `.git` gitlink is missing or points at a directory that no
 * longer exists. Removing such an entry with `git worktree remove` fails; it
 * must be pruned from the mirror's metadata instead.
 */
export async function hasBrokenWorktreeLink(
  worktreePath: string,
): Promise<boolean> {
  const gitPath = path.join(worktreePath, ".git");
  if (!(await pathExists(gitPath))) {
    return true;
  }

  let contents: string;
  try {
    contents = await fs.readFile(gitPath, "utf8");
  } catch {
    // An unreadable gitlink cannot be trusted; treat it as broken so cleanup
    // prunes metadata rather than attempting a doomed `worktree remove`.
    return true;
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

export function isStaleWorktreeRemoveError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return (
    message.includes("is not a working tree") ||
    (message.includes("cannot remove working tree") &&
      message.includes(".git") &&
      message.includes("does not exist"))
  );
}

export async function* pruneWorktreeMetadata(
  gitDir: string,
  worktreePath: string,
): AsyncGenerator<TaskState, void, undefined> {
  yield {
    status: "log",
    level: "warn",
    message: `Stale worktree metadata for ${worktreePath}; pruning mirror metadata instead`,
  };

  await runGit(["worktree", "prune"], { cwd: gitDir });
}

// ----------------------------------------------------------------------------
// Public creation / removal / prune primitives
// ----------------------------------------------------------------------------

/** Start-point (commit-ish) the new worktree is created at. */
export type WorktreeBase =
  | { ref: string }
  | { defaultBranchOf: string; fallback: string };

/** How the new worktree relates to a branch. */
export type WorktreeBranch =
  | { kind: "create"; name: string } // `-b`: error if the branch already exists
  | { kind: "reset"; name: string } // `-B`: reset, but only if fast-forwardable
  | { kind: "detach" }; // `--detach`: no branch

export type AddWorktreeOptions = {
  /** Directory the git command runs in — the mirror, or a parent worktree. */
  gitDir: string;
  targetDir: string;
  base: WorktreeBase;
  branch: WorktreeBranch;
  /** What to do when `targetDir` already exists. Defaults to "error". */
  onExistingDir?: "reuse" | "error";
  retryAttempts?: number;
  timeoutMs?: number;
  /** Serialize on the repo's worktree lock. Defaults to true. */
  lock?: boolean;
  label?: string;
};

async function resolveBaseRef(
  base: WorktreeBase,
): Promise<{ ref: string; warning?: string }> {
  if ("ref" in base) {
    return { ref: base.ref };
  }
  const info = await resolveDefaultBranchInfo(
    base.defaultBranchOf,
    base.fallback,
  );
  const ref = `origin/${info.branch}`;
  if (info.usedFallback) {
    const why =
      info.reason === "head-unreadable"
        ? "could not read the mirror's HEAD"
        : "the detected default branch has no remote-tracking ref";
    return {
      ref,
      warning: `Falling back to default branch "${info.branch}" (${why})`,
    };
  }
  return { ref };
}

async function buildAddArgs(
  gitDir: string,
  targetDir: string,
  baseRef: string,
  branch: WorktreeBranch,
): Promise<string[]> {
  if (branch.kind === "detach") {
    return ["worktree", "add", "--detach", targetDir, baseRef];
  }
  if (branch.kind === "create") {
    if (await branchExists(gitDir, branch.name)) {
      throw new Error(`Branch already exists: ${branch.name}`);
    }
    return ["worktree", "add", "-b", branch.name, targetDir, baseRef];
  }
  // reset: `-B` force-resets the branch to baseRef. Refuse when that would
  // discard commits — bare mirrors have no reflog, so the loss is unrecoverable.
  if (
    (await branchExists(gitDir, branch.name)) &&
    !(await isAncestorOf(gitDir, branch.name, baseRef))
  ) {
    throw new Error(
      `Refusing to reset branch "${branch.name}": it has commits not present on ${baseRef}. ` +
        `Delete it or use a different name.`,
    );
  }
  return ["worktree", "add", "-B", branch.name, targetDir, baseRef];
}

/**
 * Create a worktree. The single creation primitive behind every managed path:
 * resolves the base ref, applies the branch mode (with the reset-safety guard),
 * runs under the worktree lock with retries and a timeout.
 */
export async function* addWorktree(
  opts: AddWorktreeOptions,
): AsyncGenerator<TaskState, void, undefined> {
  const {
    gitDir,
    targetDir,
    base,
    branch,
    onExistingDir = "error",
    retryAttempts = DEFAULT_RETRY_ATTEMPTS,
    timeoutMs = DEFAULT_WORKTREE_TIMEOUT_MS,
    lock = true,
    label,
  } = opts;

  const handleExistingDir = function* (): Generator<TaskState, boolean> {
    if (onExistingDir === "reuse") {
      yield {
        status: "log",
        level: "info",
        message: `Reusing existing checkout at ${targetDir}`,
      };
      return true;
    }
    throw new Error(`Target directory already exists: ${targetDir}`);
  };

  if (await pathExists(targetDir)) {
    if (yield* handleExistingDir()) return;
  }

  yield* withOptionalGitWorktreeLock(gitDir, lock, async function* () {
    // Re-check inside the lock: another holder may have created it meanwhile.
    if (await pathExists(targetDir)) {
      if (yield* handleExistingDir()) return;
    }

    const { ref: baseRef, warning } = await resolveBaseRef(base);
    if (warning) {
      yield { status: "log", level: "warn", message: warning };
    }

    const args = await buildAddArgs(gitDir, targetDir, baseRef, branch);

    yield {
      status: "log",
      level: "info",
      message:
        branch.kind === "detach"
          ? `Creating detached worktree at ${targetDir} from ${baseRef}`
          : `Creating worktree at ${targetDir} on branch "${branch.name}" from ${baseRef}`,
    };

    const addGen = asTask(() =>
      runGit(args, { cwd: gitDir, timeout: timeoutMs }),
    );
    yield* withRetry(addGen, {
      attempts: retryAttempts,
      label: label ?? `worktree:${path.basename(targetDir)}`,
    });
  });
}

export type RemoveWorktreeOptions = {
  gitDir: string;
  worktreePath: string;
  force?: boolean;
  retryAttempts?: number;
  timeoutMs?: number;
  lock?: boolean;
};

export type RemoveWorktreeResult = {
  status: "removed" | "stale";
};

/**
 * Remove a worktree with the hardened discipline previously unique to workspace
 * cleanup: prune metadata for a broken gitlink, retry transient failures, and
 * fall back to `git worktree prune` on a stale-removal error.
 */
export async function* removeWorktree(
  opts: RemoveWorktreeOptions,
): AsyncGenerator<TaskState, RemoveWorktreeResult, undefined> {
  const {
    gitDir,
    worktreePath,
    force = false,
    retryAttempts = DEFAULT_RETRY_ATTEMPTS,
    timeoutMs = DEFAULT_WORKTREE_TIMEOUT_MS,
    lock = true,
  } = opts;

  return yield* withOptionalGitWorktreeLock(gitDir, lock, async function* () {
    if (await hasBrokenWorktreeLink(worktreePath)) {
      yield* pruneWorktreeMetadata(gitDir, worktreePath);
      return { status: "stale" };
    }

    const args = force
      ? ["worktree", "remove", "--force", worktreePath]
      : ["worktree", "remove", worktreePath];
    const removeGen = asTask(() =>
      runGit(args, { cwd: gitDir, timeout: timeoutMs }),
    );

    try {
      yield* withRetry(removeGen, {
        attempts: retryAttempts,
        label: `worktree-remove:${path.basename(worktreePath)}`,
      });
    } catch (error) {
      if (isStaleWorktreeRemoveError(error)) {
        yield* pruneWorktreeMetadata(gitDir, worktreePath);
        return { status: "stale" };
      }
      throw error;
    }

    return { status: "removed" };
  });
}

/** Prune stale worktree metadata from a mirror, under the worktree lock. */
export async function* pruneWorktrees(
  gitDir: string,
  { lock = true }: { lock?: boolean } = {},
): AsyncGenerator<TaskState, void, undefined> {
  yield {
    status: "log",
    level: "info",
    message: "Pruning stale worktree metadata",
  };
  const prune = () => runGit(["worktree", "prune"], { cwd: gitDir });
  if (lock) {
    await withGitWorktreeLock(gitDir, async () => {
      await prune();
    });
  } else {
    await prune();
  }
}
