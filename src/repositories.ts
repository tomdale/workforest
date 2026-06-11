import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getCacheDir, reposFromSlugs } from "./config.ts";
import { validateRepositoryComponent } from "./repository-components.ts";
import { runGit } from "./services/git.ts";
import type { RepoConfig } from "./types.ts";
import { ensureDir, pathExists } from "./utils/fs.ts";
import { resolveContainedPath } from "./utils/path-safety.ts";
import { ensureMirrorRepoGenerator } from "./workspace/repository.ts";

export type CachedRepositoryHealth = "healthy" | "attention" | "invalid";

export type CachedRepositoryWorktree = {
  path: string;
  branch?: string;
  detached: boolean;
  prunable: boolean;
  exists: boolean;
};

export type CachedRepository = {
  name: string;
  slug: string | null;
  remote: string | null;
  mirrorPath: string;
  directoryName: string;
  defaultBranch: string | null;
  sizeBytes: number | null;
  lastFetchedAt: Date | null;
  worktrees: CachedRepositoryWorktree[];
  health: CachedRepositoryHealth;
  issues: string[];
};

export type DeleteCachedRepositoryOptions = {
  dryRun?: boolean;
  force?: boolean;
};

export type DeleteCachedRepositoryResult = {
  repository: CachedRepository;
  deleted: boolean;
};

export class RegisteredRepositoryNameCollisionError extends Error {
  readonly repositoryName: string;
  readonly slugs: string[];

  constructor(repositoryName: string, slugs: string[]) {
    super(
      `Repository shorthand "${repositoryName}" has a naming collision: multiple registered repositories match (${slugs.join(", ")}). Use a fully qualified org/repo.`,
    );
    this.name = "RegisteredRepositoryNameCollisionError";
    this.repositoryName = repositoryName;
    this.slugs = slugs;
  }
}

export class CachedRepositorySelectorError extends Error {
  readonly selector: string;
  readonly matches: string[];

  constructor(selector: string, matches: string[]) {
    super(
      `Cached repository "${selector}" is ambiguous: ${matches.join(", ")}. Use the full slug or cache directory name.`,
    );
    this.name = "CachedRepositorySelectorError";
    this.selector = selector;
    this.matches = matches;
  }
}

export async function resolveRegisteredRepository(
  repositoryName: string,
  repositories?: CachedRepository[],
): Promise<string | null> {
  const normalizedName = repositoryName.trim().toLowerCase();
  if (!normalizedName) {
    return null;
  }

  const candidates = repositories ?? (await listCachedRepositories());
  const matches = candidates.filter(
    (repository) =>
      repository.slug && repository.name.toLowerCase() === normalizedName,
  );

  if (matches.length === 0) {
    return null;
  }

  const slugs = [
    ...new Map(
      matches.flatMap((repository) =>
        repository.slug
          ? [[repository.slug.toLowerCase(), repository.slug] as const]
          : [],
      ),
    ).values(),
  ].sort((a, b) => a.localeCompare(b));

  if (slugs.length > 1) {
    throw new RegisteredRepositoryNameCollisionError(repositoryName, slugs);
  }

  return slugs[0] ?? null;
}

export async function listCachedRepositories(): Promise<CachedRepository[]> {
  const cacheDir = getCacheDir();
  if (!(await pathExists(cacheDir))) {
    return [];
  }

  const entries = await fs.readdir(cacheDir, { withFileTypes: true });
  const repositories = await Promise.all(
    entries
      .filter((entry) => entry.name.endsWith(".git"))
      .map((entry) =>
        inspectCachedRepository(resolveContainedPath(cacheDir, entry.name)),
      ),
  );

  return repositories.sort((left, right) =>
    repositoryDisplayName(left).localeCompare(repositoryDisplayName(right)),
  );
}

export async function resolveCachedRepository(
  selector: string,
  repositories?: CachedRepository[],
): Promise<CachedRepository | null> {
  const normalized = selector.trim().toLowerCase();
  if (!normalized) return null;

  const candidates = repositories ?? (await listCachedRepositories());
  const exactMatches = candidates.filter((repository) => {
    return (
      repository.slug?.toLowerCase() === normalized ||
      repository.remote?.toLowerCase() === normalized ||
      repository.mirrorPath.toLowerCase() === normalized ||
      repository.directoryName.toLowerCase() === normalized
    );
  });

  if (exactMatches.length === 1) {
    return exactMatches[0] ?? null;
  }
  if (exactMatches.length > 1) {
    throw new CachedRepositorySelectorError(
      selector,
      exactMatches.map(repositoryDisplayName),
    );
  }

  const nameMatches = candidates.filter(
    (repository) => repository.name.toLowerCase() === normalized,
  );
  if (nameMatches.length === 0) return null;
  if (nameMatches.length > 1) {
    throw new CachedRepositorySelectorError(
      selector,
      nameMatches.map(repositoryDisplayName),
    );
  }

  return nameMatches[0] ?? null;
}

export async function resolveMirrorDir(
  repo: RepoConfig,
  cacheDir = getCacheDir(),
): Promise<string> {
  const repoName = validateRepositoryComponent(repo.name, "Repository name");
  const legacyPath = resolveContainedPath(cacheDir, `${repoName}.git`);
  if (await pathExists(legacyPath)) {
    const legacyRemote = await readRemoteFromConfigFile(legacyPath);
    if (
      !legacyRemote ||
      normalizeRemote(legacyRemote) === normalizeRemote(repo.remote)
    ) {
      return legacyPath;
    }
  }

  if (await pathExists(cacheDir)) {
    const entries = await fs.readdir(cacheDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith(".git")) {
        continue;
      }
      const mirrorPath = resolveContainedPath(cacheDir, entry.name);
      const remote = await readRemoteFromConfigFile(mirrorPath);
      if (remote && normalizeRemote(remote) === normalizeRemote(repo.remote)) {
        return mirrorPath;
      }
    }
  }

  if (!(await pathExists(legacyPath))) {
    return legacyPath;
  }

  const identity = getRemoteIdentity(repo.remote);
  const qualifier = identity?.owner
    ? `${identity.owner}--${repoName}`
    : `${repoName}-${createHash("sha256")
        .update(normalizeRemote(repo.remote))
        .digest("hex")
        .slice(0, 10)}`;

  return resolveContainedPath(cacheDir, `${qualifier}.git`);
}

export async function addCachedRepository(
  input: string,
): Promise<CachedRepository> {
  const repo = reposFromSlugs([input])[0];
  if (!repo) {
    throw new Error(`Invalid repository: ${input}`);
  }

  const cacheDir = getCacheDir();
  await ensureDir(cacheDir);
  const mirrorDir = await resolveMirrorDir(repo, cacheDir);

  for await (const state of ensureMirrorRepoGenerator(repo, mirrorDir)) {
    if (state.status === "failed") {
      throw state.error;
    }
  }

  return inspectCachedRepository(mirrorDir);
}

export async function updateCachedRepository(
  repository: CachedRepository,
): Promise<CachedRepository> {
  if (!repository.remote) {
    throw new Error(
      `Cannot update ${repositoryDisplayName(repository)} because it has no origin remote.`,
    );
  }

  const repo = cachedRepositoryToRepoConfig(repository);
  for await (const state of ensureMirrorRepoGenerator(
    repo,
    repository.mirrorPath,
  )) {
    if (state.status === "failed") {
      throw state.error;
    }
  }

  return inspectCachedRepository(repository.mirrorPath);
}

export async function repairCachedRepository(
  repository: CachedRepository,
): Promise<CachedRepository> {
  if (repository.health === "invalid") {
    throw new Error(
      `${repositoryDisplayName(repository)} is not a valid bare Git repository. Delete and add it again.`,
    );
  }

  await runGit(["worktree", "prune"], { cwd: repository.mirrorPath });
  await runGit(["fsck", "--connectivity-only"], {
    cwd: repository.mirrorPath,
  });

  return inspectCachedRepository(repository.mirrorPath);
}

export async function deleteCachedRepository(
  repository: CachedRepository,
  options: DeleteCachedRepositoryOptions = {},
): Promise<DeleteCachedRepositoryResult> {
  const activeWorktrees = repository.worktrees.filter(
    (worktree) => worktree.exists && !worktree.prunable,
  );
  if (activeWorktrees.length > 0 && !options.force) {
    throw new Error(
      `${repositoryDisplayName(repository)} has ${activeWorktrees.length} active worktree${activeWorktrees.length === 1 ? "" : "s"}. Delete those worktrees first or pass --force.`,
    );
  }

  const deletionTarget = await validateCachedRepositoryDeletionPath(
    getCacheDir(),
    repository.mirrorPath,
  );

  if (!options.dryRun) {
    if (deletionTarget.isSymbolicLink) {
      await fs.unlink(deletionTarget.path);
    } else {
      await fs.rm(deletionTarget.path, { recursive: true, force: true });
    }
  }

  return {
    repository,
    deleted: options.dryRun !== true,
  };
}

export async function cleanCachedRepositories(
  options: DeleteCachedRepositoryOptions = {},
): Promise<DeleteCachedRepositoryResult[]> {
  const repositories = await listCachedRepositories();
  const unused = repositories.filter(
    (repository) =>
      repository.worktrees.filter(
        (worktree) => worktree.exists && !worktree.prunable,
      ).length === 0,
  );

  const results: DeleteCachedRepositoryResult[] = [];
  for (const repository of unused) {
    results.push(await deleteCachedRepository(repository, options));
  }
  return results;
}

export function repositoryDisplayName(repository: CachedRepository): string {
  return (
    repository.slug ??
    repository.remote ??
    repository.directoryName.replace(/\.git$/i, "")
  );
}

export function formatByteSize(bytes: number | null): string {
  if (bytes === null) return "unknown";
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0] ?? "KiB";
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index] ?? unit;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

async function inspectCachedRepository(
  mirrorPath: string,
): Promise<CachedRepository> {
  const directoryName = path.basename(mirrorPath);
  const fallbackName = directoryName.replace(/\.git$/i, "");
  const issues: string[] = [];
  const mirrorStat = await fs.lstat(mirrorPath);

  if (mirrorStat.isSymbolicLink() || !mirrorStat.isDirectory()) {
    return {
      name: fallbackName,
      slug: null,
      remote: null,
      mirrorPath,
      directoryName,
      defaultBranch: null,
      sizeBytes: mirrorStat.isFile() ? mirrorStat.size : null,
      lastFetchedAt: null,
      worktrees: [],
      health: "invalid",
      issues: [
        mirrorStat.isSymbolicLink()
          ? "Cache entry is a symbolic link"
          : "Cache entry is not a directory",
      ],
    };
  }

  try {
    const { stdout } = await runGit(["rev-parse", "--is-bare-repository"], {
      cwd: mirrorPath,
    });
    if (stdout.trim() !== "true") {
      issues.push("Not a bare Git repository");
    }
  } catch {
    return {
      name: fallbackName,
      slug: null,
      remote: null,
      mirrorPath,
      directoryName,
      defaultBranch: null,
      sizeBytes: await readDirectorySize(mirrorPath),
      lastFetchedAt: await readLastFetchedAt(mirrorPath),
      worktrees: [],
      health: "invalid",
      issues: ["Unreadable or invalid Git repository"],
    };
  }

  const remote = await readRemote(mirrorPath);
  if (!remote) {
    issues.push("Missing origin remote");
  }

  const identity = remote ? getRemoteIdentity(remote) : null;
  const worktrees = await readWorktrees(mirrorPath, issues);
  const staleWorktrees = worktrees.filter(
    (worktree) => worktree.prunable || !worktree.exists,
  );
  if (staleWorktrees.length > 0) {
    issues.push(
      `${staleWorktrees.length} stale worktree registration${staleWorktrees.length === 1 ? "" : "s"}`,
    );
  }

  return {
    name: identity?.name ?? fallbackName,
    slug: identity?.slug ?? null,
    remote,
    mirrorPath,
    directoryName,
    defaultBranch: await readDefaultBranch(mirrorPath),
    sizeBytes: await readGitStorageSize(mirrorPath),
    lastFetchedAt: await readLastFetchedAt(mirrorPath),
    worktrees,
    health: issues.length === 0 ? "healthy" : "attention",
    issues,
  };
}

async function readRemote(mirrorPath: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(["config", "--get", "remote.origin.url"], {
      cwd: mirrorPath,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function readRemoteFromConfigFile(
  mirrorPath: string,
): Promise<string | null> {
  try {
    const config = await fs.readFile(path.join(mirrorPath, "config"), "utf8");
    const originSection = config.match(
      /\[remote\s+"origin"\]([\s\S]*?)(?=\n\[|$)/i,
    )?.[1];
    const remote = originSection?.match(/^\s*url\s*=\s*(.+)\s*$/im)?.[1];
    return remote?.trim() || null;
  } catch {
    return null;
  }
}

async function readDefaultBranch(mirrorPath: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(["symbolic-ref", "--short", "HEAD"], {
      cwd: mirrorPath,
    });
    return stdout.trim().replace(/^origin\//, "") || null;
  } catch {
    return null;
  }
}

async function readGitStorageSize(mirrorPath: string): Promise<number | null> {
  try {
    const { stdout } = await runGit(["count-objects", "-v"], {
      cwd: mirrorPath,
    });
    const values = new Map(
      stdout
        .split("\n")
        .map((line) => line.split(":").map((part) => part.trim()))
        .filter((parts): parts is [string, string] => parts.length === 2),
    );
    const looseKiB = Number.parseInt(values.get("size") ?? "0", 10);
    const packedKiB = Number.parseInt(values.get("size-pack") ?? "0", 10);
    if (!Number.isFinite(looseKiB) || !Number.isFinite(packedKiB)) {
      return null;
    }
    return (looseKiB + packedKiB) * 1024;
  } catch {
    return null;
  }
}

async function readDirectorySize(directory: string): Promise<number | null> {
  try {
    let total = 0;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        total += (await readDirectorySize(entryPath)) ?? 0;
      } else if (entry.isFile()) {
        total += (await fs.stat(entryPath)).size;
      }
    }
    return total;
  } catch {
    return null;
  }
}

async function readLastFetchedAt(mirrorPath: string): Promise<Date | null> {
  for (const candidate of ["FETCH_HEAD", "packed-refs", "config"]) {
    try {
      return (await fs.stat(path.join(mirrorPath, candidate))).mtime;
    } catch {
      // Try the next repository activity marker.
    }
  }
  return null;
}

async function readWorktrees(
  mirrorPath: string,
  issues: string[],
): Promise<CachedRepositoryWorktree[]> {
  let stdout: string;
  try {
    ({ stdout } = await runGit(["worktree", "list", "--porcelain"], {
      cwd: mirrorPath,
    }));
  } catch {
    issues.push("Unable to list worktrees");
    return [];
  }

  const records = stdout.trim().split(/\n\n+/);
  const worktrees: CachedRepositoryWorktree[] = [];
  for (const record of records) {
    const lines = record.split("\n");
    const worktreeLine = lines.find((line) => line.startsWith("worktree "));
    if (!worktreeLine || lines.includes("bare")) continue;

    const worktreePath = worktreeLine.slice("worktree ".length).trim();
    const branchLine = lines.find((line) => line.startsWith("branch "));
    const branch = branchLine
      ?.slice("branch ".length)
      .replace(/^refs\/heads\//, "");

    worktrees.push({
      path: worktreePath,
      ...(branch ? { branch } : {}),
      detached: lines.includes("detached"),
      prunable: lines.some((line) => line.startsWith("prunable ")),
      exists: await pathExists(worktreePath),
    });
  }
  return worktrees;
}

function cachedRepositoryToRepoConfig(
  repository: CachedRepository,
): RepoConfig {
  if (!repository.remote) {
    throw new Error(
      `Cached repository ${repositoryDisplayName(repository)} has no origin remote.`,
    );
  }
  return {
    name: validateRepositoryComponent(repository.name, "Repository name"),
    remote: repository.remote,
    defaultBranch: repository.defaultBranch ?? "main",
  };
}

function getRemoteIdentity(
  remote: string,
): { owner?: string; name: string; slug?: string } | null {
  const github = parseGitHubRepository(remote);
  if (github) {
    const [owner, name] = github.slug.split("/");
    return {
      ...(owner ? { owner } : {}),
      name: name ?? github.name,
      slug: github.slug,
    };
  }

  const normalized = remote.replace(/[/:]+$/, "").replace(/\.git$/i, "");
  const name = normalized.split(/[/:]/).at(-1);
  if (!name) return null;
  try {
    return {
      name: validateRepositoryComponent(name, "Repository name"),
    };
  } catch {
    return null;
  }
}

function parseGitHubRepository(
  remote: string,
): { name: string; slug: string } | null {
  const sshMatch = remote.match(
    /^(?:[^@]+@)?github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
  );
  if (sshMatch?.[1] && sshMatch[2]) {
    return createRegisteredRepository(sshMatch[1], sshMatch[2]);
  }

  let parsed: URL;
  try {
    parsed = new URL(remote);
  } catch {
    return null;
  }

  if (parsed.hostname.toLowerCase() !== "github.com") {
    return null;
  }

  const parts = parsed.pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .split("/");
  if (parts.length !== 2) {
    return null;
  }

  const [org, repo] = parts;
  if (!org || !repo) {
    return null;
  }

  return createRegisteredRepository(org, repo);
}

function createRegisteredRepository(
  org: string,
  repo: string,
): { name: string; slug: string } {
  const owner = validateRepositoryComponent(org, "Repository owner");
  const name = validateRepositoryComponent(repo, "Repository name");
  return {
    name,
    slug: `${owner}/${name}`,
  };
}

export function normalizeRemote(remote: string): string {
  return remote
    .trim()
    .toLowerCase()
    .replace(/^ssh:\/\/git@/, "")
    .replace(/^git@/, "")
    .replace(/^https?:\/\//, "")
    .replace(/:/, "/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

async function validateCachedRepositoryDeletionPath(
  cacheDir: string,
  mirrorPath: string,
): Promise<{ path: string; isSymbolicLink: boolean }> {
  const resolvedCacheDir = path.resolve(cacheDir);
  const resolvedMirrorPath = path.resolve(mirrorPath);
  const relative = path.relative(resolvedCacheDir, resolvedMirrorPath);

  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.dirname(relative) !== "."
  ) {
    throw new Error(
      `Cached repository path must be a direct child of ${resolvedCacheDir}: ${mirrorPath}`,
    );
  }

  const containedMirrorPath = resolveContainedPath(resolvedCacheDir, relative);

  try {
    const mirrorStat = await fs.lstat(containedMirrorPath);
    if (mirrorStat.isSymbolicLink()) {
      return { path: containedMirrorPath, isSymbolicLink: true };
    }

    const [realCacheDir, realMirrorPath] = await Promise.all([
      fs.realpath(resolvedCacheDir),
      fs.realpath(containedMirrorPath),
    ]);
    if (path.dirname(realMirrorPath) !== realCacheDir) {
      throw new Error(
        `Cached repository path escapes ${resolvedCacheDir}: ${mirrorPath}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return { path: containedMirrorPath, isSymbolicLink: false };
}
