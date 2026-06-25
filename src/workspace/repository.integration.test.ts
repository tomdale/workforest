import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ensureMirrorRepoGenerator } from "./repository.ts";

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

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("ensureMirrorRepoGenerator", () => {
  it("updates remote refs without damaging a linked worktree on main", async () => {
    const rootDir = await createTempDir("workforest-cache-update-");
    const originDir = path.join(rootDir, "origin.git");
    const sourceDir = path.join(rootDir, "source");
    const mirrorDir = path.join(rootDir, "front.git");
    const worktreeDir = path.join(rootDir, "front");

    await git(["init", "--bare", originDir]);
    await git(["init", "--initial-branch=main", sourceDir]);
    await git(["config", "user.email", "test@example.com"], sourceDir);
    await git(["config", "user.name", "Test User"], sourceDir);
    await writeFile(path.join(sourceDir, "README.md"), "initial\n");
    await git(["add", "README.md"], sourceDir);
    await git(["commit", "-m", "initial"], sourceDir);
    await git(["remote", "add", "origin", originDir], sourceDir);
    await git(["push", "origin", "main"], sourceDir);

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
      ensureMirrorRepoGenerator(
        {
          name: "front",
          remote: originDir,
          defaultBranch: "main",
        },
        mirrorDir,
      ),
    );
    expect(states).toEqual([{ status: "running" }]);

    await expect(git(["status", "--short"], worktreeDir)).resolves.toBe("");
    await expect(
      git(["symbolic-ref", "--short", "HEAD"], worktreeDir),
    ).resolves.toBe("main");
    await expect(git(["rev-parse", "HEAD"], worktreeDir)).resolves.toBe(
      localMainBefore,
    );
    await expect(
      git(["rev-parse", "refs/heads/main"], mirrorDir),
    ).resolves.toBe(localMainBefore);
    await expect(
      git(["rev-parse", "refs/remotes/origin/main"], mirrorDir),
    ).resolves.toBe(originMain);
  });
});
