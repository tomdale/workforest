import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runGitMock } = vi.hoisted(() => ({
  runGitMock: vi.fn(),
}));

vi.mock("../services/git.ts", () => ({
  cloneRepositoryGenerator: vi.fn(),
  fixBareRepoRefsGenerator: vi.fn(),
  runGit: runGitMock,
}));

import {
  cleanupWorkspaceWorktreesGenerator,
  createWorkingCopyGenerator,
} from "./repository.ts";

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

describe("cleanupWorkspaceWorktreesGenerator", () => {
  it("prunes stale target metadata when git marks the worktree as prunable", async () => {
    const workspaceDir = await createTempDir("workforest-cleanup-");
    const repoDir = path.join(workspaceDir, "api");
    await mkdir(repoDir, { recursive: true });

    runGitMock
      .mockResolvedValueOnce({
        stdout: `worktree /tmp/cache/api.git
bare

worktree ${repoDir}
HEAD abc123
branch refs/heads/test
prunable gitdir file points to non-existent location
`,
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const states = await collectStates(
      cleanupWorkspaceWorktreesGenerator("/tmp/cache/api.git", workspaceDir),
    );

    expect(states).toEqual([
      {
        status: "log",
        level: "info",
        message: `Cleaning up 1 existing worktree(s) under ${workspaceDir}`,
      },
      {
        status: "log",
        level: "warn",
        message: `Stale worktree metadata for ${repoDir}; pruning mirror metadata instead`,
      },
    ]);

    expect(runGitMock).toHaveBeenNthCalledWith(
      1,
      ["worktree", "list", "--porcelain"],
      { cwd: "/tmp/cache/api.git" },
    );
    expect(runGitMock).toHaveBeenNthCalledWith(2, ["worktree", "prune"], {
      cwd: "/tmp/cache/api.git",
    });
  });

  it("prunes stale metadata when the worktree link exists but points to a missing admin dir", async () => {
    const workspaceDir = await createTempDir("workforest-cleanup-");
    const repoDir = path.join(workspaceDir, "front");
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      repoDir + "/.git",
      "gitdir: /tmp/cache/front.git/worktrees/front6\n",
    );

    runGitMock
      .mockResolvedValueOnce({
        stdout: `worktree /tmp/cache/front.git
bare

worktree ${repoDir}
HEAD def456
branch refs/heads/test
`,
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const states = await collectStates(
      cleanupWorkspaceWorktreesGenerator("/tmp/cache/front.git", workspaceDir),
    );

    expect(states).toEqual([
      {
        status: "log",
        level: "info",
        message: `Cleaning up 1 existing worktree(s) under ${workspaceDir}`,
      },
      {
        status: "log",
        level: "warn",
        message: `Stale worktree metadata for ${repoDir}; pruning mirror metadata instead`,
      },
    ]);

    expect(runGitMock).toHaveBeenNthCalledWith(2, ["worktree", "prune"], {
      cwd: "/tmp/cache/front.git",
    });
  });
});

describe("createWorkingCopyGenerator", () => {
  it("creates a new branch worktree without resetting existing branches", async () => {
    const targetDir = path.join(
      await createTempDir("workforest-worktree-"),
      "front",
    );

    runGitMock
      .mockRejectedValueOnce(new Error("missing branch"))
      .mockResolvedValueOnce({ stdout: "refs/heads/main\n", stderr: "" })
      .mockResolvedValueOnce({
        stdout: "refs/remotes/origin/main\n",
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const states = await collectStates(
      createWorkingCopyGenerator(
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
        },
        "/tmp/cache/front.git",
        targetDir,
        "tomdale/fix-auth",
      ),
    );

    expect(states).toEqual([
      {
        status: "log",
        level: "info",
        message:
          'Creating worktree for front on branch "tomdale/fix-auth" from origin/main',
      },
    ]);
    expect(runGitMock).toHaveBeenNthCalledWith(
      1,
      ["show-ref", "--verify", "--quiet", "refs/heads/tomdale/fix-auth"],
      { cwd: "/tmp/cache/front.git" },
    );
    expect(runGitMock).toHaveBeenNthCalledWith(
      4,
      ["worktree", "add", "-b", "tomdale/fix-auth", targetDir, "origin/main"],
      { cwd: "/tmp/cache/front.git" },
    );
  });

  it("fails when the target directory already exists", async () => {
    const targetDir = await createTempDir("workforest-worktree-");

    await expect(
      collectStates(
        createWorkingCopyGenerator(
          {
            name: "front",
            remote: "git@github.com:vercel/front.git",
            defaultBranch: "main",
          },
          "/tmp/cache/front.git",
          targetDir,
          "tomdale/fix-auth",
        ),
      ),
    ).rejects.toThrow(`Target directory already exists: ${targetDir}`);

    expect(runGitMock).not.toHaveBeenCalled();
  });

  it("fails when the branch already exists", async () => {
    const targetDir = path.join(
      await createTempDir("workforest-worktree-"),
      "front",
    );

    runGitMock.mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(
      collectStates(
        createWorkingCopyGenerator(
          {
            name: "front",
            remote: "git@github.com:vercel/front.git",
            defaultBranch: "main",
          },
          "/tmp/cache/front.git",
          targetDir,
          "tomdale/fix-auth",
        ),
      ),
    ).rejects.toThrow("Branch already exists: tomdale/fix-auth");

    expect(runGitMock).toHaveBeenCalledOnce();
    expect(runGitMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(["-B"]),
      expect.anything(),
    );
  });
});
