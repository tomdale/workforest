import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it } from "vitest";
import { renderCommandResult } from "./cli/output.ts";
import { executeCli } from "./cli.ts";
import {
  writeWorkspaceMetadata,
  writeWorktreeMetadata,
} from "./workspace/metadata.ts";

const execFileAsync = promisify(execFile);
const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const tempDirs: string[] = [];

afterEach(async () => {
  if (ORIGINAL_CONFIG_DIR === undefined) {
    delete process.env["WORKFOREST_CONFIG_DIR"];
  } else {
    process.env["WORKFOREST_CONFIG_DIR"] = ORIGINAL_CONFIG_DIR;
  }

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("wf list", () => {
  it("renders the empty change inventory", async () => {
    await createConfigFixture();

    const result = await executeCli(["list"]);
    const rendered = renderResult(result);

    expect(result.exitCode).toBe(0);
    expect(rendered.stdout).toBe(
      [
        "No worktrees or workspaces found.",
        "Start one: wf new <name> <repo|@template>",
        "",
      ].join("\n"),
    );
  });

  it("renders workspace and repository changes grouped by layout", async () => {
    const fixture = await createInventoryFixture();

    const result = await executeCli(["list"]);
    const rendered = renderResult(result);

    expect(result.exitCode).toBe(0);
    expect(rendered.stderr).toBe("");
    expect(rendered.stdout).toContain("Changes\n\nWorkspaces");
    expect(rendered.stdout).toContain("  vercel-agent");
    expect(rendered.stdout).toContain("auth-fix");
    expect(rendered.stdout).toContain("  _adhoc");
    expect(rendered.stdout).toContain("billing");
    expect(rendered.stdout).toContain("Repositories");
    expect(rendered.stdout).toContain("  workforest");
    expect(rendered.stdout).toContain("cli-redesign");
    expect(rendered.stdout).not.toContain(fixture.baseDir);
  });

  it("filters human output and includes paths on request", async () => {
    const fixture = await createInventoryFixture();

    const result = await executeCli([
      "list",
      "--repo",
      "api",
      "--group",
      "_adhoc",
      "--paths",
    ]);
    const rendered = renderResult(result);

    expect(result.exitCode).toBe(0);
    expect(rendered.stderr).toBe("");
    expect(rendered.stdout).toContain("  _adhoc");
    expect(rendered.stdout).toContain("billing");
    expect(rendered.stdout).toContain(
      path.join(fixture.baseDir, "Workspaces", "_adhoc", "billing"),
    );
    expect(rendered.stdout).not.toContain("auth-fix");
    expect(rendered.stdout).not.toContain("cli-redesign");
  });

  it("emits deterministic JSON inventory", async () => {
    await createInventoryFixture();

    const result = await executeCli(["list", "--repo", "api", "--json"]);
    const rendered = renderResult(result);

    expect(result.exitCode).toBe(0);
    expect(rendered.stderr).toBe("");
    expect(JSON.parse(rendered.stdout)).toEqual({
      ok: true,
      data: {
        workspaces: [
          expect.objectContaining({
            type: "template-workspace",
            selector: "vercel-agent/auth-fix",
            groupName: "vercel-agent",
            changeName: "auth-fix",
            repos: ["agents", "api"],
            repoSummary: "agents, api",
            state: "ready",
            path: expect.stringContaining(
              path.join("Workspaces", "vercel-agent", "auth-fix"),
            ),
          }),
          expect.objectContaining({
            type: "adhoc-workspace",
            selector: "_adhoc/billing",
            groupName: "_adhoc",
            changeName: "billing",
            repos: ["front", "api"],
            repoSummary: "front, api",
            state: "ready",
          }),
        ],
        repositories: [],
        totals: {
          workspaces: 2,
          repositories: 0,
        },
      },
    });
  });

  it("ignores metadata-less grouped workspace directories", async () => {
    const { baseDir } = await createConfigFixture();
    const workspace = path.join(baseDir, "Workspaces", "_adhoc", "no-metadata");
    await Promise.all([
      createGitRepo(path.join(workspace, "zeta")),
      createGitRepo(path.join(workspace, "api")),
    ]);

    const result = await executeCli(["list", "--group", "_adhoc", "--json"]);
    const rendered = renderResult(result);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(rendered.stdout)).toEqual({
      ok: true,
      data: {
        workspaces: [],
        repositories: [],
        totals: {
          workspaces: 0,
          repositories: 0,
        },
      },
    });
  });

  it("ignores metadata-less workspace repository directories", async () => {
    const { baseDir } = await createConfigFixture();
    const flatWorkspaceRepo = path.join(
      baseDir,
      "Workspaces",
      "flat-change",
      "api",
    );
    await createGitRepo(flatWorkspaceRepo);
    await Promise.all([
      mkdir(path.join(flatWorkspaceRepo, "packages"), { recursive: true }),
      mkdir(path.join(flatWorkspaceRepo, "src"), { recursive: true }),
    ]);

    const result = await executeCli(["list", "--json"]);
    const rendered = renderResult(result);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(rendered.stdout)).toEqual({
      ok: true,
      data: {
        workspaces: [],
        repositories: [],
        totals: {
          workspaces: 0,
          repositories: 0,
        },
      },
    });
  });
});

async function createConfigFixture(): Promise<{ baseDir: string }> {
  const configDir = await createTempDir("workforest-list-config-");
  const baseDir = await createTempDir("workforest-list-base-");
  process.env["WORKFOREST_CONFIG_DIR"] = configDir;
  await writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ directory: { base: baseDir } }),
    "utf8",
  );
  return { baseDir };
}

async function createInventoryFixture(): Promise<{ baseDir: string }> {
  const { baseDir } = await createConfigFixture();
  const templateWorkspace = path.join(
    baseDir,
    "Workspaces",
    "vercel-agent",
    "auth-fix",
  );
  const adhocWorkspace = path.join(baseDir, "Workspaces", "_adhoc", "billing");
  const repoChange = path.join(baseDir, "Repos", "workforest", "cli-redesign");

  await Promise.all([
    createGitRepo(path.join(templateWorkspace, "agents"), { dirty: true }),
    createGitRepo(path.join(templateWorkspace, "api")),
    createGitRepo(path.join(adhocWorkspace, "front")),
    createGitRepo(path.join(adhocWorkspace, "api")),
    createGitRepo(repoChange),
  ]);

  await writeWorkspaceMetadata(templateWorkspace, {
    featureName: "auth-fix",
    templateId: "vercel-agent",
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
  await writeWorkspaceMetadata(adhocWorkspace, {
    featureName: "billing",
    repos: [
      {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        hasLockfile: true,
      },
      {
        name: "api",
        remote: "git@github.com:vercel/api.git",
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
        hasLockfile: false,
      },
    ],
  });

  return { baseDir };
}

async function createGitRepo(
  dir: string,
  options: { dirty?: boolean } = {},
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: dir });
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
