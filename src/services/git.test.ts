import { beforeEach, describe, expect, it, vi } from "vitest";

const { runCommandMock, runCommandWithStdinMock } = vi.hoisted(() => ({
  runCommandMock: vi.fn(),
  runCommandWithStdinMock: vi.fn(),
}));

vi.mock("../utils/exec.ts", () => ({
  runCommand: runCommandMock,
  runCommandWithStdin: runCommandWithStdinMock,
}));

import { createDefaultBranchResolver, fixBareRepoRefs } from "./git.ts";

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

describe("fixBareRepoRefs", () => {
  it("updates remote refs without deleting a branch checked out by a linked worktree", async () => {
    runCommandMock
      .mockResolvedValueOnce({
        stdout: [
          "refs/heads/main 1111111111111111111111111111111111111111",
          "refs/heads/release 2222222222222222222222222222222222222222",
          "",
        ].join("\n"),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: [
          "worktree /tmp/cache/front.git",
          "bare",
          "",
          "worktree /tmp/worktrees/front",
          "HEAD 1111111111111111111111111111111111111111",
          "branch refs/heads/main",
          "",
        ].join("\n"),
        stderr: "",
      });
    runCommandWithStdinMock.mockResolvedValueOnce({ stdout: "", stderr: "" });

    const states = await collectStates(fixBareRepoRefs("/tmp/cache/front.git"));

    expect(states).toEqual([
      {
        status: "log",
        level: "info",
        message:
          "Normalizing 2 refs from refs/heads/* to refs/remotes/origin/*",
      },
      {
        status: "log",
        level: "warn",
        message:
          "Preserving checked-out local branch refs during bare repo normalization: refs/heads/main",
      },
    ]);
    expect(runCommandMock).toHaveBeenNthCalledWith(
      1,
      "git",
      ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"],
      { cwd: "/tmp/cache/front.git" },
    );
    expect(runCommandMock).toHaveBeenNthCalledWith(
      2,
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: "/tmp/cache/front.git" },
    );
    expect(runCommandWithStdinMock).toHaveBeenCalledWith(
      "git",
      ["update-ref", "--stdin"],
      [
        "update refs/remotes/origin/main 1111111111111111111111111111111111111111",
        "update refs/remotes/origin/release 2222222222222222222222222222222222222222",
        "delete refs/heads/release",
        "",
      ].join("\n"),
      { cwd: "/tmp/cache/front.git" },
    );
  });
});

describe("createDefaultBranchResolver", () => {
  it("reflects a bare mirror default branch from HEAD", async () => {
    runCommandMock
      .mockResolvedValueOnce({ stdout: "refs/heads/trunk\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const resolver = createDefaultBranchResolver();

    await expect(
      resolver.resolveBareMirrorDefaultBranch("/tmp/cache/front.git"),
    ).resolves.toBe("trunk");
    expect(runCommandMock).toHaveBeenNthCalledWith(
      1,
      "git",
      ["symbolic-ref", "HEAD"],
      { cwd: "/tmp/cache/front.git" },
    );
    expect(runCommandMock).toHaveBeenNthCalledWith(
      2,
      "git",
      ["show-ref", "--verify", "--quiet", "refs/remotes/origin/trunk"],
      { cwd: "/tmp/cache/front.git" },
    );
  });

  it("reflects a worktree default branch from origin HEAD", async () => {
    runCommandMock
      .mockResolvedValueOnce({
        stdout: "/tmp/worktrees/front/.git\n",
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "/tmp/cache/front.git\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "origin/canary\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const resolver = createDefaultBranchResolver();

    await expect(
      resolver.resolveWorktreeDefaultBranch("/tmp/worktrees/front"),
    ).resolves.toBe("canary");
  });

  it("fails when a reflected mirror branch has no origin ref", async () => {
    runCommandMock
      .mockResolvedValueOnce({ stdout: "refs/heads/main\n", stderr: "" })
      .mockRejectedValueOnce(new Error("missing ref"));

    const resolver = createDefaultBranchResolver();

    await expect(
      resolver.resolveBareMirrorDefaultBranch("/tmp/cache/front.git"),
    ).rejects.toThrow("refs/remotes/origin/main does not exist");
  });

  it("deduplicates concurrent reflections for the same mirror", async () => {
    let release!: () => void;
    const reflected = new Promise<{ stdout: string; stderr: string }>(
      (resolve) => {
        release = () => resolve({ stdout: "refs/heads/main\n", stderr: "" });
      },
    );
    runCommandMock
      .mockReturnValueOnce(reflected)
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const resolver = createDefaultBranchResolver();
    const first = resolver.resolveBareMirrorDefaultBranch(
      "/tmp/cache/front.git",
    );
    const second = resolver.resolveBareMirrorDefaultBranch(
      "/tmp/cache/front.git",
    );
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      "main",
      "main",
    ]);
    expect(runCommandMock).toHaveBeenCalledTimes(2);
  });
});
