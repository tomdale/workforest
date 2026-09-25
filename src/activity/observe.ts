import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runGit } from "../services/git.ts";
import type { ActivityCheckout, ActivityTarget } from "./targets.ts";
import type { ActivityInputs } from "./types.ts";

/**
 * Cheap, bounded activity detection. Each checkout costs three Git commands:
 * `status --porcelain=v2 --branch` (ignored files are excluded by Git), a
 * `for-each-ref` to find the shared baseline, and one bounded `log` of
 * commits beyond it. Dirty paths are additionally `stat`ed so a repeated
 * edit to an already-dirty file changes the fingerprint. Nothing recurses
 * the tree beyond what Git reports, and `--no-optional-locks` keeps detection
 * from refreshing the index (which would otherwise look like activity).
 */
const MAX_DIRTY_PATHS = 200;
const MAX_OWN_COMMITS_COUNTED = 50;
const GIT_TIMEOUT_MS = 15_000;
/** Shared-history candidates, most specific first. */
const BASELINE_REFS = [
  "refs/remotes/origin/HEAD",
  "refs/remotes/origin/main",
  "refs/remotes/origin/master",
  "refs/heads/main",
  "refs/heads/master",
] as const;

export type CheckoutObservation = Readonly<{
  label: string;
  exists: boolean;
  head: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  /**
   * Full ref of the shared baseline (the default branch), or
   * `null` when none could be resolved. Commits reachable from it are shared
   * history, not this checkout's work.
   */
  baseline: string | null;
  /** Commits in `baseline..HEAD`, capped; `null` when baseline is unknown. */
  ownCommits: number | null;
  newestOwnCommitAtMs: number | null;
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
  inputsRevision: number;
  hasEvidence: boolean;
  captureStartedAtMs: number;
  estimatedActivityAtMs: number | null;
  checkouts: readonly CheckoutObservation[];
}>;

export async function observeTarget(
  target: ActivityTarget,
  inputs: ActivityInputs,
  captureStartedAtMs: number,
): Promise<TargetObservation> {
  const checkouts = await Promise.all(target.checkouts.map(observeCheckout));
  const times = [
    ...checkouts.flatMap((checkout) => [
      checkout.newestOwnCommitAtMs,
      checkout.newestDirtyMtimeMs,
    ]),
    inputs.activityAt ? Date.parse(inputs.activityAt) : null,
  ].filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  const hasEvidence =
    inputs.purpose !== null ||
    inputs.events.length > 0 ||
    checkouts.some(
      (checkout) => checkout.dirtyTotal > 0 || (checkout.ownCommits ?? 0) > 0,
    );

  return {
    fingerprint: fingerprintOf(target, checkouts, inputs),
    inputsRevision: inputs.revision,
    hasEvidence,
    captureStartedAtMs,
    estimatedActivityAtMs: times.length > 0 ? Math.max(...times) : null,
    checkouts,
  };
}

/**
 * The fingerprint covers Git state, lifecycle (checkouts, tasks, description)
 * and explicit inputs (purpose and handoff notes; pins only affect
 * scheduling). The baseline commit is excluded so fetching upstream does not
 * look like local activity. Digest fields and timestamps are excluded so
 * writing a digest can never look like new activity.
 */
function fingerprintOf(
  target: ActivityTarget,
  checkouts: readonly CheckoutObservation[],
  inputs: ActivityInputs,
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
    purpose: inputs.purpose,
    events: inputs.events.map((event) => [
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
    baseline: null,
    ownCommits: null,
    newestOwnCommitAtMs: null,
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
    const [status, refs] = await Promise.all([
      git(checkout.path, [
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=all",
      ]),
      git(checkout.path, [
        "for-each-ref",
        "--format=%(refname)",
        ...BASELINE_REFS,
      ]).catch(() => ""),
    ]);
    const parsed = parsePorcelainV2(status);
    const available = new Set(refs.split("\n").filter(Boolean));
    const baseline = BASELINE_REFS.find((ref) => available.has(ref)) ?? null;
    let ownCommits: number | null = null;
    let newestOwnCommitAtMs: number | null = null;
    if (baseline && parsed.head) {
      const log = await git(checkout.path, [
        "log",
        `-${MAX_OWN_COMMITS_COUNTED}`,
        "--format=%ct",
        `${baseline}..${parsed.head}`,
      ]).catch(() => null);
      if (log !== null) {
        const times = log.split("\n").filter(Boolean).map(Number);
        ownCommits = times.length;
        newestOwnCommitAtMs =
          times.length > 0 ? Math.max(...times) * 1000 : null;
      }
    }
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
    return {
      ...base,
      exists: true,
      head: parsed.head,
      branch: parsed.branch,
      upstream: parsed.upstream,
      ahead: parsed.ahead,
      behind: parsed.behind,
      baseline,
      ownCommits,
      newestOwnCommitAtMs,
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
