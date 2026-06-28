import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runSubprocess } from "./test-utils/subprocess.ts";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("wf worktree", () => {
  it("runs the fixed add, list, move, and remove primitives", async () => {
    const fixture = await createFixture();
    const added = path.join(fixture.root, "added");
    const moved = path.join(fixture.root, "moved");
    const inferred = path.join(fixture.root, "inferred-branch");

    const add = await runWorktree(fixture.cacheDir, [
      "add",
      "front.git",
      added,
      "arbitrary-branch",
    ]);
    expect(add.exitCode).toBe(0);
    await expect(access(added)).resolves.toBeUndefined();

    const listed = await runWorktree(fixture.cacheDir, ["list", "front.git"]);
    const native = await runSubprocess("git", ["worktree", "list"], {
      cwd: fixture.mirrorDir,
    });
    expect(listed.exitCode).toBe(native.exitCode);
    expect(listed.stdout).toBe(native.stdout);
    expect(listed.stderr).toContain(native.stderr);

    const move = await runWorktree(fixture.cacheDir, [
      "move",
      "front.git",
      added,
      moved,
    ]);
    expect(move.exitCode).toBe(0);
    await expect(access(moved)).resolves.toBeUndefined();

    const remove = await runWorktree(fixture.cacheDir, [
      "remove",
      "front.git",
      moved,
    ]);
    expect(remove.exitCode).toBe(0);
    await expect(access(moved)).rejects.toMatchObject({ code: "ENOENT" });

    const inferredAdd = await runWorktree(fixture.cacheDir, [
      "add",
      "front.git",
      inferred,
    ]);
    expect(inferredAdd.exitCode).toBe(0);
    await expect(
      execFileAsync("git", ["branch", "--show-current"], { cwd: inferred }),
    ).resolves.toMatchObject({ stdout: "inferred-branch\n" });

    const inferredRemove = await runWorktree(fixture.cacheDir, [
      "remove",
      "front.git",
      inferred,
    ]);
    expect(inferredRemove.exitCode).toBe(0);
  }, 20_000);

  it("enforces each primitive's fixed operands and rejects flags", async () => {
    const fixture = await createFixture();

    for (const argv of [
      ["list"],
      ["list", "front.git", "extra"],
      ["add", "front.git"],
      ["move", "front.git", "path"],
      ["remove", "front.git"],
      ["list", "front.git", "--porcelain"],
      ["list", "front.git", "--json"],
    ]) {
      const result = await runWorktree(fixture.cacheDir, argv);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(
        /Invalid operands|Unknown flag|not supported/,
      );
    }
  });

  it("resolves relative worktree paths from the caller's directory", async () => {
    const fixture = await createFixture();

    const add = await runWorktree(
      fixture.cacheDir,
      ["add", "front.git", "relative", "relative-branch"],
      fixture.root,
    );
    expect(add.exitCode).toBe(0);
    await expect(
      access(path.join(fixture.root, "relative")),
    ).resolves.toBeUndefined();

    const move = await runWorktree(
      fixture.cacheDir,
      ["move", "front.git", "relative", "moved"],
      fixture.root,
    );
    expect(move.exitCode).toBe(0);
    await expect(
      access(path.join(fixture.root, "moved")),
    ).resolves.toBeUndefined();

    const remove = await runWorktree(
      fixture.cacheDir,
      ["remove", "front.git", "moved"],
      fixture.root,
    );
    expect(remove.exitCode).toBe(0);
    await expect(
      access(path.join(fixture.root, "moved")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 20_000);

  it("does not create or sync a missing cached mirror", async () => {
    const cacheDir = await tempDir("workforest-worktree-cache-");
    const result = await runWorktree(cacheDir, ["list", "missing"]);

    expect(result).toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr: expect.stringContaining("Cached repository not found: missing"),
    });
    await expect(
      access(path.join(cacheDir, "missing.git")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

async function createFixture(): Promise<{
  root: string;
  cacheDir: string;
  mirrorDir: string;
}> {
  const root = await tempDir("workforest-worktree-");
  const sourceDir = path.join(root, "source");
  const cacheDir = path.join(root, "cache");
  const mirrorDir = path.join(cacheDir, "front.git");

  await execFileAsync("git", ["init", "--quiet", sourceDir]);
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: sourceDir,
  });
  await execFileAsync("git", ["config", "user.name", "Test User"], {
    cwd: sourceDir,
  });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], {
    cwd: sourceDir,
  });
  await writeFile(path.join(sourceDir, "README.md"), "fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: sourceDir });
  await execFileAsync("git", ["commit", "--quiet", "-m", "initial"], {
    cwd: sourceDir,
  });
  await mkdir(cacheDir);
  await execFileAsync("git", [
    "clone",
    "--bare",
    "--quiet",
    sourceDir,
    mirrorDir,
  ]);

  return { root, cacheDir, mirrorDir };
}

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function runWorktree(cacheDir: string, args: readonly string[], cwd?: string) {
  return runSubprocess(
    process.execPath,
    [path.resolve("bin/workforest.js"), "cache", "worktree", ...args],
    {
      cwd,
      env: {
        ...process.env,
        NO_COLOR: "1",
        WORKFOREST_CACHE_DIR: cacheDir,
        WORKFOREST_USE_SOURCE_CLI: "1",
      },
    },
  );
}
