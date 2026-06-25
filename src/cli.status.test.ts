import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it } from "vitest";
import { renderCommandResult } from "./cli/output.ts";
import { executeCli } from "./cli.ts";
import { loadWorkspaceConfig } from "./config.ts";
import {
  appendTasks,
  writeRepositoryChangeMetadata,
  writeWorkspaceMetadata,
} from "./workspace/metadata.ts";
import { resolveChangeSelector } from "./workspace/selectors.ts";

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
    expect(rendered.stderr).toContain("Not in a Workforest change.");
    expect(rendered.stderr).toContain("Run: wf list");
    expect(rendered.stderr).not.toMatch(/\n\s+at /);
  });

  it("renders a repository change status report", async () => {
    const { repoChange } = await createStatusFixture();

    const result = await executeCli(["status", "workforest/cli-redesign"]);
    const rendered = renderResult(result);

    expect(result.exitCode, rendered.stdout + rendered.stderr).toBe(0);
    expect(rendered.stderr).toBe("");
    expect(rendered.stdout).toContain("Change status");
    expect(rendered.stdout).toContain("workforest/cli-redesign");
    expect(rendered.stdout).toContain("repository change");
    expect(rendered.stdout).toContain(repoChange);
    expect(rendered.stdout).toContain("workforest - dirty: 1 untracked");
    expect(rendered.stdout).toContain("origin/main");
    expect(rendered.stdout).toContain("not integrated");
    expect(rendered.stdout).toContain("Tasks\n  No nested tasks.");
    expect(rendered.stdout).toContain("Run: git status");
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
    expect(rendered.stdout).toContain("workforest - dirty: 1 untracked");
    expect(rendered.stdout).toContain("setup failed");
    expect(rendered.stdout).toContain("Error: pnpm install failed");
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
    expect(rendered.stdout).toContain("Initialization");
    expect(rendered.stdout).toContain("Change: failed");
    expect(rendered.stdout).toContain("Failed: workforest");
    expect(rendered.stdout).toContain("Inspect initialization details above.");
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
    expect(rendered.stdout).toContain("Initialization");
    expect(rendered.stdout).toContain("Workspace: failed");
    expect(rendered.stdout).toContain("Error:     pnpm install failed");
    expect(rendered.stdout).toContain("Hook:      install");
    expect(rendered.stdout).toContain("Inspect initialization details above.");
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
    expect(rendered.stdout).toContain("Change status");
    expect(rendered.stdout).toContain("Note");
    expect(rendered.stdout).toContain(
      "No initialization is recorded for this change; showing the static report.",
    );
  });

  it("shows a static report for watch outside an interactive terminal", async () => {
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

    const result = await executeCli([
      "status",
      "vercel-agent/auth-fix",
      "--watch",
    ]);
    const rendered = renderResult(result);

    expect(result.exitCode, rendered.stdout + rendered.stderr).toBe(0);
    expect(rendered.stdout).toContain("Initialization");
    expect(rendered.stdout).toContain("Failed:    api");
    expect(rendered.stdout).toContain(
      "Initialization watcher requires an interactive terminal; showing the static report.",
    );
  });

  it("reports ambiguous bare selectors", async () => {
    await createStatusFixture();

    const result = await executeCli(["status", "auth-fix"]);
    const rendered = renderResult(result);

    expect(result.exitCode).toBe(2);
    expect(rendered.stderr).toContain('Ambiguous change selector "auth-fix".');
    expect(rendered.stderr).toContain("_adhoc/auth-fix");
    expect(rendered.stderr).toContain("vercel-agent/auth-fix");
    expect(rendered.stderr).toContain("Use <group>/<change>.");
  });

  it("emits JSON for the current workspace change", async () => {
    const { workspace, apiRepo } = await createStatusFixture();
    process.chdir(apiRepo);
    const loadedConfig = await loadWorkspaceConfig();
    expect(loadedConfig.config.directory?.base).toBe(
      path.dirname(path.dirname(path.dirname(workspace))),
    );
    await expect(
      resolveChangeSelector(loadedConfig.config, undefined),
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
        defaultBranch: "main",
        hasLockfile: true,
      },
      {
        name: "api",
        remote: "git@github.com:vercel/api.git",
        defaultBranch: "main",
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
        defaultBranch: "main",
        hasLockfile: true,
      },
    ],
  });
  await writeRepositoryChangeMetadata(path.dirname(repoChange), {
    featureName: "cli-redesign",
    branchName: "tomdale/cli-redesign",
    repos: [
      {
        name: "workforest",
        remote: "git@github.com:tomdale/workforest.git",
        defaultBranch: "main",
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
