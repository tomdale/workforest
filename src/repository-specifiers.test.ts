import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  qualifyRepositorySpecifiers,
  resolveRepositoryOrTemplateSpecifiers,
  resolveRepositorySpecifiers,
} from "./repository-specifiers.ts";
import { createTemplate } from "./templates/index.ts";

const execFileAsync = promisify(execFile);
const originalCacheDir = process.env["WORKFOREST_CACHE_DIR"];
const originalXdgConfigHome = process.env["XDG_CONFIG_HOME"];
const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

async function createCachedMirror(
  cacheDir: string,
  directoryName: string,
  remote: string,
): Promise<void> {
  const mirrorDir = path.join(cacheDir, directoryName);
  await mkdir(mirrorDir, { recursive: true });
  await execFileAsync("git", ["init", "--bare", "--quiet"], {
    cwd: mirrorDir,
  });
  await execFileAsync("git", ["remote", "add", "origin", remote], {
    cwd: mirrorDir,
  });
}

afterEach(async () => {
  if (originalCacheDir === undefined) {
    delete process.env["WORKFOREST_CACHE_DIR"];
  } else {
    process.env["WORKFOREST_CACHE_DIR"] = originalCacheDir;
  }
  if (originalXdgConfigHome === undefined) {
    delete process.env["XDG_CONFIG_HOME"];
  } else {
    process.env["XDG_CONFIG_HOME"] = originalXdgConfigHome;
  }

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("repository specifiers", () => {
  it("qualifies cached repository names alongside explicit references", async () => {
    const cacheDir = await createTempDir("workforest-cache-");
    process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
    await createCachedMirror(
      cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );

    await expect(
      qualifyRepositorySpecifiers(["front", "vercel/api"]),
    ).resolves.toEqual(["vercel/front", "vercel/api"]);
  });

  it("qualifies cached names stored in templates", async () => {
    const cacheDir = await createTempDir("workforest-cache-");
    const xdgConfigHome = await createTempDir("workforest-xdg-");
    process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;
    await createCachedMirror(
      cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );
    await createTemplate("site", {
      repos: ["front"],
      branchPrefix: "site/",
    });

    await expect(
      resolveRepositoryOrTemplateSpecifiers(["site"]),
    ).resolves.toEqual({
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
        },
      ],
      templateId: "site",
      templateBranchPrefix: "site/",
    });
  });

  it("explains how to qualify unknown repository names", async () => {
    const cacheDir = await createTempDir("workforest-cache-");
    process.env["WORKFOREST_CACHE_DIR"] = cacheDir;

    await expect(resolveRepositorySpecifiers(["missing"])).rejects.toThrow(
      'Unknown repository "missing". Expected "org/repo", a git URL, or a unique cached repository name.',
    );
  });
});
