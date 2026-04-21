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

import { cleanupWorkspaceWorktreesGenerator } from "./repository.ts";

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
    expect(runGitMock).toHaveBeenNthCalledWith(
      2,
      ["worktree", "prune"],
      { cwd: "/tmp/cache/api.git" },
    );
  });

  it("prunes stale metadata when the worktree link exists but points to a missing admin dir", async () => {
    const workspaceDir = await createTempDir("workforest-cleanup-");
    const repoDir = path.join(workspaceDir, "front");
    await mkdir(repoDir, { recursive: true });
    await writeFile(repoDir + "/.git", "gitdir: /tmp/cache/front.git/worktrees/front6\n");

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

    expect(runGitMock).toHaveBeenNthCalledWith(
      2,
      ["worktree", "prune"],
      { cwd: "/tmp/cache/front.git" },
    );
  });
});
