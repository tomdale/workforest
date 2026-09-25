import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getCacheDir, getConfigPaths } from "../config.ts";
import { withLock } from "./lock.ts";
import {
  ACTIVITY_RECORD_VERSION,
  type ActivityInputs,
  type ActivityRecord,
  type ActivityTargetIdentity,
} from "./types.ts";

/** Where cache records and authored inputs live. */
export type ActivityPaths = Readonly<{
  /** Regenerable: records, sweep/service state, provider sandbox. */
  cacheRoot: string;
  /** Durable: explicit purpose, pins, and handoff notes. */
  inputsRoot: string;
}>;

export function activityPaths(): ActivityPaths {
  return {
    cacheRoot: path.join(getCacheDir(), "_activity"),
    inputsRoot: path.join(
      path.dirname(getConfigPaths().preferredPath),
      "activity",
    ),
  };
}

function recordsDir(paths: ActivityPaths): string {
  return path.join(paths.cacheRoot, "records");
}

function inputsDir(paths: ActivityPaths): string {
  return path.join(paths.inputsRoot, "inputs");
}

/**
 * A checkout's identity is its path plus its metadata creation time, so a
 * deleted-and-recreated checkout at the same path starts with no digest
 * instead of inheriting one that described unrelated work.
 */
export function activityKey(targetPath: string, createdAt: string): string {
  return createHash("sha256")
    .update(`${path.resolve(targetPath)}\0${createdAt}`)
    .digest("hex")
    .slice(0, 32);
}

export function emptyRecord(target: ActivityTargetIdentity): ActivityRecord {
  return {
    version: ACTIVITY_RECORD_VERSION,
    target,
    observation: null,
    digest: null,
    generation: {
      state: "idle",
      fingerprint: null,
      runId: null,
      pid: null,
      host: null,
      startedAt: null,
      attempts: 0,
      lastError: null,
      lastFailedAt: null,
      nextAttemptAt: null,
    },
  };
}

export function emptyInputs(target: ActivityTargetIdentity): ActivityInputs {
  return {
    version: ACTIVITY_RECORD_VERSION,
    target,
    purpose: null,
    pinned: false,
    events: [],
    revision: 0,
    activityAt: null,
  };
}

export async function readRecord(
  paths: ActivityPaths,
  target: ActivityTargetIdentity,
): Promise<ActivityRecord> {
  const value = await readVersioned<ActivityRecord>(
    path.join(recordsDir(paths), `${target.key}.json`),
  );
  return { ...(value ?? emptyRecord(target)), target };
}

export async function readInputs(
  paths: ActivityPaths,
  target: ActivityTargetIdentity,
): Promise<ActivityInputs> {
  const value = await readVersioned<ActivityInputs>(
    path.join(inputsDir(paths), `${target.key}.json`),
  );
  return { ...(value ?? emptyInputs(target)), target };
}

async function readVersioned<T extends { version: number }>(
  filePath: string,
): Promise<T | null> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const value = JSON.parse(text) as T;
    return value.version === ACTIVITY_RECORD_VERSION ? value : null;
  } catch {
    // Writes are atomic renames, so this is a foreign file; treat as absent.
    return null;
  }
}

/**
 * Read-modify-write one cache record under its lock with an atomic rename.
 * `update` returns the record to persist, or `null` to leave it untouched.
 */
export async function mutateRecord(
  paths: ActivityPaths,
  target: ActivityTargetIdentity,
  update: (record: ActivityRecord) => ActivityRecord | null,
): Promise<ActivityRecord> {
  const filePath = path.join(recordsDir(paths), `${target.key}.json`);
  await fs.mkdir(recordsDir(paths), { recursive: true });
  return withLock(`${filePath}.lock`, async () => {
    const current = await readRecord(paths, target);
    const next = update(current);
    if (!next) return current;
    await writeJsonAtomic(filePath, next);
    return next;
  });
}

/** Read-modify-write authored inputs; see {@link mutateRecord}. */
export async function mutateInputs(
  paths: ActivityPaths,
  target: ActivityTargetIdentity,
  update: (inputs: ActivityInputs) => ActivityInputs,
): Promise<ActivityInputs> {
  const filePath = path.join(inputsDir(paths), `${target.key}.json`);
  await fs.mkdir(inputsDir(paths), { recursive: true });
  return withLock(`${filePath}.lock`, async () => {
    const next = update(await readInputs(paths, target));
    await writeJsonAtomic(filePath, next);
    return next;
  });
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tempPath, filePath);
}

export async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Delete cache records whose checkout identity is gone. Each deletion takes
 * the record lock so it cannot interleave with a writer. Authored inputs are
 * never pruned.
 */
export async function pruneRecords(
  paths: ActivityPaths,
  liveKeys: ReadonlySet<string>,
): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(recordsDir(paths));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let pruned = 0;
  for (const name of names) {
    if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
    const key = name.slice(0, -".json".length);
    if (liveKeys.has(key)) continue;
    const filePath = path.join(recordsDir(paths), name);
    await withLock(`${filePath}.lock`, () => fs.rm(filePath, { force: true }));
    pruned += 1;
  }
  return pruned;
}
