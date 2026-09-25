import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getCacheDir } from "../config.ts";
import {
  ACTIVITY_RECORD_VERSION,
  type ActivityRecord,
  type ActivityTargetIdentity,
} from "./types.ts";

const ACTIVITY_DIRNAME = "_activity";
const RECORDS_DIRNAME = "records";
const LOCK_RETRY_MS = 15;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

export function activityRoot(cacheDir = getCacheDir()): string {
  return path.join(cacheDir, ACTIVITY_DIRNAME);
}

function recordsDir(root: string): string {
  return path.join(root, RECORDS_DIRNAME);
}

function recordPath(root: string, key: string): string {
  return path.join(recordsDir(root), `${key}.json`);
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
      startedAt: null,
      attempts: 0,
      lastError: null,
      lastFailedAt: null,
      nextAttemptAt: null,
    },
    user: { purpose: null, pinned: false, updatedAt: null },
    events: [],
  };
}

export async function readRecord(
  root: string,
  key: string,
): Promise<ActivityRecord | null> {
  let text: string;
  try {
    text = await fs.readFile(recordPath(root, key), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const value = JSON.parse(text) as ActivityRecord;
    return value.version === ACTIVITY_RECORD_VERSION ? value : null;
  } catch {
    // A torn or foreign file is treated as absent; the next write replaces it.
    return null;
  }
}

/**
 * Read-modify-write one record under its lock with an atomic rename, so
 * concurrent sweeps, refreshes, and explicit inputs never lose each other's
 * fields. `update` receives the current record (or a fresh one) and returns
 * the record to persist, or `null` to leave the file untouched.
 */
export async function mutateRecord(
  root: string,
  target: ActivityTargetIdentity,
  update: (record: ActivityRecord) => ActivityRecord | null,
): Promise<ActivityRecord> {
  await fs.mkdir(recordsDir(root), { recursive: true });
  return withFileLock(`${recordPath(root, target.key)}.lock`, async () => {
    const current = (await readRecord(root, target.key)) ?? emptyRecord(target);
    // Selector and path can change (e.g. group renames) without a new identity.
    const base = { ...current, target };
    const next = update(base);
    if (!next) return current;
    await writeJsonAtomic(recordPath(root, target.key), next);
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

async function withFileLock<T>(
  lockPath: string,
  action: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, at: Date.now() }),
      );
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await isStaleLock(lockPath)) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for activity lock ${lockPath}.`);
      }
      await delay(LOCK_RETRY_MS);
    }
  }
  try {
    return await action();
  } finally {
    await fs.rm(lockPath, { force: true });
  }
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  const owner = await readJson<{ pid?: number; at?: number }>(lockPath);
  if (!owner) {
    // Unreadable: either mid-write or torn. Age decides.
    try {
      const stat = await fs.stat(lockPath);
      return Date.now() - stat.mtimeMs > STALE_LOCK_MS;
    } catch {
      return true;
    }
  }
  if (typeof owner.pid === "number" && !isProcessAlive(owner.pid)) return true;
  return typeof owner.at === "number" && Date.now() - owner.at > STALE_LOCK_MS;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Exclusive long-lived ownership (one sweeper at a time across processes).
 * Returns a release function, or `null` when a live process already holds it.
 */
export async function tryAcquireOwnership(
  lockPath: string,
): Promise<(() => Promise<void>) | null> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, at: Date.now() }),
      );
      await handle.close();
      return async () => {
        const owner = await readJson<{ pid?: number }>(lockPath);
        if (owner?.pid === process.pid) await fs.rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readJson<{ pid?: number }>(lockPath);
      if (typeof owner?.pid === "number" && isProcessAlive(owner.pid)) {
        return null;
      }
      await fs.rm(lockPath, { force: true });
    }
  }
  return null;
}

export async function listRecordKeys(root: string): Promise<string[]> {
  try {
    return (await fs.readdir(recordsDir(root)))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function removeRecord(root: string, key: string): Promise<void> {
  await fs.rm(recordPath(root, key), { force: true });
}
