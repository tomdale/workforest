import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Cross-process exclusive lock files for activity state.
 *
 * Protocol:
 * - Publication: the owner record `{token, pid, host}` is written to a
 *   private temp file and hard-linked to the lock path. `link` fails with
 *   EEXIST when the lock exists, so a lock is never visible half-written.
 * - Liveness: a lock is reclaimable only when its owner is on this host and
 *   its pid is dead. Age never evicts a live owner; a lock from another host
 *   or with unreadable content is never reclaimed automatically.
 * - Reclamation: reclaimers first win an exclusive per-owner-token marker
 *   (`<lock>.reclaim-<token>`, also published with `link`). Only the winner
 *   may remove a lock carrying that token, and a dead owner never rewrites
 *   its lock, so the lock cannot change under the winner. Markers are left
 *   behind so a slow reclaimer holding the same stale token can never win
 *   later and delete a newer owner's lock.
 * - Release: only the holder of the matching token deletes the lock; no
 *   other process removes a live owner's lock, so check-then-delete is safe.
 */
type LockOwner = Readonly<{ token: string; pid: number; host: string }>;

export type HeldLock = Readonly<{
  token: string;
  release: () => Promise<void>;
}>;

export type LockHooks = Readonly<{
  /** Test seam: runs after reading a stale owner and before reclaiming. */
  beforeReclaim?: () => Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
}>;

const HOST = os.hostname();

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function tryAcquireLock(
  lockPath: string,
  hooks: LockHooks = {},
): Promise<HeldLock | null> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const owner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    host: HOST,
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await publish(lockPath, owner)) {
      return {
        token: owner.token,
        release: () => releaseLock(lockPath, owner.token),
      };
    }
    const current = await readOwner(lockPath);
    if (current === "missing") continue;
    if (current === "unreadable") return null;
    const alive = hooks.isProcessAlive ?? isProcessAlive;
    if (current.host !== HOST || alive(current.pid)) return null;
    await hooks.beforeReclaim?.();
    const marker = `${lockPath}.reclaim-${current.token}`;
    if (!(await publish(marker, owner))) return null;
    const confirmed = await readOwner(lockPath);
    if (typeof confirmed === "object" && confirmed.token === current.token) {
      await fs.rm(lockPath, { force: true });
    }
  }
  return null;
}

export async function withLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lock = await tryAcquireLock(lockPath);
    if (lock) {
      try {
        return await action();
      } finally {
        await lock.release();
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for lock ${lockPath}.`);
    }
    await delay(10 + Math.floor(Math.random() * 20));
  }
}

async function publish(target: string, owner: LockOwner): Promise<boolean> {
  const temp = `${target}.${owner.token}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(owner));
  try {
    await fs.link(temp, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function readOwner(
  lockPath: string,
): Promise<LockOwner | "missing" | "unreadable"> {
  let text: string;
  try {
    text = await fs.readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  try {
    const value = JSON.parse(text) as Partial<LockOwner>;
    if (
      typeof value.token === "string" &&
      typeof value.pid === "number" &&
      typeof value.host === "string"
    ) {
      return value as LockOwner;
    }
  } catch {
    // fall through
  }
  return "unreadable";
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  const current = await readOwner(lockPath);
  if (typeof current === "object" && current.token === token) {
    await fs.rm(lockPath, { force: true });
  }
}

/** Current owner of a lock, for status reporting. */
export async function lockOwnerPid(lockPath: string): Promise<number | null> {
  const owner = await readOwner(lockPath);
  if (typeof owner !== "object") return null;
  return owner.host === HOST && isProcessAlive(owner.pid) ? owner.pid : null;
}
