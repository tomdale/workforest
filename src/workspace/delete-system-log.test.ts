import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeleteSystemLogger } from "./delete-system-log.ts";

const originalCacheDir = process.env["WORKFOREST_CACHE_DIR"];
const tempDirs: string[] = [];

afterEach(async () => {
  if (originalCacheDir === undefined) {
    delete process.env["WORKFOREST_CACHE_DIR"];
  } else {
    process.env["WORKFOREST_CACHE_DIR"] = originalCacheDir;
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("delete system log", () => {
  it("records internal disposal events and removes logs older than 30 days", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "workforest-delete-log-"),
    );
    tempDirs.push(root);
    process.env["WORKFOREST_CACHE_DIR"] = root;
    const directory = path.join(root, "system-logs");
    await mkdir(directory, { recursive: true });
    const oldPath = path.join(directory, "delete-old.ndjson");
    await writeFile(oldPath, "old\n", "utf8");
    const oldTime = new Date("2020-01-01T00:00:00.000Z");
    await utimes(oldPath, oldTime, oldTime);

    const now = new Date("2020-02-01T00:00:01.000Z");
    await createDeleteSystemLogger(() => now).record({
      worktreePath: "/reviews/omniagent/pr-123",
      phase: "node-modules",
      status: "skipped",
      detail: "ineligible",
    });

    const logPath = path.join(directory, "delete-2020-02-01.ndjson");
    await expect(readFile(logPath, "utf8")).resolves.toContain('"ineligible"');
    await expect(readFile(oldPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
