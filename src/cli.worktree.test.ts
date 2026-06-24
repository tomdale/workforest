import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveWorkspaceConfig } from "./config.ts";
import { writeWorkspaceMetadata } from "./workspace/metadata.ts";

const {
  createSingleWorktreeMock,
  removeStandaloneWorktreeMock,
  createTasksMock,
  listTasksMock,
  deleteTasksMock,
} = vi.hoisted(() => ({
  createSingleWorktreeMock: vi.fn(),
  removeStandaloneWorktreeMock: vi.fn(),
  createTasksMock: vi.fn(),
  listTasksMock: vi.fn(),
  deleteTasksMock: vi.fn(),
}));

const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const ORIGINAL_CWD = process.cwd();
const tempDirs: string[] = [];

async function importCli(): Promise<typeof import("./cli.ts")> {
  vi.doMock("./worktree.ts", () => ({
    createSingleWorktree: createSingleWorktreeMock,
    removeStandaloneWorktree: removeStandaloneWorktreeMock,
  }));
  vi.doMock("./workspace/tasks.ts", () => ({
    createTasks: createTasksMock,
    listTasks: listTasksMock,
    deleteTasks: deleteTasksMock,
  }));
  return import("./cli.ts");
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unmock("./worktree.ts");
  vi.unmock("./workspace/tasks.ts");
  createSingleWorktreeMock.mockReset();
  removeStandaloneWorktreeMock.mockReset();
  createTasksMock.mockReset();
  listTasksMock.mockReset();
  deleteTasksMock.mockReset();
  process.chdir(ORIGINAL_CWD);
  if (ORIGINAL_CONFIG_DIR === undefined) {
    delete process.env["WORKFOREST_CONFIG_DIR"];
  } else {
    process.env["WORKFOREST_CONFIG_DIR"] = ORIGINAL_CONFIG_DIR;
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("worktree CLI", () => {
  it.each([
    ["create", ["worktree", "create", "--help"]],
    ["list", ["worktree", "list", "--help"]],
    ["delete", ["worktree", "delete", "--help"]],
  ])("renders %s help", async (_name, argv) => {
    const { executeCli } = await importCli();
    expect(await executeCli(argv)).toMatchObject({
      exitCode: 0,
      render: { kind: "text", stream: "stdout" },
    });
  });

  it.each([
    ["missing create target", ["worktree", "create", "vercel/front"]],
    [
      "surplus create target",
      ["worktree", "create", "vercel/front", "fix-auth", "extra"],
    ],
    ["missing delete path", ["worktree", "delete"]],
    ["surplus delete path", ["worktree", "delete", "one", "two"]],
    ["inapplicable list flag", ["worktree", "list", "--force"]],
    ["removed alias", ["wt", "list"]],
    ["removed managed command", ["worktree", "promote"]],
  ])("rejects %s with exit 2", async (_name, argv) => {
    const { executeCli } = await importCli();
    const result = await executeCli(argv);
    expect(result).toMatchObject({
      exitCode: 2,
      render: { kind: "text", stream: "stderr" },
    });
  });

  it("creates a standalone worktree under defaultDir by repository name", async () => {
    const configDir = await createTempDir("workforest-config-");
    const defaultDir = await createTempDir("workforest-default-");
    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      defaultDir,
      branchPrefix: "tomdale/",
    });
    const targetDir = path.join(defaultDir, "front", "fix-auth");
    createSingleWorktreeMock.mockResolvedValue({
      repo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        defaultBranch: "main",
      },
      branchName: "tomdale/fix-auth",
      targetDir,
    });

    const { executeCli } = await importCli();
    const result = await executeCli([
      "worktree",
      "create",
      "vercel/front",
      "fix-auth",
    ]);

    expect(result.exitCode).toBe(0);
    expect(createSingleWorktreeMock).toHaveBeenCalledWith({
      repo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        defaultBranch: "main",
      },
      branchName: "tomdale/fix-auth",
      targetDir,
    });
  });

  it("creates a standalone worktree at the explicit --dir path", async () => {
    const configDir = await createTempDir("workforest-config-");
    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      branchPrefix: "tomdale/",
    });
    const targetDir = path.join(
      await createTempDir("workforest-target-"),
      "fix-auth",
    );
    createSingleWorktreeMock.mockResolvedValue({
      repo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        defaultBranch: "main",
      },
      branchName: "tomdale/fix-auth",
      targetDir,
    });

    const { executeCli } = await importCli();
    const result = await executeCli([
      "worktree",
      "create",
      "vercel/front",
      "fix-auth",
      "--dir",
      targetDir,
    ]);

    expect(result.exitCode).toBe(0);
    expect(createSingleWorktreeMock).toHaveBeenCalledWith({
      repo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        defaultBranch: "main",
      },
      branchName: "tomdale/fix-auth",
      targetDir,
    });
  });

  it("requires defaultDir for the default standalone worktree path", async () => {
    const configDir = await createTempDir("workforest-config-");
    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      branchPrefix: "tomdale/",
    });

    const { executeCli } = await importCli();
    const result = await executeCli([
      "worktree",
      "create",
      "vercel/front",
      "fix-auth",
    ]);

    expect(result).toMatchObject({
      exitCode: 1,
      render: { kind: "text", stream: "stderr" },
    });
    expect(createSingleWorktreeMock).not.toHaveBeenCalled();
  });

  it("deletes only the explicit standalone worktree path", async () => {
    const targetDir = path.join(
      await createTempDir("workforest-worktree-"),
      "task",
    );
    removeStandaloneWorktreeMock.mockResolvedValue({
      path: targetDir,
      branch: "refs/heads/task",
      dryRun: false,
    });

    const { executeCli } = await importCli();
    const result = await executeCli([
      "worktree",
      "delete",
      targetDir,
      "--force",
    ]);

    expect(result.exitCode).toBe(0);
    expect(removeStandaloneWorktreeMock).toHaveBeenCalledWith({
      targetDir,
      dryRun: false,
      force: true,
    });
  });
});

describe("task CLI", () => {
  it.each([
    ["create", ["task", "create", "--help"]],
    ["list", ["task", "list", "--help"]],
    ["delete", ["task", "delete", "--help"]],
  ])("renders %s help", async (_name, argv) => {
    const { executeCli } = await importCli();
    expect(await executeCli(argv)).toMatchObject({
      exitCode: 0,
      render: { kind: "text", stream: "stdout" },
    });
  });

  it.each([
    ["missing create slug", ["task", "create"]],
    ["missing delete slug", ["task", "delete"]],
    ["inapplicable list flag", ["task", "list", "--dry-run"]],
    ["removed worktree shorthand", ["worktree", "fix-auth"]],
  ])("rejects %s with exit 2", async (_name, argv) => {
    const { executeCli } = await importCli();
    expect(await executeCli(argv)).toMatchObject({
      exitCode: 2,
      render: { kind: "text", stream: "stderr" },
    });
  });

  it("routes explicit task slugs through the owning workspace repository", async () => {
    const { workspaceDir, repoDir } = await createWorkspace();
    const resolvedWorkspaceDir = await realpath(workspaceDir);
    process.chdir(repoDir);
    createTasksMock.mockResolvedValue({
      created: [
        {
          slug: "fix-tests",
          parentRepo: "front",
          path: path.join(workspaceDir, "fix-tests"),
          branch: "tomdale/fix-tests",
          setupStatus: "ready",
        },
      ],
      failures: [],
    });
    deleteTasksMock.mockResolvedValue({ removed: [] });

    const { executeCli } = await importCli();
    expect(
      await executeCli(["task", "create", "fix-tests", "--force"]),
    ).toMatchObject({ exitCode: 0 });
    expect(createTasksMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: resolvedWorkspaceDir,
        slugs: ["fix-tests"],
        force: true,
      }),
    );

    expect(
      await executeCli(["task", "delete", "fix-tests", "--force"]),
    ).toMatchObject({ exitCode: 0 });
    expect(deleteTasksMock).toHaveBeenCalledWith({
      workspaceDir: resolvedWorkspaceDir,
      slugs: ["fix-tests"],
      parentRepoName: "front",
      dryRun: false,
      force: true,
    });
  });

  it("lists tasks for the current repository", async () => {
    const { workspaceDir, repoDir } = await createWorkspace();
    const resolvedWorkspaceDir = await realpath(workspaceDir);
    process.chdir(repoDir);
    listTasksMock.mockResolvedValue([]);

    const { executeCli } = await importCli();
    expect(await executeCli(["task", "list"])).toMatchObject({ exitCode: 0 });
    expect(listTasksMock).toHaveBeenCalledWith(resolvedWorkspaceDir, "front");
  });
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createWorkspace(): Promise<{
  workspaceDir: string;
  repoDir: string;
}> {
  const workspaceDir = await createTempDir("workforest-workspace-");
  const repoDir = path.join(workspaceDir, "front");
  await mkdir(repoDir, { recursive: true });
  await writeWorkspaceMetadata(workspaceDir, {
    featureName: "feature",
    repos: [
      {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        defaultBranch: "main",
        hasLockfile: false,
      },
    ],
  });
  return { workspaceDir, repoDir };
}
