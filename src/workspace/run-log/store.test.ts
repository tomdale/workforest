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

describe("run store", () => {
  it("creates sortable run ids", () => {
    const earlier = createRunId(new Date("2026-07-03T10:00:00Z"));
    const later = createRunId(new Date("2026-07-03T10:00:01Z"));
    expect(earlier < later).toBe(true);
    expect(earlier).toMatch(/^\d{8}-\d{6}-[a-z0-9]{6}$/);
  });

  it("creates run dirs, tracks the current run, and lists newest first", async () => {
    const scope = await createScope();
    const first = createRunId(new Date("2026-07-03T10:00:00Z"));
    const second = createRunId(new Date("2026-07-03T11:00:00Z"));
    await createRunDir(scope, manifest(first, "2026-07-03T10:00:00Z"));
    await createRunDir(scope, manifest(second, "2026-07-03T11:00:00Z"));

    const runs = await listRuns(scope);
    expect(runs.map((run) => run.runId)).toEqual([second, first]);

    const lastDir = await resolveRunDir(scope, "last");
    expect(lastDir).toBe(getRunDir(scope, second));
  });

  it("resolves run ids exactly and by unique prefix", async () => {
    const scope = await createScope();
    const runId = createRunId(new Date("2026-07-03T10:00:00Z"));
    await createRunDir(scope, manifest(runId, "2026-07-03T10:00:00Z"));

    expect(await resolveRunDir(scope, runId)).toBe(getRunDir(scope, runId));
    expect(await resolveRunDir(scope, runId.slice(0, 10))).toBe(
      getRunDir(scope, runId),
    );
    expect(await resolveRunDir(scope, "20990101")).toBeNull();
  });

  it("rejects ambiguous run id prefixes", async () => {
    const scope = await createScope();
    const first = createRunId(new Date("2026-07-03T10:00:00Z"));
    const second = createRunId(new Date("2026-07-03T10:00:00Z"));
    await createRunDir(scope, manifest(first, "2026-07-03T10:00:00Z"));
    await createRunDir(scope, manifest(second, "2026-07-03T10:00:00Z"));

    await expect(resolveRunDir(scope, "20260703")).rejects.toThrow(
      /matches 2 runs/,
    );
  });

  it("prunes runs beyond the retention count, keeping the named run", async () => {
    const scope = await createScope();
    const ids: string[] = [];
    for (let hour = 0; hour < 7; hour += 1) {
      const startedAt = `2026-07-03T0${hour}:00:00Z`;
      const runId = createRunId(new Date(startedAt));
      ids.push(runId);
      await createRunDir(scope, manifest(runId, startedAt));
    }

    await pruneRuns(scope, { keep: 3, maxAgeDays: 365 });
    const remaining = (await listRuns(scope)).map((run) => run.runId);
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
    const runId = createRunId();
    const runDir = await createRunDir(
      scope,
      manifest(runId, "2026-07-03T10:00:00Z"),
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
