import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActivityView } from "./activity/types.ts";
import { renderCommandResult } from "./cli/output.ts";
import { executeCli } from "./cli.ts";
import { writeWorktreeMetadata } from "./workspace/metadata.ts";

const ORIGINAL_ENV = {
  WORKFOREST_CONFIG_DIR: process.env["WORKFOREST_CONFIG_DIR"],
  WORKFOREST_CACHE_DIR: process.env["WORKFOREST_CACHE_DIR"],
  WORKFOREST_AI_DISABLED: process.env["WORKFOREST_AI_DISABLED"],
};
const tempDirs: string[] = [];

afterEach(async () => {
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createFixture(): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "workforest-activity-cli-"),
  );
  tempDirs.push(root);
  const base = path.join(root, "base");
  const configDir = path.join(root, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ directory: { base } }),
  );
  const repoRoot = path.join(base, "Repos", "widget");
  const worktree = path.join(repoRoot, "demo");
  await mkdir(worktree, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: worktree });
  await writeWorktreeMetadata(repoRoot, {
    featureName: "demo",
    repos: [
      {
        name: "widget",
        remote: "https://example.com/widget.git",
        hasLockfile: false,
      },
    ],
  });
  process.env["WORKFOREST_CONFIG_DIR"] = configDir;
  process.env["WORKFOREST_CACHE_DIR"] = path.join(root, "cache");
  process.env["WORKFOREST_AI_DISABLED"] = "1";
  return root;
}

async function runJson<T>(argv: string[]): Promise<T> {
  let stdout = "";
  renderCommandResult(await executeCli(argv), {
    stdout: (value) => {
      stdout += value;
    },
    stderr: () => {},
  });
  const parsed = JSON.parse(stdout) as { ok: boolean; data: T };
  expect(parsed.ok).toBe(true);
  return parsed.data;
}

describe("wf activity", () => {
  it("lists cached activity for every checkout without generating", async () => {
    await createFixture();

    const views = await runJson<ActivityView[]>(["activity", "list", "--json"]);

    expect(views).toEqual([
      expect.objectContaining({
        selector: "widget/demo",
        type: "worktree",
        freshness: "missing",
        generationState: "idle",
        latest: null,
      }),
    ]);
  });

  it("records explicit purpose, pins, and handoff notes", async () => {
    await createFixture();

    await runJson([
      "activity",
      "purpose",
      "widget/demo",
      "--set",
      "Ship it",
      "--json",
    ]);
    await runJson(["activity", "pin", "widget/demo", "--json"]);
    const view = await runJson<ActivityView>([
      "activity",
      "note",
      "widget/demo",
      "--source",
      "bb:thr_1",
      "--next",
      "Write docs",
      "--json",
    ]);

    expect(view).toMatchObject({
      purpose: "Ship it",
      purposeSource: "user",
      pinned: true,
      likelyNext: "Write docs",
      likelyNextBasis: "handoff",
    });
  });

  it("detects without inference when AI is disabled", async () => {
    await createFixture();

    const summary = await runJson<{ checked: number; generated: number }>([
      "activity",
      "sweep",
      "--json",
    ]);
    const status = await runJson<{
      inference: string;
      counts: { targets: number };
    }>(["activity", "status", "--json"]);

    expect(summary).toMatchObject({ checked: 1, generated: 0 });
    expect(status).toMatchObject({
      inference: "disabled",
      counts: { targets: 1 },
    });
  });

  it("requires exactly one purpose action", async () => {
    await createFixture();

    const result = await executeCli(["activity", "purpose", "widget/demo"]);

    expect(result.exitCode).not.toBe(0);
  });
});
