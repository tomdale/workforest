import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const createTasksMock = vi.hoisted(() => vi.fn());
const createRepositoryTasksMock = vi.hoisted(() => vi.fn());

vi.mock("./workspace/tasks.ts", async () => {
  const actual = await vi.importActual<typeof import("./workspace/tasks.ts")>(
    "./workspace/tasks.ts",
  );

  return {
    ...actual,
    createRepositoryTasks: createRepositoryTasksMock,
    createTasks: createTasksMock,
  };
});

import { executeCli } from "./cli.ts";
import { saveWorkspaceConfig } from "./config.ts";
import { WORKFOREST_CD_PATH_ENV } from "./shell.ts";
import { writeWorkspaceMetadata } from "./workspace/metadata.ts";

const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const ORIGINAL_NO_TUI = process.env["WORKFOREST_NO_TUI"];
const ORIGINAL_CD_PATH_FILE = process.env[WORKFOREST_CD_PATH_ENV];
const ORIGINAL_CWD = process.cwd();

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  createTasksMock.mockReset();
  createRepositoryTasksMock.mockReset();
  restoreEnv("WORKFOREST_CONFIG_DIR", ORIGINAL_CONFIG_DIR);
  restoreEnv("WORKFOREST_NO_TUI", ORIGINAL_NO_TUI);
  restoreEnv(WORKFOREST_CD_PATH_ENV, ORIGINAL_CD_PATH_FILE);
  process.chdir(ORIGINAL_CWD);

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("task auto-cd", () => {
  it("prints a manual cd target instead of writing shell auto-cd on setup failure", async () => {
    const fixture = await createWorkspaceTaskFixture();
    const targetDir = path.join(
      fixture.workspaceDir,
      "_tasks",
      "front",
      "fix-tests",
    );
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    createTasksMock.mockResolvedValueOnce({
      created: [
        {
          slug: "fix-tests",
          parentRepo: "front",
          path: targetDir,
          branch: "tomdale/fix-tests",
          setupStatus: "failed",
          setupLog: ".workforest/logs/front-fix-tests.log",
        },
      ],
      failures: [],
    });

    process.chdir(fixture.frontRepoDir);

    const result = await executeCli(["task", "new", "fix-tests"]);

    expect(result.exitCode).toBe(1);
    await expect(access(fixture.cdPathFile)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(logs.join("\n")).toContain(`Run: cd ${targetDir}`);
  });
});

async function createWorkspaceTaskFixture(): Promise<{
  workspaceDir: string;
  frontRepoDir: string;
  cdPathFile: string;
}> {
  const rootDir = await createTempDir("workforest-task-auto-cd-");
  const configDir = path.join(rootDir, "config");
  const workspaceDir = path.join(rootDir, "workspace");
  const frontRepoDir = path.join(workspaceDir, "front");
  const cdPathFile = path.join(rootDir, "cd-path");

  await mkdir(frontRepoDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await saveWorkspaceConfig(path.join(configDir, "config.json"), {
    branchPrefix: "tomdale/",
  });
  await writeWorkspaceMetadata(workspaceDir, {
    featureName: "workspace",
    branchName: "tomdale/workspace",
    repos: [
      {
        name: "front",
        remote: "git@github.com:example/front.git",
        hasLockfile: false,
      },
    ],
  });

  process.env["WORKFOREST_CONFIG_DIR"] = configDir;
  process.env["WORKFOREST_NO_TUI"] = "1";
  process.env[WORKFOREST_CD_PATH_ENV] = cdPathFile;

  return { workspaceDir, frontRepoDir, cdPathFile };
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
