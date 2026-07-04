import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "@wf-plugin/core";
import { resolveContainedPath } from "../../utils/path-safety.ts";
import {
  getInitializationStateDir,
  type InitializationScope,
} from "../initialization-scope.ts";
import type { RunManifest, RunScopeKind } from "./events.ts";

const RUNS_DIRNAME = "runs";
const CURRENT_RUN_FILENAME = "current-run";
const MANIFEST_FILENAME = "manifest.json";
const RUN_ID_PATTERN = /^[0-9]{8}-[0-9]{6}-[a-z0-9]{6}$/;

/**
 * Retention for persisted run logs: successful runs are kept on purpose so
 * they can be inspected after the fact, bounded by count and age.
 */
export const RUN_RETENTION = {
  keep: 5,
  maxAgeDays: 14,
} as const;

export type RunRetentionPolicy = {
  keep?: number;
  maxAgeDays?: number;
};

export function getRunsDir(scope: InitializationScope): string {
  return path.join(getInitializationStateDir(scope), RUNS_DIRNAME);
}

export function getRunDir(scope: InitializationScope, runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Invalid run id: ${runId}`);
  }
  return resolveContainedPath(getRunsDir(scope), runId);
}

/**
 * Run ids sort chronologically as plain strings: a UTC timestamp prefix
 * plus a random suffix to disambiguate runs started in the same second.
 */
export function createRunId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15);
  const suffix = randomBytes(4).toString("hex").slice(0, 6);
  return `${stamp}-${suffix}`;
}

export function runScopeKind(scope: InitializationScope): RunScopeKind {
  return scope.kind;
}

export async function createRunDir(
  scope: InitializationScope,
  manifest: RunManifest,
): Promise<string> {
  const runDir = getRunDir(scope, manifest.runId);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(
    path.join(runDir, MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(getRunsDir(scope), CURRENT_RUN_FILENAME),
    `${manifest.runId}\n`,
    "utf8",
  );
  await pruneRuns(scope, RUN_RETENTION, { keepRunId: manifest.runId });
  return runDir;
}

export async function readRunManifest(
  runDir: string,
): Promise<RunManifest | null> {
  try {
    const raw = await fs.readFile(path.join(runDir, MANIFEST_FILENAME), "utf8");
    const value = JSON.parse(raw) as RunManifest;
    if (value.v !== 1 || typeof value.runId !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

/** List run manifests for a scope, newest first. */
export async function listRuns(
  scope: InitializationScope,
): Promise<RunManifest[]> {
  const runsDir = getRunsDir(scope);
  let entries: string[];
  try {
    entries = await fs.readdir(runsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const manifests = await Promise.all(
    entries
      .filter((entry) => RUN_ID_PATTERN.test(entry))
      .map((entry) => readRunManifest(path.join(runsDir, entry))),
  );

  return manifests
    .filter((manifest): manifest is RunManifest => manifest !== null)
    .sort((a, b) => (a.runId > b.runId ? -1 : 1));
}

/**
 * Resolve a run selector to its run directory. "last" resolves to the most
 * recent run; anything else matches a run id exactly or by unique prefix.
 * Returns null when no run matches; throws when a prefix is ambiguous.
 */
export async function resolveRunDir(
  scope: InitializationScope,
  selector: "last" | string,
): Promise<string | null> {
  if (selector === "last") {
    const currentPath = path.join(getRunsDir(scope), CURRENT_RUN_FILENAME);
    try {
      const runId = (await fs.readFile(currentPath, "utf8")).trim();
      if (RUN_ID_PATTERN.test(runId)) {
        const runDir = getRunDir(scope, runId);
        if (await pathExists(runDir)) return runDir;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const runs = await listRuns(scope);
    const newest = runs[0];
    return newest ? getRunDir(scope, newest.runId) : null;
  }

  const runs = await listRuns(scope);
  const exact = runs.find((run) => run.runId === selector);
  if (exact) return getRunDir(scope, exact.runId);

  const matches = runs.filter((run) => run.runId.startsWith(selector));
  if (matches.length === 0) return null;
  const first = matches[0];
  if (matches.length > 1 || !first) {
    throw new Error(
      `Run id prefix "${selector}" matches ${matches.length} runs: ${matches
        .map((run) => run.runId)
        .join(", ")}`,
    );
  }
  return getRunDir(scope, first.runId);
}

/**
 * Delete run directories beyond the retention window. The newest `keep`
 * runs survive unless they are older than `maxAgeDays`; the run named by
 * `keepRunId` (typically the one just created) always survives.
 */
export async function pruneRuns(
  scope: InitializationScope,
  policy: RunRetentionPolicy = RUN_RETENTION,
  { keepRunId }: { keepRunId?: string } = {},
): Promise<void> {
  const keep = policy.keep ?? RUN_RETENTION.keep;
  const maxAgeDays = policy.maxAgeDays ?? RUN_RETENTION.maxAgeDays;
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const runs = await listRuns(scope);

  await Promise.all(
    runs.map(async (run, index) => {
      if (run.runId === keepRunId) return;
      const startedAtMs = Date.parse(run.startedAt);
      const tooOld = Number.isFinite(startedAtMs) && startedAtMs < cutoffMs;
      if (index < keep && !tooOld) return;
      await fs.rm(getRunDir(scope, run.runId), {
        recursive: true,
        force: true,
      });
    }),
  );
}
