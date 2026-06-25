import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { renderCommandResult } from "./cli/output.ts";
import { executeCli } from "./cli.ts";
import { saveWorkspaceConfig } from "./config.ts";
import {
  readRepositoryChangeMetadata,
  readWorkspaceMetadata,
  writeWorkspaceMetadata,
} from "./workspace/metadata.ts";

const execFileAsync = promisify(execFile);
const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const ORIGINAL_CACHE_DIR = process.env["WORKFOREST_CACHE_DIR"];
const tempDirs: string[] = [];

afterEach(async () => {
  if (ORIGINAL_CONFIG_DIR === undefined) {
    delete process.env["WORKFOREST_CONFIG_DIR"];
  } else {
    process.env["WORKFOREST_CONFIG_DIR"] = ORIGINAL_CONFIG_DIR;
  }
  if (ORIGINAL_CACHE_DIR === undefined) {
    delete process.env["WORKFOREST_CACHE_DIR"];
  } else {
    process.env["WORKFOREST_CACHE_DIR"] = ORIGINAL_CACHE_DIR;
  }

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("wf migrate workspaces", () => {
  it("previews direct workspace directory moves without changing files", async () => {
    const { baseDir } = await createMigrationFixture();
    const source = path.join(baseDir, "Workspaces", "auth-fix");
    const target = path.join(baseDir, "Workspaces", "omniagent", "auth-fix");
    await writeWorkspaceMetadata(source, {
      featureName: "auth-fix",
      templateId: "omniagent",
      repos: [metadataRepo("front")],
    });

    const result = await executeCli(["migrate", "workspaces"]);
    const rendered = renderResult(result);

    expect(result.exitCode).toBe(0);
    expect(rendered.stdout).toContain("Workspace migration plan");
    expect(rendered.stdout).toContain("omniagent/auth-fix");
    await expect(readWorkspaceMetadata(source)).resolves.not.toBeNull();
    await expect(readWorkspaceMetadata(target)).resolves.toBeNull();
  });

  it("moves direct workspace directories into grouped paths", async () => {
    const { baseDir } = await createMigrationFixture();
    const templateSource = path.join(baseDir, "Workspaces", "auth-fix");
    const templateTarget = path.join(
      baseDir,
      "Workspaces",
      "omniagent",
      "auth-fix",
    );
    const adhocSource = path.join(baseDir, "Workspaces", "billing");
    const adhocTarget = path.join(baseDir, "Workspaces", "_adhoc", "billing");
    await writeWorkspaceMetadata(templateSource, {
      featureName: "auth-fix",
      templateId: "omniagent",
      repos: [metadataRepo("front")],
    });
    await writeWorkspaceMetadata(adhocSource, {
      featureName: "billing",
      repos: [metadataRepo("api")],
    });

    const result = await executeCli([
      "migrate",
      "workspaces",
      "--apply",
      "--json",
    ]);
    const rendered = renderResult(result);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(rendered.stdout)).toMatchObject({
      ok: true,
      data: {
        applied: true,
        migrated: [
          expect.objectContaining({ selector: "omniagent/auth-fix" }),
          expect.objectContaining({ selector: "_adhoc/billing" }),
        ],
        blocked: [],
      },
    });
    await expect(readWorkspaceMetadata(templateSource)).resolves.toBeNull();
    await expect(readWorkspaceMetadata(adhocSource)).resolves.toBeNull();
    await expect(readWorkspaceMetadata(templateTarget)).resolves.toMatchObject({
      workspace: { feature_name: "auth-fix", template_id: "omniagent" },
    });
    await expect(readWorkspaceMetadata(adhocTarget)).resolves.toMatchObject({
      workspace: { feature_name: "billing" },
    });
  });

  it("does not move anything when a target already exists", async () => {
    const { baseDir } = await createMigrationFixture();
    const source = path.join(baseDir, "Workspaces", "auth-fix");
    const target = path.join(baseDir, "Workspaces", "omniagent", "auth-fix");
    await writeWorkspaceMetadata(source, {
      featureName: "auth-fix",
      templateId: "omniagent",
      repos: [metadataRepo("front")],
    });
    await mkdir(target, { recursive: true });

    const result = await executeCli(["migrate", "workspaces", "--apply"]);
    const rendered = renderResult(result);

    expect(result.exitCode).toBe(1);
    expect(rendered.stdout).toContain("Blocked");
    expect(rendered.stdout).toContain("Target already exists.");
    await expect(readWorkspaceMetadata(source)).resolves.not.toBeNull();
  });

  it("moves through a temporary path when the target is inside the source", async () => {
    const { baseDir } = await createMigrationFixture();
    const source = path.join(baseDir, "Workspaces", "omniagent");
    const target = path.join(baseDir, "Workspaces", "omniagent", "follow-up");
    await writeWorkspaceMetadata(source, {
      featureName: "follow-up",
      templateId: "omniagent",
      repos: [metadataRepo("front")],
    });

    const result = await executeCli(["migrate", "workspaces", "--apply"]);

    expect(result.exitCode).toBe(0);
    await expect(readWorkspaceMetadata(source)).resolves.toBeNull();
    await expect(readWorkspaceMetadata(target)).resolves.toMatchObject({
      workspace: { feature_name: "follow-up", template_id: "omniagent" },
    });
  });

  it("previews repository metadata backfills without changing files", async () => {
    const { baseDir } = await createMigrationFixture();
    await createRepositoryChange(baseDir, "workforest", "cli-redesign");

    const result = await executeCli(["migrate", "workspaces"]);
    const rendered = renderResult(result);

    expect(result.exitCode).toBe(0);
    expect(rendered.stdout).toContain("Repository metadata ready");
    expect(rendered.stdout).toContain("workforest/cli-redesign");
    await expect(
      readRepositoryChangeMetadata(
        path.join(baseDir, "Repos", "workforest"),
        "cli-redesign",
      ),
    ).resolves.toBeNull();
  });

  it("previews legacy repo-only directory moves without changing files", async () => {
    const { baseDir, cacheDir } = await createMigrationFixture();
    const source = await createLegacyRepositoryChange(
      baseDir,
      cacheDir,
      "workforest",
      "main",
    );
    const target = path.join(baseDir, "Repos", "workforest", "main");

    const result = await executeCli(["migrate", "workspaces"]);
    const rendered = renderResult(result);

    expect(result.exitCode).toBe(0);
    expect(rendered.stdout).toContain("Repository directories ready");
    expect(rendered.stdout).toContain("workforest/main");
    await expect(
      execFileAsync("git", ["status", "--short"], { cwd: source }),
    ).resolves.toHaveProperty("stdout");
    await expect(
      execFileAsync("git", ["status", "--short"], { cwd: target }),
    ).rejects.toThrow();
  });

  it("ignores legacy-looking repo-only directories that are not cached worktrees", async () => {
    const { baseDir } = await createMigrationFixture();
    const source = await createRepositoryChangeIn(
      baseDir,
      "workforest",
      "main",
    );

    const result = await executeCli(["migrate", "workspaces"]);
    const rendered = renderResult(result);

    expect(result.exitCode).toBe(0);
    expect(rendered.stdout).not.toContain("Repository directories ready");
    await expect(
      execFileAsync("git", ["status", "--short"], { cwd: source }),
    ).resolves.toHaveProperty("stdout");
  });

  it("moves legacy repo-only directories into repository change paths", async () => {
    const { baseDir, cacheDir } = await createMigrationFixture();
    const source = await createLegacyRepositoryChange(
      baseDir,
      cacheDir,
      "workforest",
      "main",
    );
    const target = path.join(baseDir, "Repos", "workforest", "main");

    const result = await executeCli([
      "migrate",
      "workspaces",
      "--apply",
      "--json",
    ]);
    const rendered = renderResult(result);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(rendered.stdout)).toMatchObject({
      ok: true,
      data: {
        applied: true,
        repositoryDirectories: {
          migrated: [expect.objectContaining({ selector: "workforest/main" })],
          blocked: [],
        },
      },
    });
    await expect(
      execFileAsync("git", ["status", "--short"], { cwd: source }),
    ).rejects.toThrow();
    await expect(
      execFileAsync("git", ["status", "--short"], { cwd: target }),
    ).resolves.toHaveProperty("stdout");
    await expect(
      readRepositoryChangeMetadata(
        path.join(baseDir, "Repos", "workforest"),
        "main",
      ),
    ).resolves.toMatchObject({
      workspace: { feature_name: "main" },
      repos: [
        {
          name: "workforest",
          remote: "git@github.com:tomdale/workforest.git",
          feature_branch: "tomdale/main",
          has_lockfile: true,
        },
      ],
    });
  });

  it("writes repository metadata under the repo root", async () => {
    const { baseDir } = await createMigrationFixture();
    await createRepositoryChange(baseDir, "workforest", "cli-redesign");

    const result = await executeCli(["migrate", "workspaces", "--apply"]);
    const rendered = renderResult(result);

    expect(result.exitCode).toBe(0);
    expect(rendered.stdout).toContain("Repository metadata written");
    await expect(
      readRepositoryChangeMetadata(
        path.join(baseDir, "Repos", "workforest"),
        "cli-redesign",
      ),
    ).resolves.toMatchObject({
      workspace: { feature_name: "cli-redesign" },
      repos: [
        {
          name: "workforest",
          remote: "git@github.com:tomdale/workforest.git",
          feature_branch: "tomdale/cli-redesign",
          has_lockfile: true,
        },
      ],
    });
  });
});

async function createMigrationFixture(): Promise<{
  baseDir: string;
  cacheDir: string;
}> {
  const configDir = await createTempDir("workforest-migrate-config-");
  const cacheDir = await createTempDir("workforest-migrate-cache-");
  const baseDir = await createTempDir("workforest-migrate-base-");
  process.env["WORKFOREST_CONFIG_DIR"] = configDir;
  process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
  await saveWorkspaceConfig(path.join(configDir, "config.json"), {
    directory: { base: baseDir },
    branchPrefix: "tomdale",
  });
  return { baseDir, cacheDir };
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createRepositoryChange(
  baseDir: string,
  repoName: string,
  changeName: string,
): Promise<string> {
  return createRepositoryChangeIn(
    path.join(baseDir, "Repos"),
    repoName,
    changeName,
  );
}

async function createLegacyRepositoryChange(
  baseDir: string,
  cacheDir: string,
  repoName: string,
  changeName: string,
): Promise<string> {
  const seedDir = await createTempDir("workforest-migrate-seed-");
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: seedDir });
  await execFileAsync("git", ["config", "user.name", "Workforest Tests"], {
    cwd: seedDir,
  });
  await execFileAsync(
    "git",
    ["config", "user.email", "workforest-tests@example.com"],
    { cwd: seedDir },
  );
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], {
    cwd: seedDir,
  });
  await writeFile(path.join(seedDir, "README.md"), "fixture\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: seedDir });
  await execFileAsync("git", ["commit", "-q", "-m", "Initial commit"], {
    cwd: seedDir,
  });

  const mirrorDir = path.join(cacheDir, `${repoName}.git`);
  await execFileAsync("git", ["clone", "--bare", seedDir, mirrorDir]);
  await execFileAsync(
    "git",
    ["remote", "set-url", "origin", `git@github.com:tomdale/${repoName}.git`],
    { cwd: mirrorDir },
  );
  await execFileAsync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: mirrorDir,
  });

  const changeDir = path.join(baseDir, repoName, changeName);
  await mkdir(path.dirname(changeDir), { recursive: true });
  await execFileAsync(
    "git",
    ["worktree", "add", "-b", `tomdale/${changeName}`, changeDir, "main"],
    { cwd: mirrorDir },
  );
  await writeFile(path.join(changeDir, "pnpm-lock.yaml"), "lockfile\n", "utf8");
  return changeDir;
}

async function createRepositoryChangeIn(
  rootDir: string,
  repoName: string,
  changeName: string,
): Promise<string> {
  const changeDir = path.join(rootDir, repoName, changeName);
  await mkdir(changeDir, { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", `tomdale/${changeName}`], {
    cwd: changeDir,
  });
  await execFileAsync(
    "git",
    ["remote", "add", "origin", `git@github.com:tomdale/${repoName}.git`],
    { cwd: changeDir },
  );
  await writeFile(path.join(changeDir, "pnpm-lock.yaml"), "lockfile\n", "utf8");
  return changeDir;
}

function metadataRepo(name: string): {
  name: string;
  remote: string;
  defaultBranch: string;
  hasLockfile: boolean;
} {
  return {
    name,
    remote: `git@github.com:vercel/${name}.git`,
    defaultBranch: "main",
    hasLockfile: true,
  };
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
  return { stdout, stderr };
}
