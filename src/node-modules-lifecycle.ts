import { randomUUID } from "node:crypto";
import { type Dirent, promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hasAny, pathExists } from "@wf-plugin/core";
import { getCacheDir, loadWorkspaceConfig } from "./config.ts";
import {
  isEligiblePnpmInstall,
  isPnpmInstallEnabled,
  normalizeNodeModulesCacheConfig,
  type RestoreNodeModulesResult,
  repoIdentity,
  restoreNodeModules,
} from "./node-modules-cache.ts";
import { createDefaultBranchResolver, runGit } from "./services/git.ts";
import { isGitDirty } from "./services/worktree.ts";
import type {
  NodeModulesCacheConfig,
  RepositorySource,
  WorkspaceConfig,
  WorkspaceMetadata,
} from "./types.ts";
import { ensureDir } from "./utils/fs.ts";
import { resolveContainedPath } from "./utils/path-safety.ts";
import {
  listWorktreeMetadata,
  readWorkspaceMetadata,
} from "./workspace/metadata.ts";
import {
  isPathInsideOrEqual,
  resolveWorkforestDirectories,
  TASKS_DIRECTORY_NAME,
  type WorkforestDirectories,
} from "./workspace/paths.ts";

const POOL_DIRNAME = "_node-modules";
const LOCKS_DIRNAME = ".locks";
const PNPM_LOCK_FILES = ["pnpm-lock.yaml", "pnpm-lock.yml"];

/** Source-tree activity grace: donors younger than this are not evictable. */
export const SOURCE_ACTIVITY_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Generated roots skipped when computing source-tree activity. `node_modules`
 * mtime is intentionally excluded (costly + low signal); build outputs are
 * skipped so a cold feature branch with a recent build does not look "hot".
 */
export const GENERATED_SOURCE_ROOTS = new Set([
  "node_modules",
  "target",
  ".next",
  "dist",
  "build",
  "out",
  ".turbo",
  "coverage",
  ".git",
]);

const LOCK_RETRY_MS = 50;
const LOCK_WAIT_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 30_000;
const LOCK_REFRESH_MS = 10_000;

export type LiveNodeModulesInstall = Readonly<{
  /** Absolute checkout path that owns the install. */
  hostPath: string;
  /** Absolute path to `hostPath/node_modules`. */
  nodeModulesPath: string;
  /** Human-readable selector or relative path for progress messages. */
  selector: string;
  /** Newest source-tree mtime under the checkout (generated roots excluded). */
  sourceActivityMs: number;
  /**
   * Ancestry-only integration preference for donor ordering.
   * Lane 1's full proof (GitHub PR) can replace this later via the seam below.
   */
  integrated: boolean;
}>;

export type AcquireNodeModulesResult =
  | Readonly<{ status: "disabled" | "ineligible" | "missing" | "present" }>
  | Readonly<{
      status: "borrowed";
      donor: LiveNodeModulesInstall;
    }>
  | Readonly<{
      status: "restored";
      entry: Extract<RestoreNodeModulesResult, { status: "restored" }>["entry"];
    }>
  | Readonly<{ status: "warning"; warning: string }>;

export type ListLiveInstallsOptions = Readonly<{
  /** Only include checkouts matching this repo identity. */
  identity: string;
  /** Absolute paths that must never be considered donors. */
  excludePaths?: readonly string[];
  /** Override "now" for grace / tests. */
  nowMs?: number;
  /**
   * Injected checkout discovery. Defaults to scanning Workforest directories
   * from the loaded workspace config.
   */
  listCheckouts?: () => Promise<readonly ManagedCheckout[]>;
  /**
   * Integration preference seam. Defaults to ancestry-only
   * (`HEAD` ancestor of `origin/<default>` or on the default branch).
   * Lane 1 can inject full GitHub PR proof here without changing acquire.
   */
  isIntegrated?: (hostPath: string) => Promise<boolean>;
  /** Git dirty check (injectable for tests). */
  isDirty?: (hostPath: string) => Promise<boolean>;
  /** Source activity clock (injectable for tests). */
  readSourceActivityMs?: (hostPath: string) => Promise<number>;
}>;

export type ManagedCheckout = Readonly<{
  hostPath: string;
  selector: string;
  remote: string;
}>;

export type AcquireNodeModulesOptions = Readonly<{
  repo: RepositorySource;
  repoDir: string;
  config?: NodeModulesCacheConfig | undefined;
  disabledInitializers?: boolean | string[];
  /**
   * Paths that must not be borrowed from (active setup target, cwd, etc.).
   * The acquire target is always excluded automatically.
   */
  excludePaths?: readonly string[];
  /** Override cwd protection (defaults to `process.cwd()`). */
  cwd?: string;
  /** Override "now" for grace / tests. */
  nowMs?: number;
  /** Injected live-install listing (tests). */
  listLiveInstalls?: (
    options: ListLiveInstallsOptions,
  ) => Promise<LiveNodeModulesInstall[]>;
  /** Injected pool restore (tests). */
  restoreFromPool?: typeof restoreNodeModules;
  /** Injected rename (tests; e.g. force EXDEV). */
  rename?: (source: string, target: string) => Promise<void>;
  /** Workspace config for checkout discovery; loaded if omitted. */
  workspaceConfig?: WorkspaceConfig;
}>;

/**
 * Acquire `node_modules` for a newly created checkout.
 *
 * Order (agreed-v1): present → borrow evictable live → pool restore → missing.
 * Direct borrow is one rename; on EXDEV/race the candidate is skipped (never
 * copy whole trees). Per-repo-identity lock covers decide + rename only.
 */
export async function acquireNodeModules(
  options: AcquireNodeModulesOptions,
): Promise<AcquireNodeModulesResult> {
  const normalizedConfig = normalizeNodeModulesCacheConfig(options.config);
  if (
    !normalizedConfig.enabled ||
    !isPnpmInstallEnabled(options.disabledInitializers)
  ) {
    return { status: "disabled" };
  }

  const resolvedRepoDir = path.resolve(options.repoDir);
  if (!(await hasAny(resolvedRepoDir, PNPM_LOCK_FILES))) {
    return { status: "ineligible" };
  }

  const targetPath = path.join(resolvedRepoDir, "node_modules");
  if (await pathExists(targetPath)) {
    return { status: "present" };
  }

  const identity = repoIdentity(options.repo);
  const restoreFromPool = options.restoreFromPool ?? restoreNodeModules;
  const rename = options.rename ?? ((from, to) => fs.rename(from, to));
  const listLive = options.listLiveInstalls ?? listLiveNodeModulesInstalls;
  const nowMs = options.nowMs ?? Date.now();
  const cwd = path.resolve(options.cwd ?? process.cwd());

  const excludePaths = uniqueResolvedPaths([
    resolvedRepoDir,
    cwd,
    ...(options.excludePaths ?? []),
  ]);

  return withNodeModulesIdentityLock(identity, async () => {
    // Re-check under the lock: another acquire may have filled the target.
    if (await pathExists(targetPath)) {
      return { status: "present" };
    }

    const donors = await listLive({
      identity,
      excludePaths,
      nowMs,
      ...(options.workspaceConfig
        ? {
            listCheckouts: () =>
              listManagedCheckouts(options.workspaceConfig as WorkspaceConfig),
          }
        : {}),
    });

    for (const donor of donors) {
      if (!(await pathExists(donor.nodeModulesPath))) {
        continue;
      }
      if (await pathExists(targetPath)) {
        return { status: "present" };
      }
      try {
        await rename(donor.nodeModulesPath, targetPath);
        return { status: "borrowed", donor };
      } catch {
        // EXDEV, race (donor disappeared / target created), permission — skip
        // candidate and continue. Never copy whole trees.
        if (await pathExists(targetPath)) {
          return { status: "present" };
        }
      }
    }

    const poolResult = await restoreFromPool({
      repo: options.repo,
      repoDir: resolvedRepoDir,
      config: options.config,
      ...(options.disabledInitializers !== undefined
        ? { disabledInitializers: options.disabledInitializers }
        : {}),
    });

    if (poolResult.status === "restored") {
      return { status: "restored", entry: poolResult.entry };
    }
    if (poolResult.status === "warning") {
      return poolResult;
    }
    if (poolResult.status === "present") {
      return { status: "present" };
    }
    if (
      poolResult.status === "disabled" ||
      poolResult.status === "ineligible"
    ) {
      return { status: poolResult.status };
    }
    return { status: "missing" };
  });
}

/**
 * List evictable live installs for a repo identity, ordered for borrow:
 *   1. proven integrated (ancestry-only seam), oldest source activity first
 *   2. else any other evictable, oldest source activity first
 *
 * Evictable requires: eligible pnpm install, git clean, outside excludePaths,
 * and source-tree activity older than {@link SOURCE_ACTIVITY_GRACE_MS}.
 */
export async function listLiveNodeModulesInstalls(
  options: ListLiveInstallsOptions,
): Promise<LiveNodeModulesInstall[]> {
  const nowMs = options.nowMs ?? Date.now();
  const graceCutoff = nowMs - SOURCE_ACTIVITY_GRACE_MS;
  const excludePaths = uniqueResolvedPaths(options.excludePaths ?? []);
  const listCheckouts =
    options.listCheckouts ??
    (async () => {
      const { config } = await loadWorkspaceConfig();
      return listManagedCheckouts(config);
    });
  const isDirty = options.isDirty ?? isGitDirty;
  const isIntegrated =
    options.isIntegrated ?? ((hostPath) => isAncestryIntegrated(hostPath));
  const readSourceActivityMs =
    options.readSourceActivityMs ?? readSourceTreeActivityMs;

  const checkouts = await listCheckouts();
  const candidates: LiveNodeModulesInstall[] = [];

  for (const checkout of checkouts) {
    const hostPath = path.resolve(checkout.hostPath);
    if (isExcludedPath(hostPath, excludePaths)) {
      continue;
    }
    const checkoutIdentity = repoIdentity({
      name: "checkout",
      remote: checkout.remote,
    });
    if (checkoutIdentity !== options.identity) {
      continue;
    }

    if (!(await isEligiblePnpmInstall(hostPath))) {
      continue;
    }

    let dirty: boolean;
    try {
      dirty = await isDirty(hostPath);
    } catch {
      continue;
    }
    if (dirty) {
      continue;
    }

    const sourceActivityMs = await readSourceActivityMs(hostPath);
    if (sourceActivityMs > graceCutoff) {
      continue;
    }

    let integrated = false;
    try {
      integrated = await isIntegrated(hostPath);
    } catch {
      integrated = false;
    }

    candidates.push({
      hostPath,
      nodeModulesPath: path.join(hostPath, "node_modules"),
      selector: checkout.selector,
      sourceActivityMs,
      integrated,
    });
  }

  return sortDonors(candidates);
}

/**
 * Newest mtime under `root`, excluding {@link GENERATED_SOURCE_ROOTS} directory
 * names at every level. Missing roots yield `0`.
 */
export async function readSourceTreeActivityMs(root: string): Promise<number> {
  const resolved = path.resolve(root);
  if (!(await pathExists(resolved))) {
    return 0;
  }
  return walkNewestMtime(resolved);
}

/**
 * Discover managed checkouts that may host a live install for any repo.
 * Covers: standalone worktrees, workspace repo dirs, and task worktrees.
 */
export async function listManagedCheckouts(
  config: WorkspaceConfig,
): Promise<ManagedCheckout[]> {
  const directories = resolveWorkforestDirectories(config);
  const found: ManagedCheckout[] = [];
  const seen = new Set<string>();

  const add = (entry: ManagedCheckout) => {
    const key = path.resolve(entry.hostPath);
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ ...entry, hostPath: key });
  };

  await collectStandaloneWorktrees(directories, add);
  await collectWorkspaceCheckouts(directories, add);

  return found;
}

/**
 * Ancestry-only integration preference for donor ordering.
 *
 * Lane 1 seam: replace callers' `isIntegrated` inject with full proof
 * (ancestry → GitHub merged PR + Rule C) without changing acquire/borrow.
 */
export async function isAncestryIntegrated(hostPath: string): Promise<boolean> {
  try {
    const resolver = createDefaultBranchResolver();
    const defaultBranch = await resolver.resolveWorktreeDefaultBranch(hostPath);
    const { stdout: branchOut } = await runGit(["branch", "--show-current"], {
      cwd: hostPath,
    });
    const branch = branchOut.trim();
    if (branch && branch === defaultBranch) {
      return true;
    }
    await runGit(
      ["merge-base", "--is-ancestor", "HEAD", `origin/${defaultBranch}`],
      { cwd: hostPath },
    );
    return true;
  } catch {
    return false;
  }
}

export async function withNodeModulesIdentityLock<T>(
  identity: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquireNodeModulesIdentityLock(identity);
  try {
    return await operation();
  } finally {
    await release();
  }
}

function sortDonors(
  donors: readonly LiveNodeModulesInstall[],
): LiveNodeModulesInstall[] {
  return [...donors].sort((left, right) => {
    if (left.integrated !== right.integrated) {
      return left.integrated ? -1 : 1;
    }
    if (left.sourceActivityMs !== right.sourceActivityMs) {
      return left.sourceActivityMs - right.sourceActivityMs;
    }
    return left.hostPath.localeCompare(right.hostPath);
  });
}

async function walkNewestMtime(directory: string): Promise<number> {
  let newest = 0;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, {
      withFileTypes: true,
      encoding: "utf8",
    });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (GENERATED_SOURCE_ROOTS.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    try {
      if (entry.isDirectory()) {
        const nested = await walkNewestMtime(entryPath);
        if (nested > newest) newest = nested;
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        const stat = await fs.lstat(entryPath);
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      }
    } catch {
      // Skip unreadable entries.
    }
  }
  return newest;
}

async function collectStandaloneWorktrees(
  directories: WorkforestDirectories,
  add: (entry: ManagedCheckout) => void,
): Promise<void> {
  const repositories = await readChildDirectories(directories.repos);
  for (const repository of repositories) {
    const changes = await listWorktreeMetadata(repository.path).catch(() => []);
    for (const change of changes) {
      const changeName = change.metadata.workspace.feature_name;
      const hostPath = path.join(repository.path, changeName);
      const repoMeta = change.metadata.repos[0];
      if (!repoMeta) continue;
      add({
        hostPath,
        selector: `${repository.name}/${changeName}`,
        remote: repoMeta.remote,
      });

      // Task worktrees under standalone repo changes: Repos/<repo>/_tasks/<change>/<slug>
      const taskRoot = path.join(
        repository.path,
        TASKS_DIRECTORY_NAME,
        changeName,
      );
      const taskDirs = await readChildDirectories(taskRoot);
      for (const task of taskDirs) {
        add({
          hostPath: task.path,
          selector: `${repository.name}/${changeName}/${task.name}`,
          remote: repoMeta.remote,
        });
      }
    }
  }
}

async function collectWorkspaceCheckouts(
  directories: WorkforestDirectories,
  add: (entry: ManagedCheckout) => void,
): Promise<void> {
  const groups = await readChildDirectories(directories.workspaces);
  for (const group of groups) {
    // Ad-hoc / template layouts: Workspaces/<group>/<change>/...
    // Also support a direct workspace dir with metadata (rare).
    const direct = await readWorkspaceMetadata(group.path).catch(() => null);
    if (direct) {
      await addWorkspaceRepos(group.path, `${group.name}`, direct, add);
      continue;
    }

    const changes = await readChildDirectories(group.path);
    for (const change of changes) {
      const metadata = await readWorkspaceMetadata(change.path).catch(
        () => null,
      );
      if (!metadata) continue;
      const selectorBase = `${group.name}/${change.name}`;
      await addWorkspaceRepos(change.path, selectorBase, metadata, add);
    }
  }
}

async function addWorkspaceRepos(
  workspacePath: string,
  selectorBase: string,
  metadata: WorkspaceMetadata,
  add: (entry: ManagedCheckout) => void,
): Promise<void> {
  for (const repo of metadata.repos) {
    const hostPath = path.join(workspacePath, repo.name);
    add({
      hostPath,
      selector: `${selectorBase}/${repo.name}`,
      remote: repo.remote,
    });
  }

  for (const task of metadata.tasks ?? []) {
    const hostPath = path.join(workspacePath, task.path);
    const parent = metadata.repos.find(
      (repo) => repo.name === task.parent_repo,
    );
    if (!parent) continue;
    add({
      hostPath,
      selector: `${selectorBase}/task:${task.parent_repo}/${task.slug}`,
      remote: parent.remote,
    });
  }
}

async function readChildDirectories(
  root: string,
): Promise<readonly Readonly<{ name: string; path: string }>[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, {
      withFileTypes: true,
      encoding: "utf8",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: path.join(root, entry.name) }));
}

function uniqueResolvedPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of paths) {
    const resolved = path.resolve(value);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function isExcludedPath(
  hostPath: string,
  excludePaths: readonly string[],
): boolean {
  for (const excluded of excludePaths) {
    if (
      isPathInsideOrEqual(hostPath, excluded) ||
      isPathInsideOrEqual(excluded, hostPath)
    ) {
      return true;
    }
  }
  return false;
}

type LockRelease = () => Promise<void>;

async function acquireNodeModulesIdentityLock(
  identity: string,
): Promise<LockRelease> {
  // Identity is a hex digest; still route through resolveContainedPath.
  const locksDir = path.join(getCacheDir(), POOL_DIRNAME, LOCKS_DIRNAME);
  await ensureDir(locksDir);
  const lockPath = resolveContainedPath(locksDir, `${identity}.lock`);

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
      if (await removeStaleIdentityLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for node_modules identity lock at ${lockPath}`,
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
        // Best effort.
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

async function removeStaleIdentityLock(lockPath: string): Promise<boolean> {
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
