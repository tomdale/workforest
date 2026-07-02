import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  accessMock,
  rmMock,
  statMock,
  ensureCacheDirMock,
  cleanupWorkspaceWorktreesGeneratorMock,
  pathExistsMock,
  readWorkspaceMetadataMock,
  removeWorktreeMetadataMock,
} = vi.hoisted(() => ({
  accessMock: vi.fn(),
  rmMock: vi.fn(),
  statMock: vi.fn(),
  ensureCacheDirMock: vi.fn(),
  cleanupWorkspaceWorktreesGeneratorMock: vi.fn(),
  pathExistsMock: vi.fn(),
  readWorkspaceMetadataMock: vi.fn(),
  removeWorktreeMetadataMock: vi.fn(),
}));

vi.mock("node:fs", () => ({
  promises: {
    access: accessMock,
    rm: rmMock,
    stat: statMock,
  },
}));

vi.mock("../config.ts", () => ({
  getCacheDir: vi.fn(() => "/tmp/cache"),
  loadWorkspaceConfig: vi.fn(async () => ({
    path: "/tmp/config/config.json",
    config: {
      cache: {
        nodeModules: {
          enabled: true,
          maxRetainedPerRepo: 3,
        },
      },
    },
  })),
}));

vi.mock("../node-modules-cache.ts", () => ({
  preserveNodeModules: vi.fn(async () => ({ status: "missing" })),
}));

vi.mock("@wf-plugin/core", async () => {
  const actual =
    await vi.importActual<typeof import("@wf-plugin/core")>("@wf-plugin/core");
  return { ...actual, pathExists: pathExistsMock };
});

vi.mock("./index.ts", () => ({
  ensureCacheDir: ensureCacheDirMock,
}));

vi.mock("./metadata.ts", () => ({
  hasWorkspaceMetadata: vi.fn(async () => true),
  readWorkspaceMetadata: readWorkspaceMetadataMock,
  removeWorktreeMetadata: removeWorktreeMetadataMock,
}));

vi.mock("./repository.ts", () => ({
  cleanupWorkspaceWorktreesGenerator: cleanupWorkspaceWorktreesGeneratorMock,
}));

import {
  type CleanupState,
  cleanupWorkspace,
  cleanupWorkspaceGenerator,
  cleanupWorktree,
  previewCleanup,
} from "./cleanup.ts";

async function collectStates<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const states: T[] = [];
  for await (const state of gen) {
    states.push(state);
  }
  return states;
}

beforeEach(() => {
  vi.clearAllMocks();

  statMock.mockResolvedValue({ isDirectory: () => true });
  accessMock.mockResolvedValue(undefined);
  rmMock.mockResolvedValue(undefined);
  ensureCacheDirMock.mockResolvedValue("/tmp/cache");
  pathExistsMock.mockResolvedValue(true);
  readWorkspaceMetadataMock.mockResolvedValue({
    workspace: {
      version: "1",
      created_at: "2026-04-16T00:00:00.000Z",
      feature_name: "demo",
    },
    repos: [
      {
        name: "api",
        remote: "git@github.com:vercel/api.git",
        has_lockfile: true,
      },
    ],
    tasks: [
      {
        slug: "fix-tests",
        parent_repo: "api",
        path: "_tasks/api/fix-tests",
        branch: "tomdale/fix-tests",
        base_branch: "tomdale/demo",
        base_sha: "abc123",
        created_at: "2026-05-15T00:00:00.000Z",
        setup_status: "ready",
      },
    ],
  });
  removeWorktreeMetadataMock.mockResolvedValue(undefined);
});

describe("cleanupWorkspaceGenerator", () => {
  it("does not mark a repo as complete when worktree cleanup throws", async () => {
    cleanupWorkspaceWorktreesGeneratorMock.mockImplementation(
      async function* () {
        yield { status: "running", message: "Removing worktree" };
        throw new Error("boom");
      },
    );

    const states = await collectStates(
      cleanupWorkspaceGenerator("/tmp/workspace/demo"),
    );

    expect(states).toContainEqual({
      phase: "worktree",
      repo: "api",
      state: {
        status: "failed",
        error: expect.any(Error),
      },
    });

    expect(states).not.toContainEqual({
      phase: "worktree-complete",
      repo: "api",
    });

    expect(states[states.length - 1]).toEqual({
      phase: "complete",
      removedRepos: [],
    });
  });

  it("includes tasks in cleanup previews", async () => {
    await expect(previewCleanup("/tmp/workspace/demo")).resolves.toMatchObject({
      workspaceDir: "/tmp/workspace/demo",
      repos: ["api"],
      tasks: ["api-fix-tests"],
    });
  });

  it("returns cleanup data and emits states without writing output", async () => {
    const states: CleanupState[] = [];
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await expect(
      cleanupWorkspace("/tmp/workspace/demo", {
        dryRun: true,
        onState: (state) => {
          states.push(state);
        },
      }),
    ).resolves.toEqual({
      dryRun: true,
      removedRepos: ["api"],
      deletedBranches: [],
    });

    expect(states.at(-1)).toEqual({
      phase: "complete",
      removedRepos: ["api"],
    });
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("cleanupWorktree", () => {
  it("removes the change directory while preserving mirrors when the mirror is missing", async () => {
    pathExistsMock.mockResolvedValue(false);
    const states: CleanupState[] = [];

    await expect(
      cleanupWorktree({
        repoName: "api",
        targetPath: "/tmp/repos/api/demo",
        onState: (state) => {
          states.push(state);
        },
      }),
    ).resolves.toEqual({
      dryRun: false,
      removedRepos: [],
      deletedBranches: [],
    });

    expect(cleanupWorkspaceWorktreesGeneratorMock).not.toHaveBeenCalled();
    expect(rmMock).toHaveBeenCalledTimes(1);
    expect(rmMock).toHaveBeenCalledWith("/tmp/repos/api/demo", {
      recursive: true,
      force: true,
    });
    expect(removeWorktreeMetadataMock).toHaveBeenCalledWith(
      "/tmp/repos/api",
      "demo",
    );
    expect(rmMock).not.toHaveBeenCalledWith(
      "/tmp/cache/api.git",
      expect.anything(),
    );
    expect(states).toContainEqual({
      phase: "worktree",
      repo: "api",
      state: {
        status: "skipped",
        reason: "Mirror not found in cache",
      },
    });
    expect(states.at(-1)).toEqual({
      phase: "complete",
      removedRepos: [],
    });
  });

  it("dry-runs repository change cleanup without removing directories", async () => {
    const states: CleanupState[] = [];

    await expect(
      cleanupWorktree({
        repoName: "api",
        targetPath: "/tmp/repos/api/demo",
        dryRun: true,
        onState: (state) => {
          states.push(state);
        },
      }),
    ).resolves.toEqual({
      dryRun: true,
      removedRepos: ["api"],
      deletedBranches: [],
    });

    expect(cleanupWorkspaceWorktreesGeneratorMock).not.toHaveBeenCalled();
    expect(rmMock).not.toHaveBeenCalled();
    expect(removeWorktreeMetadataMock).not.toHaveBeenCalled();
    expect(states).toContainEqual({
      phase: "remove-dir",
      message: "Would remove directory: /tmp/repos/api/demo (dry-run)",
    });
    expect(states.at(-1)).toEqual({
      phase: "complete",
      removedRepos: ["api"],
    });
  });
});
