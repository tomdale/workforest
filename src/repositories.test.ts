import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  RegisteredRepositoryNameCollisionError,
  resolveRegisteredRepository,
} from "./repositories.ts";

const execFileAsync = promisify(execFile);
const ORIGINAL_CACHE_DIR = process.env["WORKFOREST_CACHE_DIR"];
const tempDirs: string[] = [];

async function createCacheDir(): Promise<string> {
  const cacheDir = await mkdtemp(
    path.join(os.tmpdir(), "workforest-repositories-"),
  );
  tempDirs.push(cacheDir);
  process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
  return cacheDir;
}

async function createMirror(
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
  if (ORIGINAL_CACHE_DIR === undefined) {
    delete process.env["WORKFOREST_CACHE_DIR"];
  } else {
    process.env["WORKFOREST_CACHE_DIR"] = ORIGINAL_CACHE_DIR;
  }

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("registered repositories", () => {
  it("resolves a unique repository name from cached mirrors", async () => {
    const cacheDir = await createCacheDir();
    await createMirror(
      cacheDir,
      "myapp.git",
      "git@github.com:mycompany/myapp.git",
    );

    await expect(resolveRegisteredRepository("myapp")).resolves.toBe(
      "mycompany/myapp",
    );
  });

  it("returns null for an unseen repository name", async () => {
    await createCacheDir();

    await expect(resolveRegisteredRepository("myapp")).resolves.toBeNull();
  });

  it("rejects names registered under multiple organizations", async () => {
    const cacheDir = await createCacheDir();
    await createMirror(cacheDir, "myapp.git", "git@github.com:first/myapp.git");
    await createMirror(
      cacheDir,
      "second-myapp.git",
      "https://github.com/second/myapp",
    );

    await expect(resolveRegisteredRepository("myapp")).rejects.toEqual(
      new RegisteredRepositoryNameCollisionError("myapp", [
        "first/myapp",
        "second/myapp",
      ]),
    );
  });

  it("ignores cached repositories hosted outside GitHub", async () => {
    const cacheDir = await createCacheDir();
    await createMirror(
      cacheDir,
      "myapp.git",
      "git@gitlab.com:mycompany/myapp.git",
    );

    await expect(resolveRegisteredRepository("myapp")).resolves.toBeNull();
  });
});
