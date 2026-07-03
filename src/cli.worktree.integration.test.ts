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
    const options = { configDir: fixture.configDir };
    const added = path.join(fixture.root, "added");
    const moved = path.join(fixture.root, "moved");
    const detached = path.join(fixture.root, "detached");

    const add = await runWorktree(
      fixture.cacheDir,
      ["add", "front.git", added, "arbitrary-branch"],
      options,
    );
    expect(add.exitCode).toBe(0);
    await expect(access(added)).resolves.toBeUndefined();

    const listed = await runWorktree(
      fixture.cacheDir,
      ["list", "front.git"],
      options,
    );
    const native = await runSubprocess("git", ["worktree", "list"], {
      cwd: fixture.mirrorDir,
    });
    expect(listed.exitCode).toBe(native.exitCode);
    expect(listed.stdout).toBe(native.stdout);
    expect(listed.stderr).toContain(native.stderr);

    const move = await runWorktree(
      fixture.cacheDir,
      ["move", "front.git", added, moved],
      options,
    );
    expect(move.exitCode).toBe(0);
    await expect(access(moved)).resolves.toBeUndefined();

    const remove = await runWorktree(
      fixture.cacheDir,
      ["remove", "front.git", moved],
      options,
    );
    expect(remove.exitCode).toBe(0);
    await expect(access(moved)).rejects.toMatchObject({ code: "ENOENT" });

    // With no branch operand the primitive pins the mirror's default branch as
    // an explicit start-point, so `git worktree add <path> origin/<default>`
    // creates a *detached* worktree at that ref — not a branch named after the
    // directory, which the old start-point-less form produced.
    const detachedAdd = await runWorktree(
      fixture.cacheDir,
      ["add", "front.git", detached],
      options,
    );
    expect(detachedAdd.exitCode).toBe(0);
    await expect(
      execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: detached,
      }),
    ).resolves.toMatchObject({ stdout: "HEAD\n" });

    const detachedRemove = await runWorktree(
      fixture.cacheDir,
      ["remove", "front.git", detached],
      options,
    );
    expect(detachedRemove.exitCode).toBe(0);
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

    const options = { cwd: fixture.root, configDir: fixture.configDir };

    const add = await runWorktree(
      fixture.cacheDir,
      ["add", "front.git", "relative", "relative-branch"],
      options,
    );
    expect(add.exitCode).toBe(0);
    await expect(
      access(path.join(fixture.root, "relative")),
    ).resolves.toBeUndefined();

    const move = await runWorktree(
      fixture.cacheDir,
      ["move", "front.git", "relative", "moved"],
      options,
    );
    expect(move.exitCode).toBe(0);
    await expect(
      access(path.join(fixture.root, "moved")),
    ).resolves.toBeUndefined();

    const remove = await runWorktree(
      fixture.cacheDir,
      ["remove", "front.git", "moved"],
      options,
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

  it("refuses raw worktree ops inside managed Workforest directories", async () => {
    const fixture = await createFixture();
    const managed = path.join(
      fixture.managedBase,
      "Repos",
      "front",
      "fix-auth",
    );

    const result = await runWorktree(
      fixture.cacheDir,
      ["add", "front.git", managed, "fix-auth"],
      { configDir: fixture.configDir },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Refusing to run a raw cache worktree op inside a managed Workforest directory",
    );
    // The guard refuses before touching git, so nothing is created on disk.
    await expect(access(managed)).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);
});

async function createFixture(): Promise<{
  root: string;
  cacheDir: string;
  mirrorDir: string;
  configDir: string;
  managedBase: string;
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
  // Reproduce a Workforest mirror: a bare clone whose branches live under
  // refs/remotes/origin/* with a *dangling* HEAD (its refs/heads target is
  // deleted). This is what makes the primitives' explicit origin/<default>
  // start-point necessary — a start-point-less `git worktree add` would resolve
  // HEAD to the missing ref and fail with "invalid reference: HEAD".
  await execFileAsync("git", [
    "clone",
    "--bare",
    "--quiet",
    "--config",
    "remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*",
    sourceDir,
    mirrorDir,
  ]);
  await execFileAsync("git", ["fetch", "--quiet", "origin"], {
    cwd: mirrorDir,
  });
  await normalizeMirrorRefs(mirrorDir);

  // A scratch config makes the managed-directory guard deterministic: base lives
  // under the fixture, so every worktree path built directly under `root` sits
  // outside the managed tree unless a test deliberately targets `managedBase`.
  const managedBase = path.join(root, "managed");
  const configDir = path.join(root, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ directory: { base: managedBase } }),
  );

  return { root, cacheDir, mirrorDir, configDir, managedBase };
}

/**
 * Drop the local branch heads a bare clone copies directly, leaving HEAD a
 * dangling symref pointing at refs/heads/<default>, exactly as
 * `fixBareRepoRefs` normalizes real mirrors.
 */
async function normalizeMirrorRefs(mirrorDir: string): Promise<void> {
  const { stdout } = await execFileAsync(
    "git",
    ["for-each-ref", "--format=%(refname)", "refs/heads/"],
    { cwd: mirrorDir },
  );
  const refs = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const ref of refs) {
    await execFileAsync("git", ["update-ref", "-d", ref], { cwd: mirrorDir });
  }
}

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function runWorktree(
  cacheDir: string,
  args: readonly string[],
  options: { cwd?: string; configDir?: string } = {},
) {
  return runSubprocess(
    process.execPath,
    [path.resolve("bin/workforest.js"), "cache", "worktree", ...args],
    {
      cwd: options.cwd,
      env: {
        ...process.env,
        NO_COLOR: "1",
        WORKFOREST_CACHE_DIR: cacheDir,
        WORKFOREST_USE_SOURCE_CLI: "1",
        ...(options.configDir
          ? { WORKFOREST_CONFIG_DIR: options.configDir }
          : {}),
      },
    },
  );
}
