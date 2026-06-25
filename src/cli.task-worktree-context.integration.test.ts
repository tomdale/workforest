import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  runSubprocess,
  type SubprocessResult,
} from "./test-utils/subprocess.ts";
import {
  appendTasks,
  readWorkspaceMetadata,
  writeRepositoryChangeMetadata,
  writeWorkspaceMetadata,
} from "./workspace/metadata.ts";

const CLI_MODULE_URL = pathToFileURL(path.resolve("src/cli.ts")).href;
const TSX_MODULE_URL = import.meta.resolve("tsx");
const CLI_RUNNER = [
  'process.argv.splice(1, 0, "wf");',
  `import(${JSON.stringify(CLI_MODULE_URL)}).then(({ cli }) => cli());`,
].join("");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("task command workspace context", () => {
  it("infers repositories only from primary repos and tracked task worktrees", async () => {
    const fixture = await createWorkspaceFixture();

    const fromWorkspaceRoot = await runCli(
      fixture.workspaceDir,
      fixture.env,
      "task",
      "list",
    );
    expectSuccess(fromWorkspaceRoot);
    expect(fromWorkspaceRoot.stdout).toContain("front-current");
    expect(fromWorkspaceRoot.stdout).toContain("front-sibling");
    expect(fromWorkspaceRoot.stdout).toContain("docs-current");

    const fromPrimaryRepo = await runCli(
      fixture.frontRepoDir,
      fixture.env,
      "task",
      "list",
    );
    expectSuccess(fromPrimaryRepo);
    expect(fromPrimaryRepo.stdout).toContain("front-current");
    expect(fromPrimaryRepo.stdout).toContain("front-sibling");
    expect(fromPrimaryRepo.stdout).not.toContain("docs-current");

    const fromTaskWorktree = await runCli(
      fixture.frontTaskDir,
      fixture.env,
      "task",
      "list",
    );
    expectSuccess(fromTaskWorktree);
    expect(fromTaskWorktree.stdout).toContain("front-current");
    expect(fromTaskWorktree.stdout).toContain("front-sibling");
    expect(fromTaskWorktree.stdout).not.toContain("docs-current");

    const rootCreate = await runCli(
      fixture.workspaceDir,
      fixture.env,
      "task",
      "start",
      "from-root",
      "--dry-run",
    );
    expectOperationalFailure(
      rootCreate,
      "Run this command from inside a workspace repo, or pass --repo <repoName>.",
    );

    const explicitRootCreate = await runCli(
      fixture.workspaceDir,
      fixture.env,
      "task",
      "start",
      "from-root",
      "--repo",
      "front",
      "--dry-run",
    );
    expectSuccess(explicitRootCreate);
    expect(explicitRootCreate.stdout).toContain("from-root");
    expect(explicitRootCreate.stdout).toContain("front");

    for (const cwd of [fixture.frontRepoDir, fixture.frontTaskDir]) {
      const result = await runCli(
        cwd,
        fixture.env,
        "task",
        "start",
        cwd === fixture.frontRepoDir ? "from-primary" : "from-task",
        "--dry-run",
      );
      expectSuccess(result);
      expect(result.stdout).toContain("front");
    }
  }, 60_000);

  it("deletes only explicit task slugs and never infers a destructive target from cwd", async () => {
    const fixture = await createWorkspaceFixture();

    const missingTarget = await runCli(
      fixture.frontTaskDir,
      fixture.env,
      "task",
      "delete",
      "--force",
    );
    expectUsageFailure(missingTarget, "Invalid operands for wf task delete");
    await expectPathToExist(fixture.frontTaskDir);
    await expectPathToExist(fixture.frontSiblingTaskDir);

    const deleteSibling = await runCli(
      fixture.frontTaskDir,
      fixture.env,
      "task",
      "delete",
      "front-sibling",
      "--force",
    );
    expectSuccess(deleteSibling);
    expect(deleteSibling.stdout).toContain("Removed front-sibling");
    await expectPathToExist(fixture.frontTaskDir);
    await expectPathNotToExist(fixture.frontSiblingTaskDir);
    await expectPathToExist(fixture.docsTaskDir);

    const deleteFromRoot = await runCli(
      fixture.workspaceDir,
      fixture.env,
      "task",
      "delete",
      "docs-current",
      "--force",
    );
    expectSuccess(deleteFromRoot);
    expect(deleteFromRoot.stdout).toContain("Removed docs-current");
    await expectPathToExist(fixture.frontTaskDir);
    await expectPathNotToExist(fixture.docsTaskDir);

    const metadata = await readWorkspaceMetadata(fixture.workspaceDir);
    expect(metadata?.tasks?.map((entry) => entry.slug)).toEqual([
      "front-current",
    ]);
  }, 60_000);

  it("deleting the current workspace task writes a parent repo cd target", async () => {
    const fixture = await createWorkspaceFixture();

    const deleteCurrent = await runCli(
      fixture.frontTaskDir,
      fixture.env,
      "task",
      "delete",
      "front-current",
      "--force",
    );
    expectSuccess(deleteCurrent);
    expect(deleteCurrent.stdout).toContain("Removed front-current");
    await expectPathNotToExist(fixture.frontTaskDir);
    await expect(readCdTarget(fixture.env)).resolves.toBe(
      await realpath(fixture.frontRepoDir),
    );
  }, 60_000);
});

describe("task command repository-change context", () => {
  it("infers the parent repository change from repo task paths", async () => {
    const fixture = await createRepositoryTaskFixture();

    const fromRepositoryChange = await runCli(
      fixture.parentRepoDir,
      fixture.env,
      "task",
      "list",
    );
    expectSuccess(fromRepositoryChange);
    expect(fromRepositoryChange.stdout).toContain("existing-task");
    expect(fromRepositoryChange.stdout).toContain("_tasks/my-feature");

    const fromTaskWorktree = await runCli(
      fixture.taskDir,
      fixture.env,
      "task",
      "start",
      "from-task",
      "--dry-run",
    );
    expectSuccess(fromTaskWorktree);
    expect(fromTaskWorktree.stdout).toContain("from-task");
    expect(fromTaskWorktree.stdout).toContain("_tasks/my-feature");

    const wrongRepo = await runCli(
      fixture.parentRepoDir,
      fixture.env,
      "task",
      "list",
      "--repo",
      "docs",
    );
    expectUsageFailure(
      wrongRepo,
      "Current repository change is front/my-feature",
    );

    const finishTask = await runCli(
      fixture.taskDir,
      fixture.env,
      "task",
      "finish",
      "existing-task",
    );
    expectSuccess(finishTask);
    expect(finishTask.stdout).toContain("Finished existing-task");
    await expectPathNotToExist(fixture.taskDir);
    await expect(readCdTarget(fixture.env)).resolves.toBe(
      await realpath(fixture.parentRepoDir),
    );
  }, 60_000);
});

type CliEnvironment = NodeJS.ProcessEnv;

type WorkspaceFixture = {
  workspaceDir: string;
  frontRepoDir: string;
  frontTaskDir: string;
  frontSiblingTaskDir: string;
  docsTaskDir: string;
  env: CliEnvironment;
};

type RepositoryTaskFixture = {
  parentRepoDir: string;
  taskDir: string;
  env: CliEnvironment;
};

async function createWorkspaceFixture(): Promise<WorkspaceFixture> {
  const rootDir = await createTempDir("workforest-task-context-");
  const workspaceDir = path.join(rootDir, "workspace");
  const frontRepoDir = path.join(workspaceDir, "front");
  const docsRepoDir = path.join(workspaceDir, "docs");
  const frontTaskDir = path.join(
    workspaceDir,
    "_tasks",
    "front",
    "front-current",
  );
  const frontSiblingTaskDir = path.join(
    workspaceDir,
    "_tasks",
    "front",
    "front-sibling",
  );
  const docsTaskDir = path.join(workspaceDir, "_tasks", "docs", "docs-current");
  await mkdir(workspaceDir, { recursive: true });

  const frontSha = await initializeRepository(
    frontRepoDir,
    "tomdale/workspace",
  );
  const docsSha = await initializeRepository(docsRepoDir, "tomdale/workspace");
  await createLinkedWorktree(
    frontRepoDir,
    frontTaskDir,
    "tomdale/front-current",
  );
  await createLinkedWorktree(
    frontRepoDir,
    frontSiblingTaskDir,
    "tomdale/front-sibling",
  );
  await createLinkedWorktree(docsRepoDir, docsTaskDir, "tomdale/docs-current");

  await writeWorkspaceMetadata(workspaceDir, {
    featureName: "workspace",
    branchName: "tomdale/workspace",
    repos: [
      {
        name: "front",
        remote: "git@github.com:example/front.git",
        defaultBranch: "main",
        hasLockfile: false,
      },
      {
        name: "docs",
        remote: "git@github.com:example/docs.git",
        defaultBranch: "main",
        hasLockfile: false,
      },
    ],
  });
  await appendTasks(workspaceDir, [
    taskMetadata("front-current", "front", frontSha),
    taskMetadata("front-sibling", "front", frontSha),
    taskMetadata("docs-current", "docs", docsSha),
  ]);

  return {
    workspaceDir,
    frontRepoDir,
    frontTaskDir,
    frontSiblingTaskDir,
    docsTaskDir,
    env: await createCliEnvironment(rootDir),
  };
}

async function createRepositoryTaskFixture(): Promise<RepositoryTaskFixture> {
  const rootDir = await createTempDir("workforest-repository-task-context-");
  const cacheDir = path.join(rootDir, "cache");
  await createCachedMirror(
    cacheDir,
    "front.git",
    "git@github.com:example/front.git",
  );

  const parentRepoDir = path.join(rootDir, "Repos", "front", "my-feature");
  const taskDir = path.join(
    rootDir,
    "Repos",
    "front",
    "_tasks",
    "my-feature",
    "existing-task",
  );
  await initializeRepository(parentRepoDir, "tomdale/my-feature");
  await createLinkedWorktree(parentRepoDir, taskDir, "tomdale/existing-task");
  await writeRepositoryChangeMetadata(path.dirname(parentRepoDir), {
    featureName: "my-feature",
    branchName: "tomdale/my-feature",
    repos: [
      {
        name: "front",
        remote: "git@github.com:example/front.git",
        defaultBranch: "main",
        hasLockfile: false,
      },
    ],
  });
  return {
    parentRepoDir,
    taskDir,
    env: await createCliEnvironment(rootDir, {
      directory: { base: rootDir },
    }),
  };
}

async function createCachedMirror(
  cacheDir: string,
  directoryName: string,
  remote: string,
): Promise<void> {
  const mirrorDir = path.join(cacheDir, directoryName);
  await mkdir(mirrorDir, { recursive: true });
  await runGit(mirrorDir, "init", "--bare", "--quiet");
  await runGit(mirrorDir, "remote", "add", "origin", remote);
}

async function initializeRepository(
  repositoryDir: string,
  branch: string,
): Promise<string> {
  await mkdir(repositoryDir, { recursive: true });
  await runGit(repositoryDir, "init", "-b", "main");
  await runGit(repositoryDir, "config", "user.name", "Workforest Tests");
  await runGit(
    repositoryDir,
    "config",
    "user.email",
    "workforest-tests@example.com",
  );
  await runGit(repositoryDir, "config", "commit.gpgsign", "false");
  await writeFile(path.join(repositoryDir, "README.md"), "fixture\n", "utf8");
  await runGit(repositoryDir, "add", "README.md");
  await runGit(repositoryDir, "commit", "-m", "Initial commit");
  if (branch !== "main") {
    await runGit(repositoryDir, "switch", "-c", branch);
  }
  return (await runGit(repositoryDir, "rev-parse", "HEAD")).stdout.trim();
}

async function createLinkedWorktree(
  repositoryDir: string,
  worktreeDir: string,
  branch: string,
): Promise<void> {
  await runGit(
    repositoryDir,
    "worktree",
    "add",
    "-b",
    branch,
    worktreeDir,
    "HEAD",
  );
}

function taskMetadata(slug: string, parentRepo: string, baseSha: string) {
  return {
    slug,
    parent_repo: parentRepo,
    path: `_tasks/${parentRepo}/${slug}`,
    branch: `tomdale/${slug}`,
    base_branch: "tomdale/workspace",
    base_sha: baseSha,
    created_at: "2026-06-11T00:00:00.000Z",
    setup_status: "ready" as const,
  };
}

async function createCliEnvironment(
  rootDir: string,
  config: Record<string, unknown> = {},
): Promise<CliEnvironment> {
  const configDir = path.join(rootDir, "config");
  const cacheDir = path.join(rootDir, "cache");
  await Promise.all([
    mkdir(configDir, { recursive: true }),
    mkdir(cacheDir, { recursive: true }),
  ]);
  await writeFile(
    path.join(configDir, "config.json"),
    `${JSON.stringify({ branchPrefix: "tomdale/", ...config }, null, 2)}\n`,
    "utf8",
  );

  return {
    ...process.env,
    CI: "1",
    NO_COLOR: "1",
    WORKFOREST_CACHE_DIR: cacheDir,
    WORKFOREST_CD_PATH_FILE: path.join(rootDir, "cd-path"),
    WORKFOREST_CONFIG_DIR: configDir,
    WORKFOREST_NO_TUI: "1",
  };
}

async function runCli(
  cwd: string,
  env: CliEnvironment,
  ...args: string[]
): Promise<SubprocessResult> {
  return runSubprocess(
    process.execPath,
    ["--import", TSX_MODULE_URL, "--eval", CLI_RUNNER, ...args],
    { cwd, env, timeout: 15_000 },
  );
}

async function runGit(
  cwd: string,
  ...args: string[]
): Promise<SubprocessResult> {
  const result = await runSubprocess("git", args, { cwd, timeout: 10_000 });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr}`,
    );
  }
  return result;
}

function expectSuccess(result: SubprocessResult): void {
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stderr).toBe("");
  expectNoStack(result);
}

function expectUsageFailure(result: SubprocessResult, message: string): void {
  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(message);
  expectNoStack(result);
}

function expectOperationalFailure(
  result: SubprocessResult,
  message: string,
): void {
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(message);
  expectNoStack(result);
}

function expectNoStack(result: SubprocessResult): void {
  const output = `${result.stdout}\n${result.stderr}`;
  expect(output).not.toMatch(/\n\s+at\s/);
  expect(output).not.toContain("node:internal");
  expect(output).not.toContain("ERR_");
}

async function expectPathToExist(targetPath: string): Promise<void> {
  await expect(access(targetPath)).resolves.toBeUndefined();
}

async function expectPathNotToExist(targetPath: string): Promise<void> {
  await expect(access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

async function readCdTarget(env: CliEnvironment): Promise<string> {
  const cdPathFile = env["WORKFOREST_CD_PATH_FILE"];
  if (!cdPathFile) {
    throw new Error("Expected WORKFOREST_CD_PATH_FILE");
  }
  return (await readFile(cdPathFile, "utf8")).trim();
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
