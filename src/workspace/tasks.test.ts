import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
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

const { restoreNodeModulesMock, runGitMock, runSingleRepoInitializersMock } =
  vi.hoisted(() => ({
    restoreNodeModulesMock: vi.fn(),
    runGitMock: vi.fn(),
    runSingleRepoInitializersMock: vi.fn(),
  }));

vi.mock("../services/git.ts", () => ({
  runGit: runGitMock,
}));

vi.mock("../services/initializers/index.ts", () => ({
  runSingleRepoInitializers: runSingleRepoInitializersMock,
}));

vi.mock("../node-modules-cache.ts", async () => {
  const actual = await vi.importActual<
    typeof import("../node-modules-cache.ts")
  >("../node-modules-cache.ts");

  return {
    ...actual,
    restoreNodeModules: restoreNodeModulesMock,
  };
});

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
        hasLockfile: true,
      },
    ],
  });
  return dir;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the git mock's implementation (not just its call log) so a routing
  // impl from one test never leaks into a test that relies on a clean queue.
  runGitMock.mockReset();
  restoreNodeModulesMock.mockResolvedValue({ status: "missing" });
  runSingleRepoInitializersMock.mockImplementation(async function* () {
    yield { phase: "complete" };
  });
});

/**
 * Route the git mock for a task-creation flow. Task worktrees branch from the
 * parent checkout's HEAD; the shared primitive additionally probes the parent
 * branch (`show-ref`) and the git common dir (for the lock), so a routing mock
 * is more robust than a positional `mockResolvedValueOnce` chain.
 */
function mockCreateTaskGit(
  currentBranch: string,
  { sha = "abc123", dirty = false }: { sha?: string; dirty?: boolean } = {},
): void {
  runGitMock.mockImplementation(async (args: string[]) => {
    const [cmd] = args;
    if (cmd === "branch" && args.includes("--show-current")) {
      return { stdout: `${currentBranch}\n`, stderr: "" };
    }
    if (cmd === "rev-parse" && args.includes("--git-common-dir")) {
      return { stdout: "", stderr: "" };
    }
    if (cmd === "rev-parse") {
      return { stdout: `${sha}\n`, stderr: "" };
    }
    if (cmd === "status") {
      return { stdout: dirty ? " M file.ts\n" : "", stderr: "" };
    }
    if (cmd === "show-ref") {
      // Branch does not yet exist — the task branch is new.
      throw new Error("missing branch");
    }
    return { stdout: "", stderr: "" };
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("workspace tasks", () => {
  it("creates tracked sibling worktrees from the current branch", async () => {
    const workspaceDir = await createWorkspaceDir();
    const { createTasks } = await import("./tasks.ts");

    mockCreateTaskGit("tomdale/my-feature");

    const result = await createTasks({
      workspaceDir,
      parentRepo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
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
        setupStatus: "skipped",
      },
    ]);
    expect(restoreNodeModulesMock).not.toHaveBeenCalled();
    expect(runSingleRepoInitializersMock).not.toHaveBeenCalled();
    expect(runGitMock).toHaveBeenLastCalledWith(
      [
        "worktree",
        "add",
        "-b",
        "tomdale/fix-tests",
        path.join(workspaceDir, "_tasks", "front", "fix-tests"),
        "HEAD",
      ],
      { cwd: path.join(workspaceDir, "front"), timeout: 120_000 },
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
          setup_status: "skipped",
        },
      ],
    });
    await expect(
      readFile(
        path.join(workspaceDir, ".workforest/logs/front-fix-tests.log"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs setup and records a setup log when requested", async () => {
    const workspaceDir = await createWorkspaceDir();
    const { createTasks } = await import("./tasks.ts");

    mockCreateTaskGit("tomdale/my-feature");

    const result = await createTasks({
      workspaceDir,
      parentRepo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        has_lockfile: true,
      },
      slugs: ["fix-tests"],
      setup: true,
    });

    expect(result.created).toEqual([
      {
        slug: "fix-tests",
        parentRepo: "front",
        path: path.join(workspaceDir, "_tasks", "front", "fix-tests"),
        branch: "tomdale/fix-tests",
        setupStatus: "ready",
        setupLog: ".workforest/logs/front-fix-tests.log",
      },
    ]);
    expect(restoreNodeModulesMock).toHaveBeenCalledOnce();
    expect(runSingleRepoInitializersMock).toHaveBeenCalledOnce();
    await expect(readWorkspaceMetadata(workspaceDir)).resolves.toMatchObject({
      tasks: [
        {
          setup_status: "ready",
          setup_log: ".workforest/logs/front-fix-tests.log",
        },
      ],
    });
    await expect(
      readFile(
        path.join(workspaceDir, ".workforest/logs/front-fix-tests.log"),
        "utf8",
      ),
    ).resolves.toContain("[complete] initializers complete");
  });

  it("uses the configured branch prefix instead of inheriting the current branch namespace", async () => {
    const workspaceDir = await createWorkspaceDir();
    const { createTasks } = await import("./tasks.ts");

    mockCreateTaskGit("h/ai-alerts-follow-up");

    const result = await createTasks({
      workspaceDir,
      parentRepo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
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
      { cwd: path.join(workspaceDir, "front"), timeout: 120_000 },
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

    runSingleRepoInitializersMock.mockImplementation(async function* () {
      yield {
        phase: "running",
        initializerId: "pnpm-install",
        initializerName: "pnpm install",
        state: { status: "failed", error: new Error("install failed") },
      };
    });
    mockCreateTaskGit("tomdale/my-feature");

    const result = await createTasks({
      workspaceDir,
      parentRepo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        has_lockfile: true,
      },
      slugs: ["fix-tests"],
      setup: true,
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
    // A valid gitlink so the shared removal treats it as a live worktree
    // (a broken link would be pruned instead of removed).
    await writeFile(
      path.join(targetDir, ".git"),
      `gitdir: ${path.join(workspaceDir, "front")}\n`,
    );
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
        setup_log: ".workforest/logs/front-fix-tests.log",
      },
    ]);
    const setupLogPath = path.join(
      workspaceDir,
      ".workforest/logs/front-fix-tests.log",
    );
    await mkdir(path.dirname(setupLogPath), { recursive: true });
    await writeFile(setupLogPath, "keep this setup log\n", "utf8");
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

    expect(runGitMock).toHaveBeenCalledWith(["worktree", "remove", targetDir], {
      cwd: path.join(workspaceDir, "front"),
      timeout: 30_000,
    });
    expect(runGitMock).toHaveBeenCalledWith(
      ["branch", "-d", "tomdale/fix-tests"],
      { cwd: path.join(workspaceDir, "front") },
    );
    await expect(
      readWorkspaceMetadata(workspaceDir),
    ).resolves.not.toHaveProperty("tasks");
    await expect(readFile(setupLogPath, "utf8")).resolves.toBe(
      "keep this setup log\n",
    );
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

    mockCreateTaskGit("tomdale/my-feature");

    const result = await createRepositoryTasks({
      parentRepoDir,
      repo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
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
        setupStatus: "skipped",
      },
    ]);
    expect(restoreNodeModulesMock).not.toHaveBeenCalled();
    expect(runSingleRepoInitializersMock).not.toHaveBeenCalled();
    expect(runGitMock).toHaveBeenLastCalledWith(
      [
        "worktree",
        "add",
        "-b",
        "tomdale/fix-tests",
        path.join(repoRootDir, "_tasks", "my-feature", "fix-tests"),
        "HEAD",
      ],
      { cwd: parentRepoDir, timeout: 120_000 },
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
    const setupLogPath = path.join(
      repoRootDir,
      ".workforest/logs/front-my-feature-fix-tests.log",
    );
    await mkdir(path.dirname(setupLogPath), { recursive: true });
    await writeFile(
      setupLogPath,
      [
        "# workforest repo setup log",
        "repo: front-my-feature-fix-tests",
        "[complete] initializers complete",
        "",
      ].join("\n"),
      "utf8",
    );
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
        setup_log: ".workforest/logs/front-my-feature-fix-tests.log",
        absolutePath: taskDir,
        state: "ready",
        merged: true,
      },
    ]);
  });

  it("does not reuse another worktree task's retained setup log", async () => {
    const repoRootDir = await mkdtemp(
      path.join(os.tmpdir(), "workforest-repo-"),
    );
    tempDirs.push(repoRootDir);
    const parentRepoDir = path.join(repoRootDir, "other-feature");
    const taskDir = path.join(
      repoRootDir,
      "_tasks",
      "other-feature",
      "fix-tests",
    );
    await mkdir(taskDir, { recursive: true });
    const setupLogPath = path.join(
      repoRootDir,
      ".workforest/logs/front-my-feature-fix-tests.log",
    );
    await mkdir(path.dirname(setupLogPath), { recursive: true });
    await writeFile(
      setupLogPath,
      [
        "# workforest repo setup log",
        "repo: front-my-feature-fix-tests",
        "[complete] initializers complete",
        "",
      ].join("\n"),
      "utf8",
    );
    const { listRepositoryTasks } = await import("./tasks.ts");

    runGitMock
      .mockResolvedValueOnce({ stdout: "tomdale/other-feature\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "abc123\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "tomdale/fix-tests\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const tasks = await listRepositoryTasks({
      parentRepoDir,
      repoName: "front",
      changeName: "other-feature",
    });

    expect(tasks).toMatchObject([
      {
        slug: "fix-tests",
        state: "skipped",
      },
    ]);
    expect(tasks[0]).not.toHaveProperty("setup_log");
  });

  it("does not reuse a retained setup log older than the task directory", async () => {
    const repoRootDir = await mkdtemp(
      path.join(os.tmpdir(), "workforest-repo-"),
    );
    tempDirs.push(repoRootDir);
    const parentRepoDir = path.join(repoRootDir, "my-feature");
    const taskDir = path.join(repoRootDir, "_tasks", "my-feature", "fix-tests");
    await mkdir(taskDir, { recursive: true });
    const setupLogPath = path.join(
      repoRootDir,
      ".workforest/logs/front-my-feature-fix-tests.log",
    );
    await mkdir(path.dirname(setupLogPath), { recursive: true });
    await writeFile(
      setupLogPath,
      [
        "# workforest repo setup log",
        "repo: front-my-feature-fix-tests",
        "[complete] initializers complete",
        "",
      ].join("\n"),
      "utf8",
    );
    const old = new Date("2026-01-01T00:00:00.000Z");
    const current = new Date("2026-01-02T00:00:00.000Z");
    await utimes(setupLogPath, old, old);
    await utimes(taskDir, current, current);
    const { listRepositoryTasks } = await import("./tasks.ts");

    runGitMock
      .mockResolvedValueOnce({ stdout: "tomdale/my-feature\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "abc123\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "tomdale/fix-tests\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const tasks = await listRepositoryTasks({
      parentRepoDir,
      repoName: "front",
      changeName: "my-feature",
    });

    expect(tasks).toMatchObject([
      {
        slug: "fix-tests",
        state: "skipped",
      },
    ]);
    expect(tasks[0]).not.toHaveProperty("setup_log");
  });

  it("deletes merged worktree tasks", async () => {
    const repoRootDir = await mkdtemp(
      path.join(os.tmpdir(), "workforest-repo-"),
    );
    tempDirs.push(repoRootDir);
    const parentRepoDir = path.join(repoRootDir, "my-feature");
    const taskDir = path.join(repoRootDir, "_tasks", "my-feature", "fix-tests");
    await mkdir(taskDir, { recursive: true });
    // A valid gitlink so the shared removal treats it as a live worktree.
    await writeFile(path.join(taskDir, ".git"), `gitdir: ${repoRootDir}\n`);
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

    expect(runGitMock).toHaveBeenCalledWith(["worktree", "remove", taskDir], {
      cwd: parentRepoDir,
      timeout: 30_000,
    });
    expect(runGitMock).toHaveBeenCalledWith(
      ["branch", "-d", "tomdale/fix-tests"],
      { cwd: parentRepoDir },
    );
  });
});
