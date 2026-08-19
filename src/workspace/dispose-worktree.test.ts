import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  pathExistsMock,
  preserveNodeModulesMock,
  rollbackPreservedNodeModulesMock,
  removeWorktreeMock,
  deleteBranchIfPossibleMock,
  rmMock,
} = vi.hoisted(() => ({
  pathExistsMock: vi.fn(),
  preserveNodeModulesMock: vi.fn(),
  rollbackPreservedNodeModulesMock: vi.fn(),
  removeWorktreeMock: vi.fn(),
  deleteBranchIfPossibleMock: vi.fn(),
  rmMock: vi.fn(),
}));

vi.mock("node:fs", () => ({
  promises: {
    rm: rmMock,
  },
}));

vi.mock("@wf-plugin/core", async () => {
  const actual =
    await vi.importActual<typeof import("@wf-plugin/core")>("@wf-plugin/core");
  return { ...actual, pathExists: pathExistsMock };
});

vi.mock("../node-modules-cache.ts", () => ({
  preserveNodeModules: preserveNodeModulesMock,
  rollbackPreservedNodeModules: rollbackPreservedNodeModulesMock,
}));

vi.mock("../services/worktree.ts", () => ({
  removeWorktree: removeWorktreeMock,
  deleteBranchIfPossible: deleteBranchIfPossibleMock,
}));

import { disposeWorktreeCheckout } from "./dispose-worktree.ts";

beforeEach(() => {
  vi.clearAllMocks();
  pathExistsMock.mockResolvedValue(true);
  preserveNodeModulesMock.mockResolvedValue({ status: "preserved" });
  rollbackPreservedNodeModulesMock.mockResolvedValue(undefined);
  deleteBranchIfPossibleMock.mockResolvedValue(undefined);
  rmMock.mockResolvedValue(undefined);
  removeWorktreeMock.mockImplementation(async function* () {
    yield { status: "running" };
    return { status: "removed" };
  });
});

describe("disposeWorktreeCheckout", () => {
  it("preserves node_modules before removing the linked checkout", async () => {
    const result = await disposeWorktreeCheckout({
      gitDir: "/cache/api.git",
      worktreePath: "/repos/api/demo",
      repo: { name: "api", remote: "git@github.com:vercel/api.git" },
      force: true,
      branch: "tomdale/demo",
      forceBranchDelete: false,
    });

    expect(preserveNodeModulesMock).toHaveBeenCalledWith({
      repo: { name: "api", remote: "git@github.com:vercel/api.git" },
      repoDir: "/repos/api/demo",
      config: undefined,
    });
    expect(removeWorktreeMock).toHaveBeenCalledWith({
      gitDir: "/cache/api.git",
      worktreePath: "/repos/api/demo",
      force: true,
      lock: true,
    });
    expect(deleteBranchIfPossibleMock).toHaveBeenCalledWith(
      "/cache/api.git",
      "tomdale/demo",
      false,
    );
    expect(result).toEqual({
      status: "removed",
      nodeModules: "preserved",
      branchDeleted: true,
    });
  });

  it("reports node_modules and teardown decisions", async () => {
    const events: string[] = [];
    await disposeWorktreeCheckout({
      gitDir: "/cache/api.git",
      worktreePath: "/repos/api/demo",
      onEvent: (event) => events.push(`${event.phase}:${event.status}`),
    });

    expect(events).toEqual([
      "checkout:completed",
      "node-modules:skipped",
      "worktree-remove:started",
      "worktree-remove:completed",
      "residual-cleanup:started",
      "residual-cleanup:completed",
      "branch:skipped",
    ]);
  });

  it("rolls preserved node_modules back when removal fails", async () => {
    const preserved = { status: "preserved" as const };
    preserveNodeModulesMock.mockResolvedValue(preserved);
    removeWorktreeMock.mockImplementation(async function* () {
      yield { status: "running" };
      throw new Error("remove failed");
    });

    await expect(
      disposeWorktreeCheckout({
        gitDir: "/cache/api.git",
        worktreePath: "/repos/api/demo",
        repo: { name: "api", remote: "git@github.com:vercel/api.git" },
        force: true,
      }),
    ).rejects.toThrow("remove failed");

    expect(rollbackPreservedNodeModulesMock).toHaveBeenCalledWith(preserved);
  });

  it("prunes stale metadata when the checkout directory is already gone", async () => {
    pathExistsMock
      .mockResolvedValueOnce(false) // initial exists check
      .mockResolvedValueOnce(false); // residual sweep check

    const result = await disposeWorktreeCheckout({
      gitDir: "/cache/api.git",
      worktreePath: "/repos/api/demo",
      force: true,
    });

    expect(preserveNodeModulesMock).not.toHaveBeenCalled();
    expect(removeWorktreeMock).toHaveBeenCalledWith({
      gitDir: "/cache/api.git",
      worktreePath: "/repos/api/demo",
      force: true,
      lock: true,
    });
    expect(result.status).toBe("stale");
  });
});
