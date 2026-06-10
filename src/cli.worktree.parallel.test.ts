import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { saveWorkspaceConfig } from "./config.ts";
import {
  readWorkspaceMetadata,
  writeWorkspaceMetadata,
} from "./workspace/metadata.ts";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

type Fixture = {
  rootDir: string;
  workspaceDir: string;
  repoDir: string;
  configDir: string;
};

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("parallel wf worktree commands", () => {
  it("creates distinct worktrees without losing metadata", async () => {
    const fixture = await createFixture();
    const slugs = ["alpha", "beta", "gamma", "delta"];

    const results = await Promise.all(
      slugs.map((slug, index) => runWorktree(fixture, slug, index)),
    );

    expect(results.map((result) => result.code)).toEqual([0, 0, 0, 0]);
    const metadata = await readWorkspaceMetadata(fixture.workspaceDir);
    expect(
      metadata?.temporary_worktrees?.map((entry) => entry.slug).sort(),
    ).toEqual([...slugs].sort());
  }, 30_000);

  it("reports a clear conflict when two commands request the same worktree", async () => {
    const fixture = await createFixture();

    const results = await Promise.all([
      runWorktree(fixture, "duplicate", 0),
      runWorktree(fixture, "duplicate", 1),
    ]);

    expect(results.map((result) => result.code).sort()).toEqual([0, 1]);
    const failure = results.find((result) => result.code === 1);
    expect(`${failure?.stdout}\n${failure?.stderr}`).toMatch(
      /already exists|already checked out|cannot lock ref/i,
    );

    const metadata = await readWorkspaceMetadata(fixture.workspaceDir);
    expect(
      metadata?.temporary_worktrees?.filter(
        (entry) => entry.slug === "duplicate",
      ),
    ).toHaveLength(1);
  }, 30_000);
});

async function createFixture(): Promise<Fixture> {
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), "workforest-parallel-worktree-"),
  );
  tempDirs.push(rootDir);

  const workspaceDir = path.join(rootDir, "workspace");
  const repoDir = path.join(workspaceDir, "front");
  const configDir = path.join(rootDir, "config");
  await mkdir(repoDir, { recursive: true });
  await saveWorkspaceConfig(path.join(configDir, "config.json"), {
    branchPrefix: "tomdale/",
  });

  await runGit(["init", "-q", "-b", "main"], repoDir);
  await runGit(["config", "user.email", "test@example.com"], repoDir);
  await runGit(["config", "user.name", "Workforest Test"], repoDir);
  await writeFile(path.join(repoDir, "README.md"), "fixture\n", "utf8");
  await runGit(["add", "README.md"], repoDir);
  await runGit(["commit", "-q", "-m", "Initial commit"], repoDir);

  await writeWorkspaceMetadata(workspaceDir, {
    featureName: "parallel-worktrees",
    repos: [
      {
        name: "front",
        remote: "local",
        defaultBranch: "main",
        hasLockfile: false,
      },
    ],
  });

  return { rootDir, workspaceDir, repoDir, configDir };
}

async function runGit(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd, timeout: 10_000 });
}

function runWorktree(
  fixture: Fixture,
  slug: string,
  invocation: number,
): Promise<CommandResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: "1",
    NO_COLOR: "1",
    WORKFOREST_CONFIG_DIR: fixture.configDir,
    WORKFOREST_NO_TUI: "1",
    WORKFOREST_CD_PATH_FILE: path.join(
      fixture.rootDir,
      `${slug}-${invocation}.cd`,
    ),
  };
  Reflect.deleteProperty(env, "FORCE_COLOR");

  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.resolve("bin/workforest.js"), "worktree", slug, "--force"],
      {
        cwd: fixture.repoDir,
        encoding: "utf8",
        env,
        timeout: 20_000,
      },
      (error, stdout, stderr) => {
        resolve({
          code:
            typeof error?.code === "number"
              ? error.code
              : error === null
                ? 0
                : 1,
          stdout,
          stderr,
        });
      },
    );
  });
}
