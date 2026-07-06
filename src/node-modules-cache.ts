import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { hasAny, pathExists } from "@wf-plugin/core";
import { getCacheDir } from "./config.ts";
import { normalizeRemote } from "./repositories.ts";
import type { NodeModulesCacheConfig, RepositorySource } from "./types.ts";
import { ensureDir } from "./utils/fs.ts";
import { resolveContainedPath } from "./utils/path-safety.ts";

const POOL_DIRNAME = "_node-modules";
const METADATA_FILENAME = "metadata.json";
const PNPM_LOCK_FILES = ["pnpm-lock.yaml", "pnpm-lock.yml"];
const LOCKFILE_HASH_MARKER = ".pnpm-lockfile-hash";
const DEFAULT_MAX_RETAINED_PER_REPO = 3;
const REMOVE_RETRY_COUNT = 5;
const REMOVE_RETRY_DELAY_MS = 20;
const BACKGROUND_SIZE_SCRIPT = `
const fs = require("node:fs/promises");
const path = require("node:path");

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readDirectorySize(directory) {
  let total = 0;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await readDirectorySize(entryPath);
    } else if (entry.isFile()) {
      total += (await fs.stat(entryPath)).size;
    }
  }
  return total;
}

async function main() {
  const entryPath = process.argv[1];
  if (!entryPath) return;
  const metadataPath = path.join(entryPath, "metadata.json");
  const nodeModulesPath = path.join(entryPath, "node_modules");
  if (!(await pathExists(metadataPath)) || !(await pathExists(nodeModulesPath))) {
    return;
  }
  const sizeBytes = await readDirectorySize(nodeModulesPath);
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  metadata.sizeBytes = sizeBytes;
  const tempPath = path.join(entryPath, ".metadata.json.tmp-" + process.pid);
  await fs.writeFile(tempPath, JSON.stringify(metadata, null, 2) + "\\n", "utf8");
  await fs.rename(tempPath, metadataPath);
}

main().catch(() => {});
`;

export type NormalizedNodeModulesCacheConfig = Readonly<{
  enabled: boolean;
  maxRetainedPerRepo: number;
}>;

export type NodeModulesCacheEntryMetadata = Readonly<{
  version: 1;
  repo: {
    name: string;
    remote: string;
    normalizedRemote: string;
    identity: string;
  };
  cachedAt: string;
  sourcePath: string;
  sizeBytes: number | null;
}>;

export type NodeModulesCacheEntry = Readonly<{
  entryPath: string;
  nodeModulesPath: string;
  metadata: NodeModulesCacheEntryMetadata;
}>;

export type NodeModulesCacheSummary = Readonly<{
  path: string;
  entryCount: number;
  repositoryCount: number;
  sizeBytes: number | null;
}>;

export type PreserveNodeModulesResult =
  | Readonly<{ status: "disabled" | "missing" | "ineligible" }>
  | Readonly<{ status: "preserved"; entry: NodeModulesCacheEntry }>
  | Readonly<{ status: "warning"; warning: string }>;

export type RestoreNodeModulesResult =
  | Readonly<{ status: "disabled" | "ineligible" | "missing" | "present" }>
  | Readonly<{ status: "restored"; entry: NodeModulesCacheEntry }>
  | Readonly<{ status: "warning"; warning: string }>;

export type DeleteNodeModulesCacheResult = Readonly<{
  dryRun: boolean;
  deleted: NodeModulesCacheEntry[];
  totalSizeBytes: number | null;
}>;

export function normalizeNodeModulesCacheConfig(
  value: NodeModulesCacheConfig | undefined,
): NormalizedNodeModulesCacheConfig {
  return {
    enabled: value?.enabled ?? true,
    maxRetainedPerRepo:
      value?.maxRetainedPerRepo ?? DEFAULT_MAX_RETAINED_PER_REPO,
  };
}

export function isPnpmInstallEnabled(
  disabledInitializers: boolean | string[] | undefined,
): boolean {
  return (
    disabledInitializers !== true &&
    !(
      Array.isArray(disabledInitializers) &&
      disabledInitializers.includes("pnpm-install")
    )
  );
}

export async function preserveNodeModules({
  repo,
  repoDir,
  config,
}: {
  repo: RepositorySource;
  repoDir: string;
  config?: NodeModulesCacheConfig | undefined;
}): Promise<PreserveNodeModulesResult> {
  const normalizedConfig = normalizeNodeModulesCacheConfig(config);
  if (!normalizedConfig.enabled) {
    return { status: "disabled" };
  }

  const resolvedRepoDir = path.resolve(repoDir);
  const nodeModulesPath = path.join(resolvedRepoDir, "node_modules");
  if (!(await pathExists(nodeModulesPath))) {
    return { status: "missing" };
  }
  if (!(await isEligiblePnpmInstall(resolvedRepoDir))) {
    return { status: "ineligible" };
  }

  const identity = repoIdentity(repo);
  const entryPath = resolveContainedPath(
    repoPoolDir(identity),
    `${Date.now()}-${randomUUID()}`,
  );
  const pooledNodeModulesPath = path.join(entryPath, "node_modules");
  const metadata: NodeModulesCacheEntryMetadata = {
    version: 1,
    repo: {
      name: repo.name,
      remote: repo.remote,
      normalizedRemote: normalizeRemote(repo.remote),
      identity,
    },
    cachedAt: new Date().toISOString(),
    sourcePath: nodeModulesPath,
    sizeBytes: null,
  };

  try {
    await ensureDir(entryPath);
    await fs.rename(nodeModulesPath, pooledNodeModulesPath);
    await writeMetadata(entryPath, metadata);
    const entry = {
      entryPath,
      nodeModulesPath: pooledNodeModulesPath,
      metadata,
    };
    scheduleNodeModulesSizeUpdate(entryPath);
    await pruneNodeModulesCache(repo, normalizedConfig.maxRetainedPerRepo);
    return { status: "preserved", entry };
  } catch (error) {
    return {
      status: "warning",
      warning: `Unable to preserve node_modules for ${repo.name}: ${errorMessage(error)}`,
    };
  }
}

export async function restoreNodeModules({
  repo,
  repoDir,
  config,
  disabledInitializers,
}: {
  repo: RepositorySource;
  repoDir: string;
  config?: NodeModulesCacheConfig | undefined;
  disabledInitializers?: boolean | string[];
}): Promise<RestoreNodeModulesResult> {
  const normalizedConfig = normalizeNodeModulesCacheConfig(config);
  if (
    !normalizedConfig.enabled ||
    !isPnpmInstallEnabled(disabledInitializers)
  ) {
    return { status: "disabled" };
  }

  const resolvedRepoDir = path.resolve(repoDir);
  if (!(await hasAny(resolvedRepoDir, PNPM_LOCK_FILES))) {
    return { status: "ineligible" };
  }

  const targetPath = path.join(resolvedRepoDir, "node_modules");
  if (await pathExists(targetPath)) {
    return { status: "present" };
  }

  const entry = await newestEntryForRepo(repo);
  if (!entry) {
    return { status: "missing" };
  }

  try {
    await fs.rename(entry.nodeModulesPath, targetPath);
    await removeCacheDirectory(entry.entryPath);
    return { status: "restored", entry };
  } catch (error) {
    return {
      status: "warning",
      warning: `Unable to restore node_modules for ${repo.name}: ${errorMessage(error)}`,
    };
  }
}

export async function rollbackPreservedNodeModules(
  result: PreserveNodeModulesResult,
): Promise<void> {
  if (result.status !== "preserved") {
    return;
  }
  const source = result.entry.nodeModulesPath;
  const target = result.entry.metadata.sourcePath;
  if ((await pathExists(source)) && !(await pathExists(target))) {
    await fs.rename(source, target);
  }
  await removeCacheDirectory(result.entry.entryPath);
}

export async function listNodeModulesCacheEntries(): Promise<
  NodeModulesCacheEntry[]
> {
  const poolDir = nodeModulesPoolDir();
  if (!(await pathExists(poolDir))) {
    return [];
  }

  const repoDirs = await fs.readdir(poolDir, { withFileTypes: true });
  const entries: NodeModulesCacheEntry[] = [];
  for (const repoDir of repoDirs) {
    if (!repoDir.isDirectory()) {
      continue;
    }
    const repoPath = resolveContainedPath(poolDir, repoDir.name);
    const cacheDirs = await fs.readdir(repoPath, { withFileTypes: true });
    for (const cacheDir of cacheDirs) {
      if (!cacheDir.isDirectory()) {
        continue;
      }
      const entryPath = resolveContainedPath(repoPath, cacheDir.name);
      const entry = await readEntry(entryPath);
      if (entry) {
        entries.push(entry);
      }
    }
  }
  return sortEntries(entries);
}

export async function summarizeNodeModulesCache(): Promise<NodeModulesCacheSummary> {
  const entries = await listNodeModulesCacheEntries();
  return {
    path: nodeModulesPoolDir(),
    entryCount: entries.length,
    repositoryCount: new Set(
      entries.map((entry) => entry.metadata.repo.identity),
    ).size,
    sizeBytes: totalSize(entries),
  };
}

export async function deleteNodeModulesCache(
  dryRun = false,
): Promise<DeleteNodeModulesCacheResult> {
  const entries = await listNodeModulesCacheEntries();
  if (!dryRun) {
    await removeCacheDirectory(nodeModulesPoolDir());
  }
  return {
    dryRun,
    deleted: entries,
    totalSizeBytes: totalSize(entries),
  };
}

async function pruneNodeModulesCache(
  repo: RepositorySource,
  maxRetainedPerRepo: number,
): Promise<void> {
  const entries = sortEntries(await entriesForRepo(repo));
  const excess = entries.slice(maxRetainedPerRepo);
  await Promise.all(
    excess.map((entry) => removeCacheDirectory(entry.entryPath)),
  );
}

async function removeCacheDirectory(targetPath: string): Promise<void> {
  await fs.rm(targetPath, {
    recursive: true,
    force: true,
    maxRetries: REMOVE_RETRY_COUNT,
    retryDelay: REMOVE_RETRY_DELAY_MS,
  });
}

async function newestEntryForRepo(
  repo: RepositorySource,
): Promise<NodeModulesCacheEntry | null> {
  return sortEntries(await entriesForRepo(repo))[0] ?? null;
}

async function entriesForRepo(
  repo: RepositorySource,
): Promise<NodeModulesCacheEntry[]> {
  const poolDir = repoPoolDir(repoIdentity(repo));
  if (!(await pathExists(poolDir))) {
    return [];
  }
  const entries = await fs.readdir(poolDir, { withFileTypes: true });
  const resolved = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readEntry(resolveContainedPath(poolDir, entry.name))),
  );
  return resolved.filter((entry): entry is NodeModulesCacheEntry =>
    Boolean(entry),
  );
}

async function readEntry(
  entryPath: string,
): Promise<NodeModulesCacheEntry | null> {
  try {
    const metadata = JSON.parse(
      await fs.readFile(path.join(entryPath, METADATA_FILENAME), "utf8"),
    ) as NodeModulesCacheEntryMetadata;
    const nodeModulesPath = path.join(entryPath, "node_modules");
    if (!(await pathExists(nodeModulesPath))) {
      return null;
    }
    return { entryPath, nodeModulesPath, metadata };
  } catch {
    return null;
  }
}

async function writeMetadata(
  entryPath: string,
  metadata: NodeModulesCacheEntryMetadata,
): Promise<void> {
  await fs.writeFile(
    path.join(entryPath, METADATA_FILENAME),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
}

function scheduleNodeModulesSizeUpdate(entryPath: string): void {
  try {
    const child = spawn(
      process.execPath,
      ["-e", BACKGROUND_SIZE_SCRIPT, entryPath],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref();
  } catch {
    // Size accounting is best-effort; preserve/restore correctness does not
    // depend on this metadata being filled in synchronously.
  }
}

async function isEligiblePnpmInstall(repoDir: string): Promise<boolean> {
  return (
    (await hasAny(repoDir, PNPM_LOCK_FILES)) &&
    (await pathExists(path.join(repoDir, "node_modules", LOCKFILE_HASH_MARKER)))
  );
}

function sortEntries(
  entries: readonly NodeModulesCacheEntry[],
): NodeModulesCacheEntry[] {
  return [...entries].sort(
    (left, right) =>
      Date.parse(right.metadata.cachedAt) - Date.parse(left.metadata.cachedAt),
  );
}

function repoIdentity(repo: RepositorySource): string {
  return createHash("sha256")
    .update(normalizeRemote(repo.remote))
    .digest("hex");
}

function nodeModulesPoolDir(): string {
  return path.join(getCacheDir(), POOL_DIRNAME);
}

function repoPoolDir(identity: string): string {
  return resolveContainedPath(nodeModulesPoolDir(), identity);
}

function totalSize(entries: readonly NodeModulesCacheEntry[]): number | null {
  const known = entries
    .map((entry) => entry.metadata.sizeBytes)
    .filter((size): size is number => size !== null);
  return known.length === 0 && entries.length > 0
    ? null
    : known.reduce((total, size) => total + size, 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
