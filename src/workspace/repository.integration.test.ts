import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ensureMirrorRepo } from "./repository.ts";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function collectStates<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const states: T[] = [];
  for await (const state of gen) {
    states.push(state);
  }
  return states;
}

async function createRemoteFixture(): Promise<{
  originDir: string;
  sourceDir: string;
}> {
  const rootDir = await createTempDir("workforest-cache-fixture-");
  const originDir = path.join(rootDir, "origin.git");
  const sourceDir = path.join(rootDir, "source");

  await git(["init", "--bare", originDir]);
  await git(["init", "--initial-branch=main", sourceDir]);
  await git(["config", "user.email", "test@example.com"], sourceDir);
  await git(["config", "user.name", "Test User"], sourceDir);
  await writeFile(path.join(sourceDir, "README.md"), "initial\n");
  await git(["add", "README.md"], sourceDir);
  await git(["commit", "-m", "initial"], sourceDir);
  await git(["remote", "add", "origin", originDir], sourceDir);
  await git(["push", "origin", "main"], sourceDir);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], originDir);

  return { originDir, sourceDir };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("ensureMirrorRepo", () => {
  it("seeds missing mirrors with canonical remote-tracking refs", async () => {
    const { originDir, sourceDir } = await createRemoteFixture();
    const mirrorDir = path.join(
      await createTempDir("workforest-cache-seed-"),
      "front.git",
    );
    const sourceMain = await git(["rev-parse", "main"], sourceDir);

    await collectStates(
      ensureMirrorRepo(
        {
          name: "front",
          remote: originDir,
        },
        mirrorDir,
      ),
    );

    await expect(
      git(["rev-parse", "--is-bare-repository"], mirrorDir),
    ).resolves.toBe("true");
    await expect(
      git(["config", "--get-all", "remote.origin.fetch"], mirrorDir),
    ).resolves.toBe("+refs/heads/*:refs/remotes/origin/*");
    await expect(git(["symbolic-ref", "HEAD"], mirrorDir)).resolves.toBe(
      "refs/heads/main",
    );
    await expect(
      git(["rev-parse", "refs/remotes/origin/main"], mirrorDir),
    ).resolves.toBe(sourceMain);
    await expect(
      git(["for-each-ref", "--format=%(refname)", "refs/heads/"], mirrorDir),
    ).resolves.toBe("");
  });

  it("updates origin refs without damaging a linked worktree on main", async () => {
    const { originDir, sourceDir } = await createRemoteFixture();
    const rootDir = await createTempDir("workforest-cache-update-");
    const mirrorDir = path.join(rootDir, "front.git");
    const worktreeDir = path.join(rootDir, "front");

    await git(["clone", "--bare", originDir, mirrorDir]);
    await git(
      ["config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"],
      mirrorDir,
    );
    await git(["worktree", "add", worktreeDir, "main"], mirrorDir);

    const localMainBefore = await git(
      ["rev-parse", "refs/heads/main"],
      mirrorDir,
    );

    await writeFile(path.join(sourceDir, "README.md"), "updated\n");
    await git(["add", "README.md"], sourceDir);
    await git(["commit", "-m", "update"], sourceDir);
    await git(["push", "origin", "main"], sourceDir);
    const originMain = await git(["rev-parse", "main"], sourceDir);

    const states = await collectStates(
      ensureMirrorRepo(
        {
          name: "front",
          remote: originDir,
        },
        mirrorDir,
      ),
    );

    // The fetch streams: a running state with the command line, progress
    // output chunks, and no failure or warning states.
    expect(states.length).toBeGreaterThan(0);
    expect(states[0]).toMatchObject({ status: "running" });
    for (const state of states) {
      expect(["running", "output"]).toContain(state.status);
    }

    await expect(
      git(["status", "--porcelain=v1", "--branch"], worktreeDir),
    ).resolves.toBe("## main");

    const [localMainAfter, remoteMainAfter] = (
      await git(
        ["rev-parse", "refs/heads/main", "refs/remotes/origin/main"],
        mirrorDir,
      )
    ).split("\n");
    expect(localMainAfter).toBe(localMainBefore);
    expect(remoteMainAfter).toBe(originMain);
  });
});
