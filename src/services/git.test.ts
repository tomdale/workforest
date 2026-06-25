import { beforeEach, describe, expect, it, vi } from "vitest";

const { runCommandMock, runCommandWithStdinMock } = vi.hoisted(() => ({
  runCommandMock: vi.fn(),
  runCommandWithStdinMock: vi.fn(),
}));

vi.mock("../utils/exec.ts", () => ({
  runCommand: runCommandMock,
  runCommandWithStdin: runCommandWithStdinMock,
}));

import { fixBareRepoRefsGenerator } from "./git.ts";

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

describe("fixBareRepoRefsGenerator", () => {
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

    const states = await collectStates(
      fixBareRepoRefsGenerator("/tmp/cache/front.git"),
    );

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
