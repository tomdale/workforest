import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteNodeModulesCache,
  isPnpmInstallEnabled,
  listNodeModulesCacheEntries,
  preserveNodeModules,
  restoreNodeModules,
  summarizeNodeModulesCache,
} from "./node-modules-cache.ts";
import type { RepositorySource } from "./types.ts";

const ORIGINAL_CACHE_DIR = process.env["WORKFOREST_CACHE_DIR"];
const tempDirs: string[] = [];

const repo: RepositorySource = {
  name: "app",
  remote: "git@github.com:acme/app.git",
};

async function createTempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createPnpmRepo(root: string, name: string): Promise<string> {
  const repoDir = path.join(root, name);
  await mkdir(path.join(repoDir, "node_modules", ".pnpm"), {
    recursive: true,
  });
  await writeFile(path.join(repoDir, "pnpm-lock.yaml"), "lockfile\n", "utf8");
  await writeFile(
    path.join(repoDir, "node_modules", ".pnpm-lockfile-hash"),
    "hash\n",
    "utf8",
  );
  await writeFile(
    path.join(repoDir, "node_modules", ".pnpm", "package"),
    "contents\n",
    "utf8",
  );
  return repoDir;
}

afterEach(async () => {
  if (ORIGINAL_CACHE_DIR === undefined) {
    delete process.env["WORKFOREST_CACHE_DIR"];
  } else {
    process.env["WORKFOREST_CACHE_DIR"] = ORIGINAL_CACHE_DIR;
  }

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("node_modules cache", () => {
  it("preserves and restores the newest same-repo pnpm install", async () => {
    const root = await createTempRoot("workforest-node-modules-");
    process.env["WORKFOREST_CACHE_DIR"] = path.join(root, "cache");
    const first = await createPnpmRepo(root, "first");
    const second = await createPnpmRepo(root, "second");

    expect(await preserveNodeModules({ repo, repoDir: first })).toMatchObject({
      status: "preserved",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await preserveNodeModules({ repo, repoDir: second })).toMatchObject({
      status: "preserved",
    });

    const target = path.join(root, "target");
    await mkdir(target);
    await writeFile(path.join(target, "pnpm-lock.yaml"), "lockfile\n", "utf8");

    expect(await restoreNodeModules({ repo, repoDir: target })).toMatchObject({
      status: "restored",
    });
    await expect(
      readFile(path.join(target, "node_modules", ".pnpm", "package"), "utf8"),
    ).resolves.toBe("contents\n");

    const entries = await listNodeModulesCacheEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.metadata.sourcePath).toBe(
      path.join(first, "node_modules"),
    );
  });

  it("skips installs without the pnpm lockfile hash marker", async () => {
    const root = await createTempRoot("workforest-node-modules-");
    process.env["WORKFOREST_CACHE_DIR"] = path.join(root, "cache");
    const repoDir = await createPnpmRepo(root, "repo");
    await rm(path.join(repoDir, "node_modules", ".pnpm-lockfile-hash"));

    await expect(preserveNodeModules({ repo, repoDir })).resolves.toEqual({
      status: "ineligible",
    });
    await expect(listNodeModulesCacheEntries()).resolves.toEqual([]);
  });

  it("prunes older entries to the configured per-repo cap", async () => {
    const root = await createTempRoot("workforest-node-modules-");
    process.env["WORKFOREST_CACHE_DIR"] = path.join(root, "cache");

    for (const name of ["one", "two", "three"]) {
      const repoDir = await createPnpmRepo(root, name);
      expect(
        await preserveNodeModules({
          repo,
          repoDir,
          config: { maxRetainedPerRepo: 2 },
        }),
      ).toMatchObject({ status: "preserved" });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const entries = await listNodeModulesCacheEntries();
    expect(entries).toHaveLength(2);
    expect(
      entries.map((entry) => path.basename(entry.metadata.sourcePath)),
    ).toEqual(["node_modules", "node_modules"]);
    expect(
      entries.map((entry) =>
        path.basename(path.dirname(entry.metadata.sourcePath)),
      ),
    ).toEqual(["three", "two"]);
  });

  it("isolates entries by repository identity", async () => {
    const root = await createTempRoot("workforest-node-modules-");
    process.env["WORKFOREST_CACHE_DIR"] = path.join(root, "cache");
    const repoDir = await createPnpmRepo(root, "repo");
    await preserveNodeModules({ repo, repoDir });

    const otherRepo = {
      ...repo,
      remote: "git@github.com:acme/other.git",
    };
    const target = path.join(root, "target");
    await mkdir(target);
    await writeFile(path.join(target, "pnpm-lock.yaml"), "lockfile\n", "utf8");

    await expect(
      restoreNodeModules({ repo: otherRepo, repoDir: target }),
    ).resolves.toEqual({ status: "missing" });
  });

  it("deletes all pooled installs regardless of restore config", async () => {
    const root = await createTempRoot("workforest-node-modules-");
    process.env["WORKFOREST_CACHE_DIR"] = path.join(root, "cache");
    const repoDir = await createPnpmRepo(root, "repo");
    await preserveNodeModules({ repo, repoDir });
    const result = await deleteNodeModulesCache(false);

    expect(result.deleted).toHaveLength(1);
    expect((await summarizeNodeModulesCache()).entryCount).toBe(0);
  });

  it("detects when pnpm install is disabled", () => {
    expect(isPnpmInstallEnabled(undefined)).toBe(true);
    expect(isPnpmInstallEnabled(["vercel-link"])).toBe(true);
    expect(isPnpmInstallEnabled(["pnpm-install"])).toBe(false);
    expect(isPnpmInstallEnabled(true)).toBe(false);
  });
});
