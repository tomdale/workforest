import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseAddOperands,
  type RunAddCommandOptions,
  runAddCommand,
} from "./cli/add.ts";
import type { ParsedInvocation } from "./cli/types.ts";
import { saveWorkspaceConfig } from "./config.ts";
import { createTemplate } from "./templates/index.ts";
import type { AddReposOptions, AddReposResult } from "./workspace/index.ts";
import {
  appendWorkspaceRepos,
  readWorkspaceMetadata,
  readWorktreeMetadata,
  writeWorkspaceMetadata,
  writeWorktreeMetadata,
} from "./workspace/metadata.ts";

const execFileAsync = promisify(execFile);
const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const ORIGINAL_CACHE_DIR = process.env["WORKFOREST_CACHE_DIR"];
const ORIGINAL_XDG_CONFIG_HOME = process.env["XDG_CONFIG_HOME"];
const ORIGINAL_CWD = process.cwd();
const tempDirs: string[] = [];

type AddReposToWorkspace = NonNullable<
  RunAddCommandOptions["addReposToWorkspace"]
>;
type MoveRepoWorktree = NonNullable<RunAddCommandOptions["moveRepoWorktree"]>;

afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(ORIGINAL_CWD);
  restoreEnv("WORKFOREST_CONFIG_DIR", ORIGINAL_CONFIG_DIR);
  restoreEnv("WORKFOREST_CACHE_DIR", ORIGINAL_CACHE_DIR);
  restoreEnv("XDG_CONFIG_HOME", ORIGINAL_XDG_CONFIG_HOME);
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("parseAddOperands", () => {
  it("parses repository and template sources", () => {
    expect(parseAddOperands(["vercel/api"])).toEqual({
      kind: "repositories",
      tokens: ["vercel/api"],
    });
    expect(parseAddOperands(["vercel/api", "vercel/web"])).toEqual({
      kind: "repositories",
      tokens: ["vercel/api", "vercel/web"],
    });
    expect(parseAddOperands(["@vercel-agent"])).toEqual({
      kind: "template",
      templateName: "vercel-agent",
    });
  });

  it("rejects missing, mixed, and empty template sources", () => {
    expect(() => parseAddOperands([])).toThrow(
      "wf add requires a repository or @template source.",
    );
    expect(() => parseAddOperands(["@", "vercel/api"])).toThrow(
      "Template sources cannot be combined with repository sources.",
    );
    expect(() => parseAddOperands(["@"])).toThrow(
      "Template source must be @<template>.",
    );
  });
});

describe("wf add", () => {
  it("adds repository sources to the current workspace change", async () => {
    const fixture = await createAddFixture();
    await createCachedMirror(
      fixture.cacheDir,
      "api.git",
      "git@github.com:vercel/api.git",
    );
    const workspaceDir = await createWorkspace(fixture);
    const comparableWorkspaceDir = await realpath(workspaceDir);
    process.chdir(path.join(workspaceDir, "front"));
    const addReposToWorkspace = fakeAddReposToWorkspace();

    await runAddCommand(invocation(["api"]), {
      interactive: false,
      writeShellCdPath: fixture.writeShellCdPath,
      addReposToWorkspace,
    });

    expect(addReposToWorkspace).toHaveBeenCalledWith({
      workspaceDir: comparableWorkspaceDir,
      repos: [
        {
          name: "api",
          remote: "git@github.com:vercel/api.git",
        },
      ],
      branchName: "tomdale/billing",
    });
    expect(fixture.cdTargets).toEqual([comparableWorkspaceDir]);
  });

  it("requires --yes before promoting without an interactive terminal", async () => {
    const fixture = await createAddFixture();
    await createCachedMirror(
      fixture.cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );
    const sourcePath = await createWorktree(fixture);
    process.chdir(sourcePath);

    await expect(
      runAddCommand(invocation(["vercel/api"]), {
        interactive: false,
        writeShellCdPath: fixture.writeShellCdPath,
      }),
    ).rejects.toThrow(
      "Promoting a worktree requires --yes without an interactive terminal.",
    );
  });

  it("promotes a repository change into an _adhoc workspace", async () => {
    const fixture = await createAddFixture();
    await Promise.all([
      createCachedMirror(
        fixture.cacheDir,
        "front.git",
        "git@github.com:vercel/front.git",
      ),
      createCachedMirror(
        fixture.cacheDir,
        "api.git",
        "git@github.com:vercel/api.git",
      ),
    ]);
    const sourcePath = await createWorktree(fixture);
    const comparableSourcePath = await realpath(sourcePath);
    process.chdir(sourcePath);
    const addReposToWorkspace = fakeAddReposToWorkspace({
      updateMetadata: true,
    });
    const moveRepoWorktree = fakeMoveRepoWorktree();

    await runAddCommand(invocation(["api"], { yes: true }), {
      interactive: false,
      writeShellCdPath: fixture.writeShellCdPath,
      addReposToWorkspace,
      moveRepoWorktree,
    });

    const workspaceDir = path.join(
      fixture.baseDir,
      "Workspaces",
      "_adhoc",
      "billing",
    );
    expect(moveRepoWorktree).toHaveBeenCalledWith(
      comparableSourcePath,
      path.join(workspaceDir, "front"),
    );
    expect(addReposToWorkspace).toHaveBeenCalledWith({
      workspaceDir,
      repos: [
        {
          name: "api",
          remote: "git@github.com:vercel/api.git",
        },
      ],
      branchName: "billing",
    });
    await expect(readWorkspaceMetadata(workspaceDir)).resolves.toMatchObject({
      workspace: {
        feature_name: "billing",
      },
      repos: [
        { name: "front", feature_branch: "billing" },
        { name: "api", feature_branch: "billing" },
      ],
    });
    await expect(
      readWorktreeMetadata(
        path.join(fixture.baseDir, "Repos", "front"),
        "billing",
      ),
    ).resolves.toBeNull();
    expect(fixture.cdTargets).toEqual([workspaceDir]);
  });

  it("promotes through a template only when the current repo belongs to it", async () => {
    const fixture = await createAddFixture();
    await Promise.all([
      createCachedMirror(
        fixture.cacheDir,
        "front.git",
        "git@github.com:vercel/front.git",
      ),
      createCachedMirror(
        fixture.cacheDir,
        "api.git",
        "git@github.com:vercel/api.git",
      ),
    ]);
    await createTemplate("vercel-agent", {
      repos: ["front", "api"],
      branchPrefix: "agent",
    });
    const sourcePath = await createWorktree(fixture);
    process.chdir(sourcePath);
    const addReposToWorkspace = fakeAddReposToWorkspace();

    await runAddCommand(invocation(["@vercel-agent"], { yes: true }), {
      interactive: false,
      writeShellCdPath: fixture.writeShellCdPath,
      addReposToWorkspace,
      moveRepoWorktree: fakeMoveRepoWorktree(),
    });

    const workspaceDir = path.join(
      fixture.baseDir,
      "Workspaces",
      "vercel-agent",
      "billing",
    );
    await expect(readWorkspaceMetadata(workspaceDir)).resolves.toMatchObject({
      workspace: {
        feature_name: "billing",
        template_id: "vercel-agent",
      },
      repos: [{ name: "front", feature_branch: "billing" }],
    });
    expect(addReposToWorkspace).toHaveBeenCalledWith({
      workspaceDir,
      repos: [
        {
          name: "api",
          remote: "git@github.com:vercel/api.git",
        },
      ],
      branchName: "billing",
    });
  });

  it("rejects promotion sources that name the current repository again", async () => {
    const fixture = await createAddFixture();
    await createCachedMirror(
      fixture.cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );
    const sourcePath = await createWorktree(fixture);
    process.chdir(sourcePath);

    await expect(
      runAddCommand(invocation(["front"], { yes: true }), {
        interactive: false,
        writeShellCdPath: fixture.writeShellCdPath,
        moveRepoWorktree: fakeMoveRepoWorktree(),
      }),
    ).rejects.toThrow('Change already contains repository "front".');
  });
});

async function createAddFixture(): Promise<{
  baseDir: string;
  cacheDir: string;
  cdTargets: string[];
  writeShellCdPath: (targetDir: string) => Promise<void>;
}> {
  const configDir = await createTempDir("workforest-add-config-");
  const xdgConfigHome = await createTempDir("workforest-add-xdg-");
  const cacheDir = await createTempDir("workforest-add-cache-");
  const baseDir = await createTempDir("workforest-add-base-");
  process.env["WORKFOREST_CONFIG_DIR"] = configDir;
  process.env["XDG_CONFIG_HOME"] = xdgConfigHome;
  process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
  await saveWorkspaceConfig(path.join(configDir, "config.json"), {
    directory: { base: baseDir },
    branchPrefix: "tomdale",
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  const cdTargets: string[] = [];
  return {
    baseDir,
    cacheDir,
    cdTargets,
    writeShellCdPath: async (targetDir) => {
      cdTargets.push(targetDir);
    },
  };
}

async function createWorkspace(fixture: { baseDir: string }): Promise<string> {
  const workspaceDir = path.join(
    fixture.baseDir,
    "Workspaces",
    "_adhoc",
    "billing",
  );
  await mkdir(path.join(workspaceDir, "front"), { recursive: true });
  await writeWorkspaceMetadata(workspaceDir, {
    featureName: "billing",
    branchName: "tomdale/billing",
    repos: [metadataRepo("front", "git@github.com:vercel/front.git")],
  });
  return workspaceDir;
}

async function createWorktree(fixture: { baseDir: string }): Promise<string> {
  const sourcePath = path.join(fixture.baseDir, "Repos", "front", "billing");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "README.md"), "fixture\n", "utf8");
  await writeWorktreeMetadata(path.dirname(sourcePath), {
    featureName: "billing",
    branchName: "billing",
    repos: [metadataRepo("front", "git@github.com:vercel/front.git")],
  });
  return sourcePath;
}

async function createCachedMirror(
  cacheDir: string,
  directoryName: string,
  remote: string,
): Promise<void> {
  const mirrorDir = path.join(cacheDir, directoryName);
  await mkdir(mirrorDir, { recursive: true });
  await execFileAsync("git", ["init", "--bare", "--quiet"], {
    cwd: mirrorDir,
  });
  await execFileAsync("git", ["remote", "add", "origin", remote], {
    cwd: mirrorDir,
  });
  await execFileAsync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: mirrorDir,
  });
}

function fakeAddReposToWorkspace(
  options: { updateMetadata?: boolean } = {},
): AddReposToWorkspace {
  return vi.fn(async (addOptions: AddReposOptions): Promise<AddReposResult> => {
    if (options.updateMetadata) {
      await appendWorkspaceRepos(
        addOptions.workspaceDir,
        addOptions.repos.map((repo) => ({
          name: repo.name,
          remote: repo.remote,
          has_lockfile: false,
          feature_branch: addOptions.branchName,
        })),
      );
    }
    return { addedRepos: addOptions.repos, failedRepos: [] };
  });
}

function fakeMoveRepoWorktree(): MoveRepoWorktree {
  return vi.fn(async (sourcePath: string, destinationPath: string) => {
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await rename(sourcePath, destinationPath);
  });
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function invocation(
  beforeDoubleDash: readonly string[],
  flags: Record<string, boolean> = {},
): ParsedInvocation {
  return { beforeDoubleDash, flags } as ParsedInvocation;
}

function metadataRepo(
  name: string,
  remote: string,
): {
  name: string;
  remote: string;
  hasLockfile: boolean;
} {
  return { name, remote, hasLockfile: false };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
