import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendTasks,
  readWorkspaceMetadata,
  writeWorkspaceMetadata,
} from "./metadata.ts";

const { runGitMock, runSingleRepoInitializersGeneratorMock } = vi.hoisted(
  () => ({
    runGitMock: vi.fn(),
    runSingleRepoInitializersGeneratorMock: vi.fn(),
  }),
);

vi.mock("../services/git.ts", () => ({
  runGit: runGitMock,
}));

vi.mock("../services/initializers/index.ts", () => ({
  runSingleRepoInitializersGenerator: runSingleRepoInitializersGeneratorMock,
}));

const tempDirs: string[] = [];

async function createWorkspaceDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workforest-workspace-"));
  tempDirs.push(dir);
  await mkdir(path.join(dir, "front"), { recursive: true });
  await writeWorkspaceMetadata(dir, {
    featureName: "my-feature",
    repos: [
      {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        defaultBranch: "main",
        hasLockfile: true,
      },
    ],
  });
  return dir;
}

beforeEach(() => {
  vi.clearAllMocks();
  runSingleRepoInitializersGeneratorMock.mockImplementation(async function* () {
    yield { phase: "complete" };
  });
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("workspace tasks", () => {
  it("creates tracked sibling worktrees from the current branch", async () => {
    const workspaceDir = await createWorkspaceDir();
    const { createTasks } = await import("./tasks.ts");

    runGitMock
      .mockResolvedValueOnce({ stdout: "tomdale/my-feature\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "abc123\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(new Error("missing branch"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await createTasks({
      workspaceDir,
      parentRepo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        default_branch: "main",
        has_lockfile: true,
      },
      slugs: ["fix-tests"],
    });

    expect(result.created).toEqual([
      {
        slug: "fix-tests",
        parentRepo: "front",
        path: path.join(workspaceDir, "_tasks", "front", "fix-tests"),
        branch: "tomdale/fix-tests",
        setupStatus: "ready",
      },
    ]);
    expect(runGitMock).toHaveBeenLastCalledWith(
      [
        "worktree",
        "add",
        "-b",
        "tomdale/fix-tests",
        path.join(workspaceDir, "_tasks", "front", "fix-tests"),
        "HEAD",
      ],
      { cwd: path.join(workspaceDir, "front") },
    );
    await expect(readWorkspaceMetadata(workspaceDir)).resolves.toMatchObject({
      tasks: [
        {
          slug: "fix-tests",
          parent_repo: "front",
          path: "_tasks/front/fix-tests",
          branch: "tomdale/fix-tests",
          base_branch: "tomdale/my-feature",
          base_sha: "abc123",
          setup_status: "ready",
        },
      ],
    });
  });

  it("uses the configured branch prefix instead of inheriting the current branch namespace", async () => {
    const workspaceDir = await createWorkspaceDir();
    const { createTasks } = await import("./tasks.ts");

    runGitMock
      .mockResolvedValueOnce({ stdout: "h/ai-alerts-follow-up\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "abc123\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(new Error("missing branch"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await createTasks({
      workspaceDir,
      parentRepo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        default_branch: "main",
        has_lockfile: true,
      },
      slugs: ["optional-corepack"],
      branchPrefix: "tomdale/",
    });

    expect(result.created[0]).toMatchObject({
      slug: "optional-corepack",
      branch: "tomdale/optional-corepack",
    });
    expect(runGitMock).toHaveBeenLastCalledWith(
      [
        "worktree",
        "add",
        "-b",
        "tomdale/optional-corepack",
        path.join(workspaceDir, "_tasks", "front", "optional-corepack"),
        "HEAD",
      ],
      { cwd: path.join(workspaceDir, "front") },
    );
  });

  it("rejects duplicate slugs for the same parent repo", async () => {
    const workspaceDir = await createWorkspaceDir();
    await appendTasks(workspaceDir, [
      {
        slug: "fix-tests",
        parent_repo: "front",
        path: "_tasks/front/fix-tests",
        branch: "tomdale/fix-tests",
        base_branch: "main",
        base_sha: "abc123",
        created_at: "2026-05-15T00:00:00.000Z",
        setup_status: "ready",
      },
    ]);
    const { createTasks } = await import("./tasks.ts");

    runGitMock
      .mockResolvedValueOnce({ stdout: "tomdale/my-feature\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "def456\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(
      createTasks({
        workspaceDir,
        parentRepo: {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          default_branch: "main",
          has_lockfile: true,
        },
        slugs: ["fix-tests"],
      }),
    ).rejects.toThrow('Task "fix-tests" is already tracked for front.');
  });

  it("allows the same slug for different workspace parent repos", async () => {
    const workspaceDir = await createWorkspaceDir();
    await mkdir(path.join(workspaceDir, "docs"), { recursive: true });
    await appendTasks(workspaceDir, [
      {
        slug: "fix-tests",
        parent_repo: "docs",
        path: "_tasks/docs/fix-tests",
        branch: "tomdale/docs-fix-tests",
        base_branch: "main",
        base_sha: "abc123",
        created_at: "2026-05-15T00:00:00.000Z",
        setup_status: "ready",
      },
    ]);
    const { createTasks } = await import("./tasks.ts");

    runGitMock
      .mockResolvedValueOnce({ stdout: "tomdale/my-feature\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "def456\n", stderr: "" })
      .mockRejectedValueOnce(new Error("missing branch"));

    await expect(
      createTasks({
        workspaceDir,
        parentRepo: {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          default_branch: "main",
          has_lockfile: true,
        },
        slugs: ["fix-tests"],
        dryRun: true,
      }),
    ).resolves.toMatchObject({
      created: [
        {
          slug: "fix-tests",
          parentRepo: "front",
          path: path.join(workspaceDir, "_tasks", "front", "fix-tests"),
        },
      ],
    });
  });

  it("keeps a worktree and records a setup log when initializers fail", async () => {
    const workspaceDir = await createWorkspaceDir();
    const { createTasks } = await import("./tasks.ts");

    runSingleRepoInitializersGeneratorMock.mockImplementation(
      async function* () {
        yield {
          phase: "running",
          initializerId: "pnpm-install",
          initializerName: "pnpm install",
          state: { status: "failed", error: new Error("install failed") },
        };
      },
    );
    runGitMock
      .mockResolvedValueOnce({ stdout: "tomdale/my-feature\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "abc123\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(new Error("missing branch"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await createTasks({
      workspaceDir,
      parentRepo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        default_branch: "main",
        has_lockfile: true,
      },
      slugs: ["fix-tests"],
    });

    expect(result.created[0]).toMatchObject({
      slug: "fix-tests",
      setupStatus: "failed",
      setupLog: expect.stringMatching(
        /^\.workforest\/logs\/front-fix-tests\.log$/,
      ),
    });
    const metadata = await readWorkspaceMetadata(workspaceDir);
    expect(metadata?.tasks?.[0]).toMatchObject({
      setup_status: "failed",
      setup_log: ".workforest/logs/front-fix-tests.log",
    });
    await expect(
      readFile(
        path.join(workspaceDir, ".workforest/logs/front-fix-tests.log"),
        "utf8",
      ),
    ).resolves.toContain("install failed");
  });

  it("removes merged clean worktrees and deletes their local branches", async () => {
    const workspaceDir = await createWorkspaceDir();
    const targetDir = path.join(workspaceDir, "_tasks", "front", "fix-tests");
    await mkdir(targetDir, { recursive: true });
    await appendTasks(workspaceDir, [
      {
        slug: "fix-tests",
        parent_repo: "front",
        path: "_tasks/front/fix-tests",
        branch: "tomdale/fix-tests",
        base_branch: "tomdale/my-feature",
        base_sha: "abc123",
        created_at: "2026-05-15T00:00:00.000Z",
        setup_status: "ready",
      },
    ]);
    const { deleteTasks } = await import("./tasks.ts");

    runGitMock
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(
      deleteTasks({
        workspaceDir,
        slugs: ["fix-tests"],
        parentRepoName: "front",
      }),
    ).resolves.toEqual({
      removed: [
        expect.objectContaining({
          slug: "fix-tests",
          parent_repo: "front",
        }),
      ],
    });

    expect(runGitMock).toHaveBeenNthCalledWith(
      3,
      ["worktree", "remove", targetDir],
      {
        cwd: path.join(workspaceDir, "front"),
        timeout: 30_000,
      },
    );
    expect(runGitMock).toHaveBeenNthCalledWith(
      4,
      ["branch", "-d", "tomdale/fix-tests"],
      { cwd: path.join(workspaceDir, "front") },
    );
    await expect(
      readWorkspaceMetadata(workspaceDir),
    ).resolves.not.toHaveProperty("tasks");
  });

  it("prunes stale workspace tasks on delete", async () => {
    const workspaceDir = await createWorkspaceDir();
    await appendTasks(workspaceDir, [
      {
        slug: "fix-tests",
        parent_repo: "front",
        path: "_tasks/front/fix-tests",
        branch: "tomdale/fix-tests",
        base_branch: "tomdale/my-feature",
        base_sha: "abc123",
        created_at: "2026-05-15T00:00:00.000Z",
        setup_status: "ready",
      },
    ]);
    runGitMock.mockResolvedValue({ stdout: "", stderr: "" });
    const { deleteTasks } = await import("./tasks.ts");

    const result = await deleteTasks({
      workspaceDir,
      slugs: ["fix-tests"],
      parentRepoName: "front",
    });

    expect(result.removed.map((entry) => entry.slug)).toEqual(["fix-tests"]);
    await expect(
      readWorkspaceMetadata(workspaceDir),
    ).resolves.not.toHaveProperty("tasks");
  });

  it("refuses destructive cleanup when a setup log ancestor is a symlink", async () => {
    const workspaceDir = await createWorkspaceDir();
    const outsideDir = await mkdtemp(
      path.join(os.tmpdir(), "workforest-outside-logs-"),
    );
    tempDirs.push(outsideDir);
    const outsideLog = path.join(outsideDir, "front-fix-tests.log");
    await writeFile(outsideLog, "keep\n", "utf8");
    await appendTasks(workspaceDir, [
      {
        slug: "fix-tests",
        parent_repo: "front",
        path: "_tasks/front/fix-tests",
        branch: "tomdale/fix-tests",
        base_branch: "tomdale/my-feature",
        base_sha: "abc123",
        created_at: "2026-05-15T00:00:00.000Z",
        setup_status: "failed",
        setup_log: ".workforest/logs/front-fix-tests.log",
      },
    ]);
    await mkdir(path.join(workspaceDir, "_tasks", "front", "fix-tests"), {
      recursive: true,
    });
    await symlink(outsideDir, path.join(workspaceDir, ".workforest", "logs"));
    const { deleteTasks } = await import("./tasks.ts");

    await expect(
      deleteTasks({
        workspaceDir,
        slugs: ["fix-tests"],
        force: true,
      }),
    ).rejects.toThrow("symbolic link");

    await expect(readFile(outsideLog, "utf8")).resolves.toBe("keep\n");
    expect(runGitMock).not.toHaveBeenCalled();
  });

  it("creates worktree tasks under the reserved change task path", async () => {
    const repoRootDir = await mkdtemp(
      path.join(os.tmpdir(), "workforest-repo-"),
    );
    tempDirs.push(repoRootDir);
    const parentRepoDir = path.join(repoRootDir, "my-feature");
    await mkdir(parentRepoDir, { recursive: true });
    const { createRepositoryTasks } = await import("./tasks.ts");

    runGitMock
      .mockResolvedValueOnce({ stdout: "tomdale/my-feature\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "abc123\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(new Error("missing branch"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await createRepositoryTasks({
      parentRepoDir,
      repo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        defaultBranch: "main",
      },
      changeName: "my-feature",
      slugs: ["fix-tests"],
    });

    expect(result.created).toEqual([
      {
        slug: "fix-tests",
        parentRepo: "front",
        path: path.join(repoRootDir, "_tasks", "my-feature", "fix-tests"),
        branch: "tomdale/fix-tests",
        setupStatus: "ready",
      },
    ]);
    expect(runGitMock).toHaveBeenLastCalledWith(
      [
        "worktree",
        "add",
        "-b",
        "tomdale/fix-tests",
        path.join(repoRootDir, "_tasks", "my-feature", "fix-tests"),
        "HEAD",
      ],
      { cwd: parentRepoDir },
    );
  });

  it("lists worktree tasks from reserved task directories", async () => {
    const repoRootDir = await mkdtemp(
      path.join(os.tmpdir(), "workforest-repo-"),
    );
    tempDirs.push(repoRootDir);
    const parentRepoDir = path.join(repoRootDir, "my-feature");
    const taskDir = path.join(repoRootDir, "_tasks", "my-feature", "fix-tests");
    await mkdir(taskDir, { recursive: true });
    const { listRepositoryTasks } = await import("./tasks.ts");

    runGitMock
      .mockResolvedValueOnce({ stdout: "tomdale/my-feature\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "abc123\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "tomdale/fix-tests\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(
      listRepositoryTasks({
        parentRepoDir,
        repoName: "front",
        changeName: "my-feature",
      }),
    ).resolves.toMatchObject([
      {
        slug: "fix-tests",
        parent_repo: "front",
        path: "_tasks/my-feature/fix-tests",
        branch: "tomdale/fix-tests",
        absolutePath: taskDir,
        state: "ready",
        merged: true,
      },
    ]);
  });

  it("deletes merged worktree tasks", async () => {
    const repoRootDir = await mkdtemp(
      path.join(os.tmpdir(), "workforest-repo-"),
    );
    tempDirs.push(repoRootDir);
    const parentRepoDir = path.join(repoRootDir, "my-feature");
    const taskDir = path.join(repoRootDir, "_tasks", "my-feature", "fix-tests");
    await mkdir(taskDir, { recursive: true });
    const { deleteRepositoryTasks } = await import("./tasks.ts");

    runGitMock
      .mockResolvedValueOnce({ stdout: "tomdale/my-feature\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "abc123\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "tomdale/fix-tests\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(
      deleteRepositoryTasks({
        parentRepoDir,
        repoName: "front",
        changeName: "my-feature",
        slugs: ["fix-tests"],
      }),
    ).resolves.toEqual({
      removed: [
        expect.objectContaining({
          slug: "fix-tests",
          parent_repo: "front",
        }),
      ],
    });

    expect(runGitMock).toHaveBeenNthCalledWith(
      7,
      ["worktree", "remove", taskDir],
      {
        cwd: parentRepoDir,
        timeout: 30_000,
      },
    );
    expect(runGitMock).toHaveBeenNthCalledWith(
      8,
      ["branch", "-d", "tomdale/fix-tests"],
      { cwd: parentRepoDir },
    );
  });
});
