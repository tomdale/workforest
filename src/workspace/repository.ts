import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "@wf-plugin/core";
import {
  CANONICAL_CACHE_FETCH_REFSPEC,
  cacheFetchArgs,
  cloneRepository,
  fixBareRepoRefs,
  forwardSubtask,
  getGitHubSlug,
  runGit,
  streamGit,
} from "../services/git.ts";
import {
  detectDefaultBranch,
  hasBrokenWorktreeLink,
  removeWorktree,
  withGitWorktreeLock,
} from "../services/worktree.ts";
import type { RepositorySource } from "../types.ts";
import { comparablePath } from "../utils/path-safety.ts";
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
      message: `Seeding cached mirror for ${repo.name}`,
    };

    yield* seedMirrorRepo(repo, mirrorDir);
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

/**
 * Seed a new cache mirror via `git init --bare` + fetch into a temp directory,
 * falling back to clone (gh, then git) when fetch authentication fails. Publish
 * with rename only after the seeded mirror validates.
 */
async function* seedMirrorRepo(
  repo: RepositorySource,
  mirrorDir: string,
): AsyncGenerator<TaskState, void, undefined> {
  await fs.mkdir(path.dirname(mirrorDir), { recursive: true });

  let tempDir = await createTemporaryMirrorDir(mirrorDir);
  let published = false;

  try {
    try {
      yield* initializeMirrorWithGitFetch(repo, tempDir);
    } catch (error) {
      await removeTemporaryMirrorDir(tempDir);
      if (!shouldFallbackToGitHubClone(repo.remote, error)) {
        throw error;
      }

      yield {
        status: "log",
        level: "info",
        message: `Git fetch could not authenticate ${repo.name}; retrying with clone`,
      };
      tempDir = await createTemporaryMirrorDir(mirrorDir);
      yield* initializeMirrorWithClone(repo, tempDir);
    }

    await validateSeededMirror(repo, tempDir);
    try {
      await fs.rename(tempDir, mirrorDir);
      published = true;
    } catch (error) {
      if (
        !["EEXIST", "ENOTEMPTY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        throw error;
      }

      // Another process completed the same seed while this one was fetching.
      // Reuse its validated publication rather than failing a concurrent setup.
      await validateSeededMirror(repo, mirrorDir);
    }
  } finally {
    if (!published) {
      await removeTemporaryMirrorDir(tempDir);
    }
  }
}

async function createTemporaryMirrorDir(mirrorDir: string): Promise<string> {
  return fs.mkdtemp(
    path.join(path.dirname(mirrorDir), `${path.basename(mirrorDir)}.tmp-`),
  );
}

async function removeTemporaryMirrorDir(tempDir: string): Promise<void> {
  await fs.rm(tempDir, { recursive: true, force: true });
}

async function* initializeMirrorWithGitFetch(
  repo: RepositorySource,
  tempDir: string,
): AsyncGenerator<TaskState, void, undefined> {
  await runGit(["init", "--bare", tempDir]);
  await runGit(["remote", "add", "origin", repo.remote], { cwd: tempDir });
  await runGit(
    [
      "config",
      "--replace-all",
      "remote.origin.fetch",
      CANONICAL_CACHE_FETCH_REFSPEC,
    ],
    { cwd: tempDir },
  );

  const fetchGen = () =>
    streamGit(cacheFetchArgs({ filter: true, progress: true }), {
      cwd: tempDir,
      timeoutMs: GIT_FETCH_TIMEOUT_MS,
      inactivityTimeoutMs: GIT_FETCH_INACTIVITY_TIMEOUT_MS,
    });

  const failure = yield* forwardSubtask(
    withRetry(fetchGen, {
      attempts: 3,
      label: `seed-mirror:${repo.name}`,
    }),
  );
  if (failure) {
    throw failure;
  }

  await setMirrorHeadFromRemote(tempDir);
}

async function* initializeMirrorWithClone(
  repo: RepositorySource,
  tempDir: string,
): AsyncGenerator<TaskState, void, undefined> {
  // cloneRepository prefers gh (SAML SSO) then falls back to git. Keep the
  // origin URL it configured: when gh succeeds after a failed git fetch, the
  // gh-configured URL is the one that authenticated.
  //
  // Remove the empty mkdtemp directory first so clone can create the path.
  // A failed attempt can leave a partial clone that would make the next
  // attempt fail on "destination path already exists".
  await removeTemporaryMirrorDir(tempDir);

  const cloneGen = () =>
    cloneRepository(repo.remote, tempDir, ["--bare", "--filter=blob:none"], {
      timeoutMs: GIT_CLONE_TIMEOUT_MS,
      inactivityTimeoutMs: GIT_CLONE_INACTIVITY_TIMEOUT_MS,
    });

  yield* withRetry(cloneGen, {
    attempts: 3,
    label: `seed-mirror-clone:${repo.name}`,
    onRetry: () => removeTemporaryMirrorDir(tempDir),
  });

  await runGit(
    [
      "config",
      "--replace-all",
      "remote.origin.fetch",
      CANONICAL_CACHE_FETCH_REFSPEC,
    ],
    { cwd: tempDir },
  );
  yield* fixBareRepoRefs(tempDir);
  await setMirrorHeadFromRemote(tempDir);
}

async function setMirrorHeadFromRemote(mirrorDir: string): Promise<void> {
  const remoteDefaultBranch = await readRemoteDefaultBranch(mirrorDir);
  const branch =
    remoteDefaultBranch &&
    (await hasRemoteTrackingRef(mirrorDir, remoteDefaultBranch))
      ? remoteDefaultBranch
      : await detectDefaultBranch(mirrorDir, "main");

  if (await hasRemoteTrackingRef(mirrorDir, branch)) {
    await runGit(["symbolic-ref", "HEAD", `refs/heads/${branch}`], {
      cwd: mirrorDir,
    });
  }
}

async function readRemoteDefaultBranch(
  mirrorDir: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGit(
      ["ls-remote", "--symref", "origin", "HEAD"],
      {
        cwd: mirrorDir,
      },
    );
    for (const line of stdout.split("\n")) {
      const match = line.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/);
      if (match?.[1]) {
        return match[1];
      }
    }
  } catch {
    // Fall through to the configured default branch.
  }
  return null;
}

async function hasRemoteTrackingRef(
  mirrorDir: string,
  branch: string,
): Promise<boolean> {
  try {
    await runGit(
      ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
      { cwd: mirrorDir },
    );
    return true;
  } catch {
    return false;
  }
}

async function validateSeededMirror(
  repo: RepositorySource,
  mirrorDir: string,
): Promise<void> {
  const { stdout: bareOutput } = await runGit(
    ["rev-parse", "--is-bare-repository"],
    {
      cwd: mirrorDir,
    },
  );
  if (bareOutput.trim() !== "true") {
    throw new Error(
      `Seeded cache for ${repo.name} is not a bare Git repository.`,
    );
  }

  const { stdout: fetchOutput } = await runGit(
    ["config", "--get-all", "remote.origin.fetch"],
    { cwd: mirrorDir },
  );
  const fetchRefspecs = fetchOutput.trim().split("\n").filter(Boolean);
  if (
    fetchRefspecs.length !== 1 ||
    fetchRefspecs[0] !== CANONICAL_CACHE_FETCH_REFSPEC
  ) {
    throw new Error(
      `Seeded cache for ${repo.name} has a noncanonical fetch refspec.`,
    );
  }

  const defaultBranch = await detectDefaultBranch(mirrorDir, "main");
  if (!(await hasRemoteTrackingRef(mirrorDir, defaultBranch))) {
    throw new Error(
      `Seeded cache for ${repo.name} is missing origin/${defaultBranch}.`,
    );
  }

  const { stdout: localHeads } = await runGit(
    ["for-each-ref", "--format=%(refname)", "refs/heads/"],
    { cwd: mirrorDir },
  );
  if (localHeads.trim()) {
    throw new Error(
      `Seeded cache for ${repo.name} contains remote state under refs/heads/*.`,
    );
  }
}

function shouldFallbackToGitHubClone(remote: string, error: unknown): boolean {
  if (!getGitHubSlug(remote)) {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error);
  // Include Git's credential-prompt failures: for a private HTTPS remote where
  // gh is authenticated but Git has no credential helper, fetch dies with
  // "could not read Username ... terminal prompts disabled" or "Device not
  // configured" rather than an auth keyword. Treat those as clone-fallback cases.
  return /saml|sso|auth|permission denied|repository not found|access denied|403|could not read from remote repository|could not read (username|password)|terminal prompts disabled|device not configured/i.test(
    message,
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
    message: `Cleaning up ${targets.length} existing worktree${targets.length === 1 ? "" : "s"} under ${workspaceDir}`,
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
    message: `Cleaning up ${targets.length} existing worktree${targets.length === 1 ? "" : "s"} under ${workspaceDir}`,
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
    message: `Pruning stale worktree metadata for ${worktreePath}`,
  };

  await withGitWorktreeLock(gitDir, () =>
    runGit(["worktree", "prune"], { cwd: gitDir }),
  );
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
    streamGit(cacheFetchArgs({ progress: true }), {
      cwd: mirrorDir,
      timeoutMs: GIT_FETCH_TIMEOUT_MS,
      inactivityTimeoutMs: GIT_FETCH_INACTIVITY_TIMEOUT_MS,
    });
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

  yield* warnPristineUpdateFailed(repo.name, failure);
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
