import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathExists } from "@wf-plugin/core";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceInitializationScope } from "../initialization-scope.ts";
import type { RunManifest } from "./events.ts";
import {
  createRunDir,
  createRunId,
  getRunDir,
  listRuns,
  pruneRuns,
  resolveRunDir,
} from "./store.ts";

const tempDirs: string[] = [];

async function createScope() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workforest-runs-"));
  tempDirs.push(dir);
  return workspaceInitializationScope(dir);
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function manifest(runId: string, startedAt: string): RunManifest {
  return {
    v: 1,
    runId,
    startedAt,
    command: "new",
    repos: ["api"],
    scopeKind: "workspace",
  };
}

/** Recent wall-clock times so createRunDir's default age retention keeps them. */
function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

describe("run store", () => {
  it("creates sortable run ids", () => {
    const earlier = createRunId(hoursAgo(2));
    const later = createRunId(hoursAgo(1));
    expect(earlier < later).toBe(true);
    expect(earlier).toMatch(/^\d{8}-\d{6}-[a-z0-9]{6}$/);
  });

  it("creates run dirs, tracks the current run, and lists newest first", async () => {
    const scope = await createScope();
    const firstStarted = hoursAgo(2);
    const secondStarted = hoursAgo(1);
    const first = createRunId(firstStarted);
    const second = createRunId(secondStarted);
    await createRunDir(scope, manifest(first, firstStarted.toISOString()));
    await createRunDir(scope, manifest(second, secondStarted.toISOString()));

    const runs = await listRuns(scope);
    expect(runs.map((run) => run.runId)).toEqual([second, first]);

    const lastDir = await resolveRunDir(scope, "last");
    expect(lastDir).toBe(getRunDir(scope, second));
  });

  it("resolves run ids exactly and by unique prefix", async () => {
    const scope = await createScope();
    const startedAt = hoursAgo(1);
    const runId = createRunId(startedAt);
    await createRunDir(scope, manifest(runId, startedAt.toISOString()));

    expect(await resolveRunDir(scope, runId)).toBe(getRunDir(scope, runId));
    expect(await resolveRunDir(scope, runId.slice(0, 10))).toBe(
      getRunDir(scope, runId),
    );
    expect(await resolveRunDir(scope, "20990101")).toBeNull();
  });

  it("rejects ambiguous run id prefixes", async () => {
    const scope = await createScope();
    // Same second so both ids share a long common prefix.
    const startedAt = hoursAgo(1);
    const first = createRunId(startedAt);
    const second = createRunId(startedAt);
    await createRunDir(scope, manifest(first, startedAt.toISOString()));
    await createRunDir(scope, manifest(second, startedAt.toISOString()));

    const sharedPrefix = first.slice(0, 15); // YYYYMMDD-HHMMSS
    expect(second.startsWith(sharedPrefix)).toBe(true);
    await expect(resolveRunDir(scope, sharedPrefix)).rejects.toThrow(
      /matches 2 runs/,
    );
  });

  it("prunes runs beyond the retention count, keeping the named run", async () => {
    const scope = await createScope();
    const ids: string[] = [];
    for (let hour = 6; hour >= 0; hour -= 1) {
      const startedAt = hoursAgo(hour);
      const runId = createRunId(startedAt);
      ids.push(runId);
      await createRunDir(scope, manifest(runId, startedAt.toISOString()));
    }

    await pruneRuns(scope, { keep: 3, maxAgeDays: 365 });
    const remaining = (await listRuns(scope)).map((run) => run.runId);
    // ids is oldest→newest; listRuns is newest-first, keep 3 newest.
    expect(remaining).toEqual([...ids].reverse().slice(0, 3));
  });

  it("prunes runs older than the age limit even within the count", async () => {
    const scope = await createScope();
    const oldId = createRunId(new Date("2020-01-01T00:00:00Z"));
    const newId = createRunId();
    await createRunDir(scope, manifest(oldId, "2020-01-01T00:00:00Z"));
    await createRunDir(scope, manifest(newId, new Date().toISOString()));

    await pruneRuns(scope, { keep: 5, maxAgeDays: 14 });
    const remaining = (await listRuns(scope)).map((run) => run.runId);
    expect(remaining).toEqual([newId]);
    expect(await pathExists(getRunDir(scope, oldId))).toBe(false);
  });

  it("refuses run ids that do not match the id shape", () => {
    const scope = workspaceInitializationScope("/tmp/nowhere");
    expect(() => getRunDir(scope, "../escape")).toThrow(/Invalid run id/);
  });

  it("records the manifest contents it was given", async () => {
    const scope = await createScope();
    const startedAt = hoursAgo(1);
    const runId = createRunId(startedAt);
    const runDir = await createRunDir(
      scope,
      manifest(runId, startedAt.toISOString()),
    );

    const raw = JSON.parse(
      await readFile(path.join(runDir, "manifest.json"), "utf8"),
    ) as RunManifest;
    expect(raw).toMatchObject({
      v: 1,
      runId,
      command: "new",
      repos: ["api"],
      scopeKind: "workspace",
    });
  });
});
