import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderCommandResult } from "./cli/output.ts";
import { executeCli } from "./cli.ts";
import { loadWorkspaceConfig } from "./config.ts";
import {
  appendTasks,
  writeWorkspaceMetadata,
  writeWorktreeMetadata,
} from "./workspace/metadata.ts";
import { resolveSelector } from "./workspace/selectors.ts";
import {
  type DirtySummary,
  type RepositoryStatus,
  renderStatus,
  type Status,
  type TaskStatus,
} from "./workspace/status.ts";

const execFileAsync = promisify(execFile);
const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const ORIGINAL_CWD = process.cwd();
const tempDirs: string[] = [];

afterEach(async () => {
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

describe("wf status", () => {
  it("reports an operational error outside a Workforest change", async () => {
    await createConfigFixture();

    const result = await executeCli(["status"]);
    const rendered = renderResult(result);

    expect(result.exitCode).toBe(1);
    expect(rendered.stderr).toContain(
      "Not in a Workforest worktree or workspace.",
    );
    expect(rendered.stderr).toContain("Run: wf list");
    expect(rendered.stderr).not.toMatch(/\n\s+at /);
  });

  it("renders a repository change status report", async () => {
    const { repoChange } = await createStatusFixture();

    const result = await executeCli(["status", "workforest/cli-redesign"]);
    const rendered = renderResult(result);

    expect(result.exitCode, rendered.stdout + rendered.stderr).toBe(0);
    expect(rendered.stderr).toBe("");
    // Header identity + dim path line.
    expect(rendered.stdout).toContain("workforest/cli-redesign");
    expect(rendered.stdout).toContain("worktree");
    expect(rendered.stdout).toContain(repoChange);
    // Repo row: name, feature branch, ahead sync, one-line worktree summary.
    expect(rendered.stdout).toContain("workforest");
    expect(rendered.stdout).toContain("tomdale/cli-redesign");
    expect(rendered.stdout).toContain("↑1");
    expect(rendered.stdout).toContain("1 untracked");
    // The old verbose one-liner, integration column, and Next steps are gone.
    expect(rendered.stdout).not.toContain("dirty: 1 untracked");
    expect(rendered.stdout).not.toContain("not integrated");
    expect(rendered.stdout).not.toContain("Next steps");
  });

  it("renders repository change initialization state and failed setup logs", async () => {
    const { repoChange } = await createStatusFixture({
      repositoryInitialization: {
        workspace: {
          version: 1,
          status: "failed",
          message: "1 repository initializer failed",
          updated_at: new Date().toISOString(),
        },
        repo: {
          version: 1,
          repo: "workforest",
          status: "failed",
          phase: "initializer",
          step: "initializer:pnpm install",
          message: "pnpm install failed",
          error: "pnpm install failed",
          attempt: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        log: "ERR_PNPM_FETCH_404 package not found\n",
      },
    });

    const result = await executeCli(["status", "workforest/cli-redesign"]);
    const rendered = renderResult(result);

    expect(result.exitCode, rendered.stdout + rendered.stderr).toBe(0);
    // Failed setup: short error on the row, log path on its own dim line.
    expect(rendered.stdout).toContain("setup failed: pnpm install failed");
    expect(rendered.stdout).toContain(
      path.join(
        path.dirname(repoChange),
        ".workforest",
        "initialization",
        "cli-redesign",
        "logs",
        "workforest.log",
      ),
    );
    // No repeated Initialization roll-up / Error: detail block.
    expect(rendered.stdout).not.toContain("Failed: workforest");
    expect(rendered.stdout).not.toContain("Error: pnpm install failed");
  });

  it("surfaces workspace initialization failures as blockers", async () => {
    await createStatusFixture({
      workspaceInitialization: {
        version: 1,
        status: "failed",
        message: "Workspace hook failed",
        error: "pnpm install failed",
        current_hook: "install",
        updated_at: new Date().toISOString(),
      },
    });

    const result = await executeCli(["status", "vercel-agent/auth-fix"]);
    const rendered = renderResult(result);

    expect(result.exitCode, rendered.stdout + rendered.stderr).toBe(0);
    // Workspace-level failure shows as a single setup line, not a field block.
    expect(rendered.stdout).toContain("setup failed: pnpm install failed");
    expect(rendered.stdout).not.toContain("Hook:");
  });

  it("shows a static report when watch has no initialization state", async () => {
    await createStatusFixture();

    const result = await executeCli([
      "status",
      "workforest/cli-redesign",
      "--watch",
    ]);
    const rendered = renderResult(result);

    expect(result.exitCode, rendered.stdout + rendered.stderr).toBe(0);
    expect(rendered.stdout).toContain(
      "No initialization is recorded for this worktree or workspace. Showing the static report.",
    );
  });

  it("waits and exits zero once initialization is ready", async () => {
    await createStatusFixture({
      repoInitializations: [
        {
          version: 1,
          repo: "api",
          status: "ready",
          attempt: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    });

    const stdoutLines: string[] = [];
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        stdoutLines.push(String(chunk));
        return true;
      });

    try {
      const result = await executeCli([
        "status",
        "vercel-agent/auth-fix",
        "--wait",
      ]);
      const rendered = renderResult(result);

      expect(result.exitCode, rendered.stderr).toBe(0);
      expect(stdoutLines.join("")).toContain("api: ready");
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  it("rejects --timeout without --wait", async () => {
    await createStatusFixture();

    const result = await executeCli(["status", "--timeout", "5"]);
    expect(result.exitCode).toBe(2);
  });

  it("waits for a terminal state for watch outside an interactive terminal", async () => {
    await createStatusFixture({
      repoInitializations: [
        {
          version: 1,
          repo: "api",
          status: "running",
          phase: "initializer",
          step: "install",
          message: "Installing dependencies",
          pid: 4242,
          run_id: "run-1",
          attempt: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    });

    // The recorded worker pid is dead, so the state self-heals to failed and
    // the non-TTY watch resolves immediately with the failure exit code.
    const stdoutLines: string[] = [];
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        stdoutLines.push(String(chunk));
        return true;
      });

    try {
      const result = await executeCli([
        "status",
        "vercel-agent/auth-fix",
        "--watch",
      ]);
      const rendered = renderResult(result);

      expect(result.exitCode).toBe(1);
      expect(stdoutLines.join("")).toContain("api: failed");
      expect(rendered.stderr).toContain("wf init logs");
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  it("reports ambiguous bare selectors", async () => {
    await createStatusFixture();

    const result = await executeCli(["status", "auth-fix"]);
    const rendered = renderResult(result);

    expect(result.exitCode).toBe(2);
    expect(rendered.stderr).toContain('Ambiguous selector "auth-fix".');
    expect(rendered.stderr).toContain("_adhoc/auth-fix");
    expect(rendered.stderr).toContain("vercel-agent/auth-fix");
    expect(rendered.stderr).toContain("Use <group>/<name>.");
  });

  it("emits JSON for the current workspace change", async () => {
    const { workspace, apiRepo } = await createStatusFixture();
    process.chdir(apiRepo);
    const loadedConfig = await loadWorkspaceConfig();
    expect(loadedConfig.config.directory?.base).toBe(
      path.dirname(path.dirname(path.dirname(workspace))),
    );
    await expect(
      resolveSelector(loadedConfig.config, undefined),
    ).resolves.toMatchObject({
      kind: "resolved",
      entry: { selector: "vercel-agent/auth-fix" },
    });

    const result = await executeCli(["status", "--json"]);
    const rendered = renderResult(result);
    const body = JSON.parse(rendered.stdout);

    expect(result.exitCode, rendered.stdout + rendered.stderr).toBe(0);
    expect(rendered.stderr).toBe("");
    expect(body).toEqual({
      ok: true,
      data: expect.objectContaining({
        selector: "vercel-agent/auth-fix",
        type: "template-workspace",
        path: workspace,
        summary: expect.objectContaining({
          change: "vercel-agent/auth-fix",
          repos: 2,
          path: workspace,
        }),
        repositories: expect.arrayContaining([
          expect.objectContaining({
            name: "api",
            state: "dirty",
            dirty: expect.objectContaining({ untracked: 1, total: 1 }),
          }),
        ]),
        tasks: [
          expect.objectContaining({
            selector: "api/fix-tests",
            state: "stale",
          }),
        ],
      }),
    });
  });
});

describe("renderStatus report", () => {
  it("renders header, dim path, and a clean synced repo row", () => {
    const output = render(
      buildStatus({
        repositories: [repositoryStatus({ name: "web" })],
      }),
    );
    expect(output).toContain("myspace");
    expect(output).toContain("next-forge");
    expect(output).toContain("1 repo");
    expect(output).toContain("~/code/myspace");
    expect(output).toContain("web");
    expect(output).toContain("main");
    expect(output).toContain("synced");
    expect(output).toContain("clean");
  });

  it("renders ahead/behind sync and bullet-separated changes", () => {
    const output = render(
      buildStatus({
        repositories: [
          repositoryStatus({
            name: "api",
            branch: "feature",
            ahead: 2,
            behind: 1,
            state: "dirty",
            dirty: dirtySummary({ modified: 3, untracked: 2 }),
          }),
        ],
      }),
    );
    expect(output).toContain("↑2 ↓1");
    expect(output).toContain("3 modified · 2 untracked");
  });

  it("puts the short error on the failed row and the log path beneath", () => {
    const output = render(
      buildStatus({
        repositories: [
          repositoryStatus({
            name: "infra",
            branch: null,
            base: null,
            ahead: null,
            behind: null,
            state: "stale",
            setup: {
              status: "failed",
              error: "pnpm install failed",
              logPath: "/home/dev/code/myspace/.workforest/infra.log",
            },
          }),
        ],
      }),
    );
    expect(output).toContain("setup failed: pnpm install failed");
    expect(output).toContain(".workforest/infra.log");
    expect(output).not.toContain("Error:");
  });

  it("renders phase-aware in-progress labels", () => {
    const output = render(
      buildStatus({
        repositories: [
          repositoryStatus({ name: "a", setup: { status: "queued" } }),
          repositoryStatus({ name: "b", setup: { status: "git" } }),
          repositoryStatus({ name: "c", setup: { status: "running" } }),
        ],
      }),
    );
    expect(output).toContain("queued");
    expect(output).toContain("cloning…");
    expect(output).toContain("installing…");
  });

  it("shows expired guidance as 'out of date by' a duration, hides fresh", () => {
    const expired = render(
      buildStatus({
        guidance: {
          state: "expired",
          expiresAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        },
      }),
    );
    expect(expired).toContain("AGENTS.md out of date by 3h");

    const fresh = render(
      buildStatus({ guidance: { state: "fresh", expiresAt: null } }),
    );
    expect(fresh).not.toContain("AGENTS.md");
  });

  it("indents nested tasks under their parent repo", () => {
    const output = render(
      buildStatus({
        repositories: [repositoryStatus({ name: "api" })],
        tasks: [
          taskStatus({
            parentRepo: "api",
            slug: "rate-limit",
            merged: false,
          }),
        ],
      }),
    );
    const taskLine = output
      .split("\n")
      .find((line) => line.includes("rate-limit"));
    expect(taskLine).toBeDefined();
    expect(taskLine).toMatch(/^\s{6}/);
    expect(taskLine).toContain("unmerged");
  });

  it("drops the title, summary labels, tasks placeholder, and next steps", () => {
    const output = render(
      buildStatus({ repositories: [repositoryStatus({})], nextSteps: ["x"] }),
    );
    expect(output).not.toContain("Change status");
    expect(output).not.toContain("Summary");
    expect(output).not.toContain("No nested tasks");
    expect(output).not.toContain("Next steps");
  });
});

function render(status: Status): string {
  return stripAnsi(renderStatus(status));
}

function buildStatus(overrides: Partial<Status> = {}): Status {
  return {
    selector: "myspace",
    type: "template-workspace",
    typeLabel: "template workspace",
    groupName: "next-forge",
    changeName: "myspace",
    path: "~/code/myspace",
    modifiedAt: new Date().toISOString(),
    modifiedAtMs: Date.now(),
    summary: {
      change: "myspace",
      type: "template workspace",
      path: "~/code/myspace",
      updated: "0m ago",
    },
    repositories: [],
    tasks: [],
    initialization: null,
    nextSteps: [],
    ...overrides,
  };
}

function repositoryStatus(
  overrides: Partial<RepositoryStatus> = {},
): RepositoryStatus {
  return {
    name: "web",
    path: "~/code/myspace/web",
    branch: "main",
    defaultBranch: "main",
    state: "clean",
    dirty: dirtySummary(),
    base: "origin/main",
    ahead: 0,
    behind: 0,
    integrated: true,
    setup: { status: "ready" },
    line: "",
    details: [],
    ...overrides,
  };
}

function taskStatus(overrides: Partial<TaskStatus> = {}): TaskStatus {
  return {
    selector: "api/rate-limit",
    parentRepo: "api",
    slug: "rate-limit",
    branch: "feat/rate-limit",
    path: "~/code/myspace/_tasks/api/rate-limit",
    state: "ready",
    merged: false,
    line: "",
    details: [],
    ...overrides,
  };
}

function dirtySummary(overrides: Partial<DirtySummary> = {}): DirtySummary {
  return {
    total: 0,
    modified: 0,
    added: 0,
    deleted: 0,
    renamed: 0,
    untracked: 0,
    other: 0,
    ...overrides,
  };
}

async function createConfigFixture(): Promise<{ baseDir: string }> {
  const configDir = await createTempDir("workforest-status-config-");
  const baseDir = await createTempDir("workforest-status-base-");
  process.env["WORKFOREST_CONFIG_DIR"] = configDir;
  await writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ directory: { base: baseDir } }),
    "utf8",
  );
  return { baseDir };
}

async function createStatusFixture(
  options: {
    workspaceInitialization?: {
      version: 1;
      status: "failed";
      message: string;
      error: string;
      current_hook?: string;
      updated_at: string;
    };
    repoInitializations?: Array<{
      version: 1;
      repo: string;
      status: "pending" | "git" | "queued" | "running" | "ready" | "failed";
      phase?: "git" | "initializer";
      step?: string;
      message?: string;
      error?: string;
      pid?: number;
      run_id?: string;
      attempt: number;
      created_at: string;
      updated_at: string;
    }>;
    repositoryInitialization?: {
      workspace?: {
        version: 1;
        status: "creating" | "initializing" | "ready" | "failed";
        message?: string;
        error?: string;
        updated_at: string;
      };
      repo: {
        version: 1;
        repo: string;
        status: "pending" | "git" | "queued" | "running" | "ready" | "failed";
        phase?: "git" | "initializer";
        step?: string;
        message?: string;
        error?: string;
        attempt: number;
        created_at: string;
        updated_at: string;
      };
      log?: string;
    };
  } = {},
): Promise<{
  workspace: string;
  apiRepo: string;
  repoChange: string;
}> {
  const { baseDir } = await createConfigFixture();
  const workspace = path.join(
    baseDir,
    "Workspaces",
    "vercel-agent",
    "auth-fix",
  );
  const duplicateWorkspace = path.join(
    baseDir,
    "Workspaces",
    "_adhoc",
    "auth-fix",
  );
  const agentsRepo = path.join(workspace, "agents");
  const apiRepo = path.join(workspace, "api");
  const repoChange = path.join(baseDir, "Repos", "workforest", "cli-redesign");

  await Promise.all([
    createGitRepo(agentsRepo, { branch: "tomdale/auth-fix" }),
    createGitRepo(apiRepo, { branch: "tomdale/auth-fix", dirty: true }),
    createGitRepo(path.join(duplicateWorkspace, "front")),
    createGitRepo(repoChange, {
      branch: "tomdale/cli-redesign",
      dirty: true,
      remoteOrigin: true,
      ahead: true,
    }),
  ]);

  await writeWorkspaceMetadata(workspace, {
    featureName: "auth-fix",
    templateId: "vercel-agent",
    branchName: "tomdale/auth-fix",
    repos: [
      {
        name: "agents",
        remote: "git@github.com:vercel/agents.git",
        hasLockfile: true,
      },
      {
        name: "api",
        remote: "git@github.com:vercel/api.git",
        hasLockfile: true,
      },
    ],
  });
  await writeWorkspaceMetadata(duplicateWorkspace, {
    featureName: "auth-fix",
    branchName: "tomdale/auth-fix",
    repos: [
      {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        hasLockfile: true,
      },
    ],
  });
  await writeWorktreeMetadata(path.dirname(repoChange), {
    featureName: "cli-redesign",
    branchName: "tomdale/cli-redesign",
    repos: [
      {
        name: "workforest",
        remote: "git@github.com:tomdale/workforest.git",
        hasLockfile: true,
      },
    ],
  });
  await appendTasks(workspace, [
    {
      slug: "fix-tests",
      parent_repo: "api",
      path: "_tasks/api/fix-tests",
      branch: "tomdale/auth-fix/fix-tests",
      base_branch: "main",
      base_sha: "abc123",
      created_at: new Date().toISOString(),
      setup_status: "ready",
    },
  ]);
  if (options.workspaceInitialization) {
    const initializationDir = path.join(
      workspace,
      ".workforest",
      "initialization",
    );
    await mkdir(initializationDir, { recursive: true });
    await writeFile(
      path.join(initializationDir, "workspace.json"),
      JSON.stringify(options.workspaceInitialization, null, 2),
      "utf8",
    );
  }
  if (options.repoInitializations?.length) {
    const repoStateDir = path.join(
      workspace,
      ".workforest",
      "initialization",
      "repos",
    );
    await mkdir(repoStateDir, { recursive: true });
    await Promise.all(
      options.repoInitializations.map((state) =>
        writeFile(
          path.join(repoStateDir, `${encodeURIComponent(state.repo)}.json`),
          JSON.stringify(state, null, 2),
          "utf8",
        ),
      ),
    );
  }
  if (options.repositoryInitialization) {
    const initializationDir = path.join(
      path.dirname(repoChange),
      ".workforest",
      "initialization",
      "cli-redesign",
    );
    await mkdir(path.join(initializationDir, "repos"), { recursive: true });
    if (options.repositoryInitialization.workspace) {
      await writeFile(
        path.join(initializationDir, "workspace.json"),
        JSON.stringify(options.repositoryInitialization.workspace, null, 2),
        "utf8",
      );
    }
    await writeFile(
      path.join(
        initializationDir,
        "repos",
        `${encodeURIComponent(options.repositoryInitialization.repo.repo)}.json`,
      ),
      JSON.stringify(options.repositoryInitialization.repo, null, 2),
      "utf8",
    );
    if (options.repositoryInitialization.log) {
      await mkdir(path.join(initializationDir, "logs"), { recursive: true });
      await writeFile(
        path.join(
          initializationDir,
          "logs",
          `${options.repositoryInitialization.repo.repo}.log`,
        ),
        options.repositoryInitialization.log,
        "utf8",
      );
    }
  }

  return { workspace, apiRepo, repoChange };
}

async function createGitRepo(
  dir: string,
  options: {
    branch?: string;
    dirty?: boolean;
    remoteOrigin?: boolean;
    ahead?: boolean;
  } = {},
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", options.branch ?? "main"], {
    cwd: dir,
  });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], {
    cwd: dir,
  });
  await writeFile(path.join(dir, "README.md"), "fixture\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "Initial commit"], {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Workforest Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Workforest Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  await execFileAsync("git", ["branch", "main"], { cwd: dir }).catch(
    () => undefined,
  );
  if (options.remoteOrigin) {
    await execFileAsync(
      "git",
      ["update-ref", "refs/remotes/origin/main", "main"],
      {
        cwd: dir,
      },
    );
    await execFileAsync(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
      { cwd: dir },
    );
  }
  if (options.ahead) {
    await writeFile(path.join(dir, "feature.txt"), "feature\n", "utf8");
    await execFileAsync("git", ["add", "feature.txt"], { cwd: dir });
    await execFileAsync("git", ["commit", "-q", "-m", "Feature commit"], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Workforest Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Workforest Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
  }
  if (options.dirty) {
    await writeFile(path.join(dir, "change.txt"), "dirty\n", "utf8");
  }
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function renderResult(result: Awaited<ReturnType<typeof executeCli>>): {
  stdout: string;
  stderr: string;
} {
  let stdout = "";
  let stderr = "";
  renderCommandResult(result, {
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  });
  return {
    stdout: stripAnsi(stdout),
    stderr: stripAnsi(stderr),
  };
}
