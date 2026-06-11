import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it } from "vitest";
import { saveWorkspaceConfig } from "./config.ts";
import {
  runSubprocess,
  type SubprocessResult,
} from "./test-utils/subprocess.ts";
import {
  readWorkspaceMetadata,
  writeWorkspaceMetadata,
} from "./workspace/metadata.ts";

const CLI_PATH = path.resolve("bin/workforest.js");
const tempDirs: string[] = [];

type WorkspaceFixture = {
  rootDir: string;
  workspaceDir: string;
  repoDir: string;
  unrelatedDir: string;
  configDir: string;
  cacheDir: string;
  homeDir: string;
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("workspace command directory contexts", () => {
  it("discovers status from the workspace root and primary repository", async () => {
    const fixture = await createFixture();

    for (const cwd of [fixture.workspaceDir, fixture.repoDir]) {
      const result = await runCli(fixture, cwd, ["workspace", "status"]);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        "This workspace has no recorded background initialization.",
      );
      expectCliStderr(result).toBe("");
    }
  });

  it("requires workspace context for implicit status and accepts an explicit target", async () => {
    const fixture = await createFixture();

    const implicit = await runCli(fixture, fixture.unrelatedDir, [
      "workspace",
      "status",
    ]);
    expectCliError(
      implicit,
      1,
      "Run wf workspace status from inside a workforest workspace.",
    );

    const explicit = await runCli(fixture, fixture.unrelatedDir, [
      "workspace",
      "status",
      "--workspace",
      fixture.workspaceDir,
    ]);
    expect(explicit.exitCode, explicit.stderr).toBe(0);
    expect(explicit.stdout).toContain(
      "This workspace has no recorded background initialization.",
    );
    expectCliStderr(explicit).toBe("");
  });

  it("opens the named workspace identically from every directory context", async () => {
    const fixture = await createFixture();

    for (const [index, cwd] of [
      fixture.unrelatedDir,
      fixture.workspaceDir,
      fixture.repoDir,
    ].entries()) {
      const cdPathFile = path.join(fixture.rootDir, `open-${index}.path`);
      const result = await runCli(fixture, cwd, ["workspace", "open", "demo"], {
        WORKFOREST_CD_PATH_FILE: cdPathFile,
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expectCliStderr(result).toBe("");
      await expect(readFile(cdPathFile, "utf8")).resolves.toBe(
        `${fixture.workspaceDir}\n`,
      );
    }

    const missingTarget = await runCli(fixture, fixture.repoDir, [
      "workspace",
      "open",
    ]);
    expectCliError(
      missingTarget,
      2,
      "Missing workspace name. Usage: wf workspace open <name>",
    );
  });

  it("adds to an inferred or explicit workspace without changing metadata during dry-run", async () => {
    const fixture = await createFixture();

    for (const cwd of [fixture.workspaceDir, fixture.repoDir]) {
      const result = await runCli(fixture, cwd, [
        "workspace",
        "add",
        "--dry-run",
        "vercel/api",
      ]);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("Workspace:");
      expect(result.stdout).toContain(fixture.workspaceDir);
      expect(result.stdout).toContain("api");
      expectCliStderr(result).toBe("");
    }

    const unrelated = await runCli(fixture, fixture.unrelatedDir, [
      "workspace",
      "add",
      "--dry-run",
      "vercel/api",
    ]);
    expectCliError(
      unrelated,
      1,
      "Not inside a workspace. Run this command from a workspace or pass --workspace <dir>.",
    );

    const explicit = await runCli(fixture, fixture.unrelatedDir, [
      "workspace",
      "add",
      "--dry-run",
      "--workspace",
      fixture.workspaceDir,
      "vercel/api",
    ]);
    expect(explicit.exitCode, explicit.stderr).toBe(0);
    expect(explicit.stdout).toContain("Workspace:");
    expect(explicit.stdout).toContain(fixture.workspaceDir);
    expectCliStderr(explicit).toBe("");

    await expect(
      readWorkspaceMetadata(fixture.workspaceDir),
    ).resolves.toMatchObject({
      repos: [{ name: "front" }],
    });
  });

  it.each([
    "workspace delete",
    "clean",
  ])("%s requires an explicit target in every directory context", async (command) => {
    const fixture = await createFixture();
    const argv = command.split(" ");

    for (const cwd of [
      fixture.unrelatedDir,
      fixture.workspaceDir,
      fixture.repoDir,
    ]) {
      const result = await runCli(fixture, cwd, argv);
      expectCliError(result, 2, "Invalid operands for wf workspace delete");
      await expect(stat(fixture.workspaceDir)).resolves.toBeTruthy();
    }
  });

  it("deletes only the explicit workspace target and reports invalid targets cleanly", async () => {
    const fixture = await createFixture();

    for (const [cwd, target] of [
      [fixture.unrelatedDir, "demo"],
      [fixture.workspaceDir, fixture.workspaceDir],
      [fixture.repoDir, "demo"],
    ] as const) {
      const result = await runCli(fixture, cwd, [
        "workspace",
        "delete",
        "--dry-run",
        target,
      ]);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("Cleanup preview");
      expect(result.stdout).toContain("Directory:");
      expect(result.stdout).toContain(fixture.workspaceDir);
      expect(result.stdout).toContain("Would remove directory:");
      const stderr = cliStderr(result);
      if (cwd === fixture.unrelatedDir) {
        expect(stderr).toBe("");
      } else {
        expect(stderr).toContain("You are inside the workspace being deleted");
      }
      expectStackFree(result.stdout, stderr);
      await expect(stat(fixture.workspaceDir)).resolves.toBeTruthy();
    }

    const invalid = await runCli(fixture, fixture.unrelatedDir, [
      "workspace",
      "delete",
      "missing-workspace",
      "--force",
    ]);
    const invalidStderr = cliStderr(invalid);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stdout).toContain("Available: demo");
    expect(invalidStderr).toContain(
      `Directory does not exist: ${path.join(
        fixture.unrelatedDir,
        "missing-workspace",
      )}`,
    );
    expectStackFree(invalid.stdout, invalidStderr);
    await expect(stat(fixture.workspaceDir)).resolves.toBeTruthy();
  });
});

async function createFixture(): Promise<WorkspaceFixture> {
  const rootDir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "workforest-workspace-context-")),
  );
  tempDirs.push(rootDir);

  const workspaceRoot = path.join(rootDir, "workspaces");
  const workspaceDir = path.join(workspaceRoot, "demo");
  const repoDir = path.join(workspaceDir, "front");
  const unrelatedDir = path.join(rootDir, "unrelated");
  const configDir = path.join(rootDir, "config");
  const cacheDir = path.join(rootDir, "cache");
  const homeDir = path.join(rootDir, "home");

  await Promise.all([
    mkdir(repoDir, { recursive: true }),
    mkdir(unrelatedDir, { recursive: true }),
    mkdir(cacheDir, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
  ]);
  await saveWorkspaceConfig(path.join(configDir, "config.json"), {
    defaultDir: workspaceRoot,
  });
  await initializeGitRepository(repoDir);
  await writeWorkspaceMetadata(workspaceDir, {
    featureName: "demo",
    repos: [
      {
        name: "front",
        remote: "local",
        defaultBranch: "main",
        hasLockfile: false,
      },
    ],
  });

  return {
    rootDir,
    workspaceDir,
    repoDir,
    unrelatedDir,
    configDir,
    cacheDir,
    homeDir,
  };
}

async function initializeGitRepository(repoDir: string): Promise<void> {
  await runChecked("git", ["init", "-q", "-b", "main"], repoDir);
  await runChecked(
    "git",
    ["config", "user.email", "test@example.com"],
    repoDir,
  );
  await runChecked("git", ["config", "user.name", "Workforest Test"], repoDir);
  await runChecked("git", ["config", "commit.gpgsign", "false"], repoDir);
  await writeFile(path.join(repoDir, "README.md"), "fixture\n", "utf8");
  await runChecked("git", ["add", "README.md"], repoDir);
  await runChecked("git", ["commit", "-q", "-m", "Initial commit"], repoDir);
}

async function runChecked(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  const result = await runSubprocess(command, args, { cwd, timeout: 10_000 });
  expect(result.exitCode, result.stderr).toBe(0);
}

function runCli(
  fixture: WorkspaceFixture,
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {},
): Promise<SubprocessResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: "1",
    HOME: fixture.homeDir,
    NO_COLOR: "1",
    WORKFOREST_CACHE_DIR: fixture.cacheDir,
    WORKFOREST_CONFIG_DIR: fixture.configDir,
    WORKFOREST_NO_TUI: "1",
    ...environment,
  };
  Reflect.deleteProperty(env, "FORCE_COLOR");
  if (!environment["WORKFOREST_CD_PATH_FILE"]) {
    Reflect.deleteProperty(env, "WORKFOREST_CD_PATH_FILE");
  }

  return runSubprocess(process.execPath, [CLI_PATH, ...args], {
    cwd,
    env,
    timeout: 10_000,
  });
}

function expectCliError(
  result: SubprocessResult,
  exitCode: number,
  message: string,
): void {
  const stderr = cliStderr(result);
  expect(result.exitCode).toBe(exitCode);
  expect(result.stdout).toBe("");
  expect(stderr).toContain(message);
  expectStackFree(result.stdout, stderr);
}

function expectStackFree(stdout: string, stderr: string): void {
  expect(`${stdout}\n${stderr}`).not.toMatch(/\n\s+at /);
  expect(stderr).not.toContain("node_modules/arg");
  expect(stderr).not.toContain("ArgError");
}

function expectCliStderr(result: SubprocessResult) {
  return expect(cliStderr(result));
}

function cliStderr(result: SubprocessResult): string {
  return stripAnsi(result.stderr)
    .split("\n")
    .filter((line) => !line.includes("Running local copy from "))
    .join("\n")
    .trim();
}
