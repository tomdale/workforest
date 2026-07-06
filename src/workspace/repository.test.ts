import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runGitMock, streamGitMock } = vi.hoisted(() => ({
  runGitMock: vi.fn(),
  streamGitMock: vi.fn(),
}));

vi.mock("../services/git.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/git.ts")>();
  return {
    ...actual,
    cloneRepository: vi.fn(),
    fixBareRepoRefs: vi.fn(),
    runGit: runGitMock,
    streamGit: streamGitMock,
  };
});

import type { TaskState } from "../utils/task-generator.ts";
import { cleanupWorkspaceWorktrees, ensureMirrorRepo } from "./repository.ts";

function taskStates(...states: TaskState[]): () => AsyncGenerator<TaskState> {
  return async function* () {
    yield* states;
  };
}

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function collectStates<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const states: T[] = [];
  for await (const state of gen) {
    states.push(state);
  }
  return states;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("cleanupWorkspaceWorktrees", () => {
  it("prunes stale target metadata when git marks the worktree as prunable", async () => {
    const workspaceDir = await createTempDir("workforest-cleanup-");
    const mirrorDir = await createTempDir("workforest-api.git-");
    const commonDir = await createTempDir("workforest-common-");
    const repoDir = path.join(workspaceDir, "api");
    await mkdir(repoDir, { recursive: true });

    runGitMock.mockImplementation(async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          stdout: `worktree ${mirrorDir}
bare

worktree ${repoDir}
HEAD abc123
branch refs/heads/test
prunable gitdir file points to non-existent location
`,
          stderr: "",
        };
      }
      if (args[0] === "rev-parse") {
        return { stdout: commonDir, stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "prune") {
        return { stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    });

    const states = await collectStates(
      cleanupWorkspaceWorktrees(mirrorDir, workspaceDir),
    );

    expect(states).toEqual([
      {
        status: "log",
        level: "info",
        message: `Cleaning up 1 existing worktree under ${workspaceDir}`,
      },
      {
        status: "log",
        level: "warn",
        message: `Pruning stale worktree metadata for ${repoDir}`,
      },
    ]);

    expect(runGitMock).toHaveBeenNthCalledWith(
      1,
      ["worktree", "list", "--porcelain"],
      { cwd: mirrorDir },
    );
    expect(runGitMock).toHaveBeenCalledWith(["worktree", "prune"], {
      cwd: mirrorDir,
    });
  });

  it("prunes stale metadata when the worktree link exists but points to a missing admin dir", async () => {
    const workspaceDir = await createTempDir("workforest-cleanup-");
    const mirrorDir = await createTempDir("workforest-front.git-");
    const commonDir = await createTempDir("workforest-common-");
    const repoDir = path.join(workspaceDir, "front");
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      `${repoDir}/.git`,
      "gitdir: /tmp/cache/front.git/worktrees/front6\n",
    );

    runGitMock.mockImplementation(async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          stdout: `worktree ${mirrorDir}
bare

worktree ${repoDir}
HEAD def456
branch refs/heads/test
`,
          stderr: "",
        };
      }
      if (args[0] === "rev-parse") {
        return { stdout: commonDir, stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "prune") {
        return { stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    });

    const states = await collectStates(
      cleanupWorkspaceWorktrees(mirrorDir, workspaceDir),
    );

    expect(states).toEqual([
      {
        status: "log",
        level: "info",
        message: `Cleaning up 1 existing worktree under ${workspaceDir}`,
      },
      {
        status: "log",
        level: "warn",
        message: `Pruning stale worktree metadata for ${repoDir}`,
      },
    ]);

    expect(runGitMock).toHaveBeenCalledWith(["worktree", "prune"], {
      cwd: mirrorDir,
    });
  });

  it("removes direct metadata targets without scanning worktrees", async () => {
    const workspaceDir = await createTempDir("workforest-cleanup-");
    const mirrorDir = await createTempDir("workforest-api.git-");
    const commonDir = await createTempDir("workforest-common-");
    const repoDir = path.join(workspaceDir, "api");
    const adminDir = path.join(workspaceDir, "api-admin");
    await mkdir(repoDir, { recursive: true });
    await mkdir(adminDir, { recursive: true });
    await writeFile(
      `${repoDir}/.git`,
      `gitdir: ${adminDir}
`,
    );

    runGitMock.mockImplementation(async (args: string[]) => {
      if (args[0] === "rev-parse") {
        return { stdout: commonDir, stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        return { stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    });

    await collectStates(
      cleanupWorkspaceWorktrees(mirrorDir, workspaceDir, {
        targetPaths: [repoDir],
      }),
    );

    expect(runGitMock).not.toHaveBeenCalledWith(
      ["worktree", "list", "--porcelain"],
      expect.anything(),
    );
    expect(runGitMock).toHaveBeenCalledWith(
      ["worktree", "remove", "--force", repoDir],
      { cwd: mirrorDir, timeout: expect.any(Number) },
    );
  });

  it("falls back to scanned cleanup when a direct target is stale", async () => {
    const workspaceDir = await createTempDir("workforest-cleanup-");
    const mirrorDir = await createTempDir("workforest-api.git-");
    const commonDir = await createTempDir("workforest-common-");
    const repoDir = path.join(workspaceDir, "api");
    await mkdir(repoDir, { recursive: true });

    runGitMock.mockImplementation(async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          stdout: `worktree ${mirrorDir}
bare

worktree ${repoDir}
HEAD abc123
branch refs/heads/test
prunable gitdir file points to non-existent location
`,
          stderr: "",
        };
      }
      if (args[0] === "rev-parse") {
        return { stdout: commonDir, stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "prune") {
        return { stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    });

    await collectStates(
      cleanupWorkspaceWorktrees(mirrorDir, workspaceDir, {
        targetPaths: [repoDir],
      }),
    );

    expect(runGitMock).toHaveBeenCalledWith(
      ["worktree", "list", "--porcelain"],
      { cwd: mirrorDir },
    );
    expect(runGitMock).toHaveBeenCalledWith(["worktree", "prune"], {
      cwd: mirrorDir,
    });
  });
});

describe("ensureMirrorRepo", () => {
  it("fetches remote branches into remote-tracking refs explicitly", async () => {
    const mirrorDir = await createTempDir("workforest-front.git-");

    streamGitMock.mockImplementation(taskStates({ status: "completed" }));
    runGitMock.mockResolvedValueOnce({
      stdout: `worktree ${mirrorDir}
bare
`,
      stderr: "",
    });

    await collectStates(
      ensureMirrorRepo(
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
        },
        mirrorDir,
      ),
    );

    expect(streamGitMock).toHaveBeenNthCalledWith(
      1,
      [
        "fetch",
        "--progress",
        "--prune",
        "--no-tags",
        "--refmap=",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
      ],
      {
        cwd: mirrorDir,
        timeoutMs: expect.any(Number),
        inactivityTimeoutMs: expect.any(Number),
      },
    );
  });

  it("repairs case-conflicting stale remote refs when pruning the mirror fails", async () => {
    const mirrorDir = await createTempDir("workforest-front.git-");
    const lockError = new Error(
      "git fetch exited with code 1\nerror: could not delete references: cannot lock ref 'refs/remotes/origin/test-branch': Unable to create '/tmp/front.git/refs/remotes/origin/test-branch.lock': File exists.",
    );

    // Three failing fetch attempts, then a clean fetch after the repair.
    streamGitMock
      .mockImplementationOnce(
        taskStates({ status: "failed", error: lockError }),
      )
      .mockImplementationOnce(
        taskStates({ status: "failed", error: lockError }),
      )
      .mockImplementationOnce(
        taskStates({ status: "failed", error: lockError }),
      )
      .mockImplementationOnce(taskStates({ status: "completed" }));

    runGitMock
      .mockResolvedValueOnce({
        stdout:
          "refs/remotes/origin/Test-Branch\nrefs/remotes/origin/test-branch\n",
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        stdout: `worktree ${mirrorDir}
bare
`,
        stderr: "",
      });

    const states = await collectStates(
      ensureMirrorRepo(
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
        },
        mirrorDir,
      ),
    );

    expect(states).toContainEqual({
      status: "log",
      level: "warn",
      message:
        "Repairing case-conflicting cached refs for front: refs/remotes/origin/Test-Branch, refs/remotes/origin/test-branch",
    });
    expect(runGitMock).toHaveBeenNthCalledWith(
      1,
      ["for-each-ref", "--format=%(refname)", "refs/remotes"],
      { cwd: mirrorDir },
    );
    expect(runGitMock).toHaveBeenNthCalledWith(
      2,
      ["update-ref", "-d", "refs/remotes/origin/Test-Branch"],
      { cwd: mirrorDir },
    );
    expect(runGitMock).toHaveBeenNthCalledWith(
      3,
      ["update-ref", "-d", "refs/remotes/origin/test-branch"],
      { cwd: mirrorDir },
    );
    expect(streamGitMock).toHaveBeenCalledTimes(4);
  });
});
