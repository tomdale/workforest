import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runGit } from "../services/git.ts";
import type { ActivityCheckout, ActivityTarget } from "./targets.ts";
import type { ActivityRecord } from "./types.ts";

/**
 * Cheap, bounded activity detection. Each checkout costs two Git commands:
 * `status --porcelain=v2 --branch` (ignored files are excluded by Git) and a
 * one-line `log`. Dirty paths are additionally `stat`ed so a repeated edit to
 * an already-dirty file changes the fingerprint. Nothing recurses the tree
 * beyond what Git itself reports, and `--no-optional-locks` keeps detection
 * from refreshing the index (which would otherwise look like activity).
 */
const MAX_DIRTY_PATHS = 200;
const GIT_TIMEOUT_MS = 15_000;

export type CheckoutObservation = Readonly<{
  label: string;
  exists: boolean;
  head: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  headCommittedAtMs: number | null;
  /** Porcelain XY code per path, bounded to MAX_DIRTY_PATHS. */
  dirty: ReadonlyArray<Readonly<{ code: string; path: string }>>;
  dirtyTotal: number;
  newestDirtyMtimeMs: number | null;
  /** size:mtime per dirty path; feeds the fingerprint only. */
  dirtyStamps: readonly string[];
  error: string | null;
}>;

export type TargetObservation = Readonly<{
  fingerprint: string;
  estimatedActivityAtMs: number | null;
  checkouts: readonly CheckoutObservation[];
}>;

export async function observeTarget(
  target: ActivityTarget,
  record: ActivityRecord | null,
): Promise<TargetObservation> {
  const checkouts = await Promise.all(target.checkouts.map(observeCheckout));
  const eventTimes = (record?.events ?? []).map((event) =>
    Date.parse(event.at),
  );
  const times = [
    ...checkouts.flatMap((checkout) => [
      checkout.headCommittedAtMs,
      checkout.newestDirtyMtimeMs,
    ]),
    ...eventTimes,
  ].filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );

  return {
    fingerprint: fingerprintOf(target, checkouts, record),
    estimatedActivityAtMs: times.length > 0 ? Math.max(...times) : null,
    checkouts,
  };
}

/**
 * The fingerprint covers Git state, lifecycle (checkouts, tasks, description)
 * and explicit inputs (purpose, pin-independent handoff events). Generated
 * digest fields and observation timestamps are deliberately excluded so
 * writing a digest can never look like new activity.
 */
function fingerprintOf(
  target: ActivityTarget,
  checkouts: readonly CheckoutObservation[],
  record: ActivityRecord | null,
): string {
  const payload = {
    description: target.description,
    tasks: target.tasks,
    checkouts: checkouts.map((checkout) => ({
      label: checkout.label,
      exists: checkout.exists,
      head: checkout.head,
      branch: checkout.branch,
      upstream: checkout.upstream,
      ahead: checkout.ahead,
      behind: checkout.behind,
      dirty: checkout.dirty,
      dirtyTotal: checkout.dirtyTotal,
      stamps: checkout.dirtyStamps,
      error: checkout.error !== null,
    })),
    purpose: record?.user.purpose ?? null,
    events: (record?.events ?? []).map((event) => [
      event.at,
      event.source,
      event.summary,
      event.next,
    ]),
  };
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 32);
}

async function observeCheckout(
  checkout: ActivityCheckout,
): Promise<CheckoutObservation> {
  const base = {
    label: checkout.label,
    head: null,
    branch: null,
    upstream: null,
    ahead: null,
    behind: null,
    headCommittedAtMs: null,
    dirty: [],
    dirtyTotal: 0,
    newestDirtyMtimeMs: null,
    dirtyStamps: [],
  };
  try {
    await fs.access(checkout.path);
  } catch {
    return { ...base, exists: false, error: null };
  }

  try {
    const [status, log] = await Promise.all([
      git(checkout.path, [
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=all",
      ]),
      git(checkout.path, ["log", "-1", "--format=%ct"]).catch(() => ""),
    ]);
    const parsed = parsePorcelainV2(status);
    const bounded = parsed.entries.slice(0, MAX_DIRTY_PATHS);
    const stamps = await Promise.all(
      bounded.map(async (entry) => {
        try {
          const stat = await fs.stat(path.join(checkout.path, entry.path));
          return { stamp: `${stat.size}:${stat.mtimeMs}`, mtime: stat.mtimeMs };
        } catch {
          return { stamp: "gone", mtime: null };
        }
      }),
    );
    const mtimes = stamps
      .map((stamp) => stamp.mtime)
      .filter((value): value is number => value !== null);
    const committed = Number(log.trim()) * 1000;
    return {
      ...base,
      exists: true,
      head: parsed.head,
      branch: parsed.branch,
      upstream: parsed.upstream,
      ahead: parsed.ahead,
      behind: parsed.behind,
      headCommittedAtMs:
        Number.isFinite(committed) && committed > 0 ? committed : null,
      dirty: bounded,
      dirtyTotal: parsed.entries.length,
      newestDirtyMtimeMs: mtimes.length > 0 ? Math.max(...mtimes) : null,
      dirtyStamps: stamps.map((stamp) => stamp.stamp),
      error: null,
    };
  } catch (error) {
    return {
      ...base,
      exists: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(["--no-optional-locks", ...args], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
  });
  return result.stdout;
}

type ParsedStatus = {
  head: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  entries: Array<{ code: string; path: string }>;
};

export function parsePorcelainV2(output: string): ParsedStatus {
  const result: ParsedStatus = {
    head: null,
    branch: null,
    upstream: null,
    ahead: null,
    behind: null,
    entries: [],
  };
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length === 0) continue;
    if (record.startsWith("# ")) {
      const [, key, ...rest] = record.split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid")
        result.head = value === "(initial)" ? null : value;
      if (key === "branch.head") {
        result.branch = value === "(detached)" ? null : value;
      }
      if (key === "branch.upstream") result.upstream = value;
      if (key === "branch.ab") {
        const match = value.match(/^\+(\d+) -(\d+)$/);
        if (match) {
          result.ahead = Number(match[1]);
          result.behind = Number(match[2]);
        }
      }
      continue;
    }
    const kind = record[0];
    if (kind === "1") {
      const fields = record.split(" ");
      result.entries.push({
        code: fields[1] ?? "",
        path: fields.slice(8).join(" "),
      });
    } else if (kind === "2") {
      const fields = record.split(" ");
      result.entries.push({
        code: fields[1] ?? "",
        path: fields.slice(9).join(" "),
      });
      index += 1; // Skip the rename/copy source path.
    } else if (kind === "u") {
      const fields = record.split(" ");
      result.entries.push({ code: "UU", path: fields.slice(10).join(" ") });
    } else if (kind === "?") {
      result.entries.push({ code: "??", path: record.slice(2) });
    }
  }
  return result;
}
