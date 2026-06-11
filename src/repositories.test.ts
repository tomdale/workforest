import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanCachedRepositories,
  deleteCachedRepository,
  listCachedRepositories,
  RegisteredRepositoryNameCollisionError,
  resolveCachedRepository,
  resolveMirrorDir,
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

describe("cached repository inventory", () => {
  it("reports identity, size, health, and worktrees", async () => {
    const cacheDir = await createCacheDir();
    await createMirror(
      cacheDir,
      "myapp.git",
      "git@github.com:mycompany/myapp.git",
    );

    const repositories = await listCachedRepositories();

    expect(repositories).toHaveLength(1);
    expect(repositories[0]).toMatchObject({
      name: "myapp",
      slug: "mycompany/myapp",
      remote: "git@github.com:mycompany/myapp.git",
      directoryName: "myapp.git",
      health: "healthy",
      issues: [],
      worktrees: [],
    });
    expect(repositories[0]?.sizeBytes).toBeGreaterThanOrEqual(0);
    expect(repositories[0]?.lastFetchedAt).toBeInstanceOf(Date);
  });

  it("keeps invalid cache directories visible for cleanup", async () => {
    const cacheDir = await createCacheDir();
    const invalidDir = path.join(cacheDir, "broken.git");
    await mkdir(invalidDir);
    await writeFile(path.join(invalidDir, "README"), "not git\n", "utf8");

    const repositories = await listCachedRepositories();

    expect(repositories).toEqual([
      expect.objectContaining({
        name: "broken",
        mirrorPath: invalidDir,
        health: "invalid",
        issues: ["Unreadable or invalid Git repository"],
      }),
    ]);
  });

  it("keeps cache entries with non-repository component names visible", async () => {
    const cacheDir = await createCacheDir();
    const invalidDir = path.join(cacheDir, "-old mirror.git");
    await mkdir(invalidDir);

    const repositories = await listCachedRepositories();

    expect(repositories).toEqual([
      expect.objectContaining({
        name: "-old mirror",
        mirrorPath: invalidDir,
        health: "invalid",
      }),
    ]);
  });

  it("resolves repositories by slug, name, and cache directory", async () => {
    const cacheDir = await createCacheDir();
    await createMirror(
      cacheDir,
      "myapp.git",
      "git@github.com:mycompany/myapp.git",
    );
    const repositories = await listCachedRepositories();

    await expect(
      resolveCachedRepository("mycompany/myapp", repositories),
    ).resolves.toMatchObject({ directoryName: "myapp.git" });
    await expect(
      resolveCachedRepository("myapp", repositories),
    ).resolves.toMatchObject({ directoryName: "myapp.git" });
    await expect(
      resolveCachedRepository("myapp.git", repositories),
    ).resolves.toMatchObject({ directoryName: "myapp.git" });
    await expect(
      resolveCachedRepository(path.join(cacheDir, "myapp.git"), repositories),
    ).resolves.toMatchObject({ slug: "mycompany/myapp" });
  });

  it("requires a slug or explicit .git directory when names collide", async () => {
    const cacheDir = await createCacheDir();
    await createMirror(cacheDir, "myapp.git", "git@github.com:first/myapp.git");
    await createMirror(
      cacheDir,
      "second--myapp.git",
      "git@github.com:second/myapp.git",
    );
    const repositories = await listCachedRepositories();

    await expect(
      resolveCachedRepository("myapp", repositories),
    ).rejects.toThrow('Cached repository "myapp" is ambiguous');
    await expect(
      resolveCachedRepository("myapp.git", repositories),
    ).resolves.toMatchObject({ slug: "first/myapp" });
  });

  it("uses owner-qualified mirror paths for same-name repositories", async () => {
    const cacheDir = await createCacheDir();
    await createMirror(cacheDir, "myapp.git", "git@github.com:first/myapp.git");

    await expect(
      resolveMirrorDir(
        {
          name: "myapp",
          remote: "git@github.com:second/myapp.git",
          defaultBranch: "main",
        },
        cacheDir,
      ),
    ).resolves.toBe(path.join(cacheDir, "second--myapp.git"));
  });

  it("deletes unused mirrors during clean", async () => {
    const cacheDir = await createCacheDir();
    await createMirror(
      cacheDir,
      "unused.git",
      "git@github.com:mycompany/unused.git",
    );

    const results = await cleanCachedRepositories();

    expect(results.map((result) => result.repository.name)).toContain("unused");
    await expect(stat(path.join(cacheDir, "unused.git"))).rejects.toThrow();
  });

  it("requires force before deleting mirrors with active worktrees", async () => {
    const cacheDir = await createCacheDir();
    const mirrorPath = path.join(cacheDir, "myapp.git");
    await mkdir(mirrorPath);
    const repository = {
      name: "myapp",
      slug: "mycompany/myapp",
      remote: "git@github.com:mycompany/myapp.git",
      mirrorPath,
      directoryName: "myapp.git",
      defaultBranch: "main",
      sizeBytes: 0,
      lastFetchedAt: null,
      worktrees: [
        {
          path: "/tmp/myapp",
          branch: "main",
          detached: false,
          prunable: false,
          exists: true,
        },
      ],
      health: "healthy" as const,
      issues: [],
    };

    await expect(deleteCachedRepository(repository)).rejects.toThrow(
      "has 1 active worktree",
    );
    await expect(
      deleteCachedRepository(repository, { force: true }),
    ).resolves.toMatchObject({ deleted: true });
  });

  it("refuses to delete a mirror outside the cache root", async () => {
    await createCacheDir();
    const outsideDir = await mkdtemp(
      path.join(os.tmpdir(), "workforest-outside-mirror-"),
    );
    tempDirs.push(outsideDir);
    const sentinel = path.join(outsideDir, "sentinel.txt");
    await writeFile(sentinel, "keep\n", "utf8");

    await expect(
      deleteCachedRepository({
        name: "outside",
        slug: null,
        remote: null,
        mirrorPath: outsideDir,
        directoryName: "outside.git",
        defaultBranch: null,
        sizeBytes: 0,
        lastFetchedAt: null,
        worktrees: [],
        health: "invalid",
        issues: [],
      }),
    ).rejects.toThrow("must be a direct child");

    await expect(stat(sentinel)).resolves.toBeDefined();
  });

  it("refuses to delete the cache root", async () => {
    const cacheDir = await createCacheDir();
    const sentinel = path.join(cacheDir, "sentinel.txt");
    await writeFile(sentinel, "keep\n", "utf8");

    await expect(
      deleteCachedRepository({
        name: "cache-root",
        slug: null,
        remote: null,
        mirrorPath: cacheDir,
        directoryName: path.basename(cacheDir),
        defaultBranch: null,
        sizeBytes: 0,
        lastFetchedAt: null,
        worktrees: [],
        health: "invalid",
        issues: [],
      }),
    ).rejects.toThrow("must be a direct child");

    await expect(stat(sentinel)).resolves.toBeDefined();
  });

  it("refuses to delete a cache symlink that escapes the cache root", async () => {
    const cacheDir = await createCacheDir();
    const outsideDir = await mkdtemp(
      path.join(os.tmpdir(), "workforest-cache-symlink-"),
    );
    tempDirs.push(outsideDir);
    const sentinel = path.join(outsideDir, "sentinel.txt");
    await writeFile(sentinel, "keep\n", "utf8");
    const mirrorPath = path.join(cacheDir, "outside.git");
    await symlink(outsideDir, mirrorPath);

    await expect(
      deleteCachedRepository({
        name: "outside",
        slug: null,
        remote: null,
        mirrorPath,
        directoryName: "outside.git",
        defaultBranch: null,
        sizeBytes: 0,
        lastFetchedAt: null,
        worktrees: [],
        health: "invalid",
        issues: [],
      }),
    ).rejects.toThrow("must not be a symbolic link");

    await expect(stat(sentinel)).resolves.toBeDefined();
  });
});
