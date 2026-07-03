import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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

async function createCommit(
  cwd: string,
  tree: string,
  message: string,
  parent?: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message],
    {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test User",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test User",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    },
  );
  return stdout.trim();
}

async function updateMain(cwd: string, commit: string): Promise<void> {
  await git(["update-ref", "refs/heads/main", commit], cwd);
}

async function collectStates<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const states: T[] = [];
  for await (const state of gen) {
    states.push(state);
  }
  return states;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("ensureMirrorRepo", () => {
  it("updates remote refs without damaging a linked worktree on main", async () => {
    const rootDir = await createTempDir("workforest-cache-update-");
    const sourceDir = path.join(rootDir, "source");
    const mirrorDir = path.join(rootDir, "front.git");
    const worktreeDir = path.join(rootDir, "front");

    await git(["init", "--initial-branch=main", sourceDir]);
    const emptyTree = await git(["write-tree"], sourceDir);
    const localMainBefore = await createCommit(sourceDir, emptyTree, "initial");
    await updateMain(sourceDir, localMainBefore);

    await git(["clone", "--bare", sourceDir, mirrorDir]);
    await git(
      ["config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"],
      mirrorDir,
    );
    await git(["worktree", "add", worktreeDir, "main"], mirrorDir);

    const originMain = await createCommit(
      sourceDir,
      emptyTree,
      "update",
      localMainBefore,
    );
    await updateMain(sourceDir, originMain);

    const states = await collectStates(
      ensureMirrorRepo(
        {
          name: "front",
          remote: sourceDir,
        },
        mirrorDir,
      ),
    );
    expect(states).toEqual([{ status: "running" }]);

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
