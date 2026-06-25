import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "./cli/errors.ts";
import {
  parseStartOperands,
  type RunStartCommandOptions,
  runStartCommand,
} from "./cli/start.ts";
import type { ParsedInvocation } from "./cli/types.ts";
import { saveWorkspaceConfig } from "./config.ts";
import { createTemplate } from "./templates/index.ts";
import {
  type RepoInitializationState,
  readRepoInitializationState,
} from "./workspace/initialization.ts";
import {
  readRepositoryChangeMetadata,
  writeWorkspaceMetadata,
} from "./workspace/metadata.ts";

const execFileAsync = promisify(execFile);
const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const ORIGINAL_CACHE_DIR = process.env["WORKFOREST_CACHE_DIR"];
const ORIGINAL_XDG_CONFIG_HOME = process.env["XDG_CONFIG_HOME"];
const ORIGINAL_CWD = process.cwd();
const tempDirs: string[] = [];
type CreateSingleWorktree = NonNullable<
  RunStartCommandOptions["createSingleWorktree"]
>;
type StartRepoInitialization = NonNullable<
  RunStartCommandOptions["startRepoInitialization"]
>;
type StampWorkspace = NonNullable<RunStartCommandOptions["stampWorkspace"]>;

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

describe("parseStartOperands", () => {
  it("parses repository, template, multiple-repository, and current-context sources", () => {
    expect(parseStartOperands(["redesign-cli", "tomdale/workforest"])).toEqual({
      changeName: "redesign-cli",
      source: { kind: "repositories", tokens: ["tomdale/workforest"] },
    });
    expect(parseStartOperands(["auth-fix", "@vercel-agent"])).toEqual({
      changeName: "auth-fix",
      source: { kind: "template", templateName: "vercel-agent" },
    });
    expect(
      parseStartOperands(["billing", "vercel/front", "vercel/api"]),
    ).toEqual({
      changeName: "billing",
      source: { kind: "repositories", tokens: ["vercel/front", "vercel/api"] },
    });
    expect(parseStartOperands(["follow-up"])).toEqual({
      changeName: "follow-up",
      source: { kind: "current" },
    });
  });

  it("rejects mixed or empty template sources", () => {
    expect(() =>
      parseStartOperands(["auth-fix", "@vercel-agent", "vercel/api"]),
    ).toThrow("Template sources cannot be combined with repository sources.");
    expect(() => parseStartOperands(["auth-fix", "@"])).toThrow(
      "Template source must be @<template>.",
    );
  });
});

describe("wf start", () => {
  it("routes a single repository source to the repository change layout", async () => {
    const fixture = await createStartFixture();
    await createCachedMirror(
      fixture.cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );
    const created = fakeCreateSingleWorktree();
    const events: string[] = [];
    created.mockImplementation(async (options) => {
      events.push("create");
      return {
        repo: options.repo,
        branchName: options.branchName,
        targetDir: options.targetDir,
      };
    });
    const started = vi.fn(
      async (
        options: Parameters<StartRepoInitialization>[0],
      ): Promise<RepoInitializationState> => {
        events.push("start");
        const state = await readRepoInitializationState(
          options.scope ?? "",
          options.repo.name,
        );
        expect(state).toMatchObject({
          repo: "front",
          status: "pending",
          attempt: 0,
        });
        if (!state) throw new Error("Expected initialization state");
        return state;
      },
    );

    await runStartCommand(invocation(["redesign-cli", "front"]), {
      interactive: false,
      writeShellCdPath: fixture.writeShellCdPath,
      createSingleWorktree: created,
      startRepoInitialization: started,
    });

    expect(events).toEqual(["create", "start"]);
    expect(created).toHaveBeenCalledWith({
      repo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        defaultBranch: "main",
      },
      branchName: "tomdale/redesign-cli",
      targetDir: path.join(fixture.baseDir, "Repos", "front", "redesign-cli"),
    });
    expect(started).toHaveBeenCalledWith({
      scope: {
        kind: "repository-change",
        repoRootDir: path.join(fixture.baseDir, "Repos", "front"),
        changeName: "redesign-cli",
      },
      repo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        defaultBranch: "main",
      },
    });
    expect(fixture.cdTargets).toEqual([
      path.join(fixture.baseDir, "Repos", "front", "redesign-cli"),
    ]);
    await expect(
      readRepositoryChangeMetadata(
        path.join(fixture.baseDir, "Repos", "front"),
        "redesign-cli",
      ),
    ).resolves.toMatchObject({
      workspace: {
        feature_name: "redesign-cli",
      },
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          default_branch: "main",
          feature_branch: "tomdale/redesign-cli",
          has_lockfile: false,
        },
      ],
    });
  });

  it("uses an explicit branch for a single repository without renaming the change", async () => {
    const fixture = await createStartFixture();
    await createCachedMirror(
      fixture.cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );
    const created = fakeCreateSingleWorktree();

    await runStartCommand(
      invocation(["fix-auth", "front"], { branch: "tomdale/custom" }),
      {
        interactive: false,
        writeShellCdPath: fixture.writeShellCdPath,
        createSingleWorktree: created,
        startRepoInitialization: fakeStartRepoInitialization(),
      },
    );

    expect(created).toHaveBeenCalledWith({
      repo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        defaultBranch: "main",
      },
      branchName: "tomdale/custom",
      targetDir: path.join(fixture.baseDir, "Repos", "front", "fix-auth"),
    });
    await expect(
      readRepositoryChangeMetadata(
        path.join(fixture.baseDir, "Repos", "front"),
        "fix-auth",
      ),
    ).resolves.toMatchObject({
      workspace: {
        feature_name: "fix-auth",
      },
      repos: [
        {
          name: "front",
          feature_branch: "tomdale/custom",
        },
      ],
    });
  });

  it("routes a template source to the template workspace layout", async () => {
    const fixture = await createStartFixture();
    await createCachedMirror(
      fixture.cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );
    await createTemplate("vercel-agent", {
      repos: ["front"],
      branchPrefix: "agent",
    });
    const stamped = fakeStampWorkspace();

    await runStartCommand(invocation(["auth-fix", "@vercel-agent"]), {
      interactive: false,
      writeShellCdPath: fixture.writeShellCdPath,
      stampWorkspace: stamped,
    });

    expect(stamped).toHaveBeenCalledWith({
      featureName: "auth-fix",
      branchName: "agent/auth-fix",
      workspaceDir: path.join(
        fixture.baseDir,
        "Workspaces",
        "vercel-agent",
        "auth-fix",
      ),
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
        },
      ],
      templateId: "vercel-agent",
    });
    expect(fixture.cdTargets).toEqual([
      path.join(fixture.baseDir, "Workspaces", "vercel-agent", "auth-fix"),
    ]);
  });

  it("uses an explicit branch for a template start instead of the template branch prefix", async () => {
    const fixture = await createStartFixture();
    await createCachedMirror(
      fixture.cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );
    await createTemplate("vercel-agent", {
      repos: ["front"],
      branchPrefix: "agent",
    });
    const stamped = fakeStampWorkspace();

    await runStartCommand(
      invocation(["auth-fix", "@vercel-agent"], { branch: "tomdale/custom" }),
      {
        interactive: false,
        writeShellCdPath: fixture.writeShellCdPath,
        stampWorkspace: stamped,
      },
    );

    expect(stamped).toHaveBeenCalledWith({
      featureName: "auth-fix",
      branchName: "tomdale/custom",
      workspaceDir: path.join(
        fixture.baseDir,
        "Workspaces",
        "vercel-agent",
        "auth-fix",
      ),
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
        },
      ],
      templateId: "vercel-agent",
    });
  });

  it("routes multiple repository sources to the _adhoc workspace layout", async () => {
    const fixture = await createStartFixture();
    await createCachedMirror(
      fixture.cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );
    await createCachedMirror(
      fixture.cacheDir,
      "api.git",
      "git@github.com:vercel/api.git",
    );
    const stamped = fakeStampWorkspace();

    await runStartCommand(invocation(["billing", "front", "api"]), {
      interactive: false,
      writeShellCdPath: fixture.writeShellCdPath,
      stampWorkspace: stamped,
    });

    expect(stamped).toHaveBeenCalledWith({
      featureName: "billing",
      branchName: "tomdale/billing",
      workspaceDir: path.join(
        fixture.baseDir,
        "Workspaces",
        "_adhoc",
        "billing",
      ),
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
        },
        {
          name: "api",
          remote: "git@github.com:vercel/api.git",
          defaultBranch: "main",
        },
      ],
    });
  });

  it("uses an explicit branch for multiple repository sources instead of the global branch prefix", async () => {
    const fixture = await createStartFixture();
    await createCachedMirror(
      fixture.cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );
    await createCachedMirror(
      fixture.cacheDir,
      "api.git",
      "git@github.com:vercel/api.git",
    );
    const stamped = fakeStampWorkspace();

    await runStartCommand(
      invocation(["billing", "front", "api"], { branch: "tomdale/custom" }),
      {
        interactive: false,
        writeShellCdPath: fixture.writeShellCdPath,
        stampWorkspace: stamped,
      },
    );

    expect(stamped).toHaveBeenCalledWith({
      featureName: "billing",
      branchName: "tomdale/custom",
      workspaceDir: path.join(
        fixture.baseDir,
        "Workspaces",
        "_adhoc",
        "billing",
      ),
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
        },
        {
          name: "api",
          remote: "git@github.com:vercel/api.git",
          defaultBranch: "main",
        },
      ],
    });
  });

  it("reuses the current repository change source when no source is provided", async () => {
    const fixture = await createStartFixture();
    await createCachedMirror(
      fixture.cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );
    const currentDir = path.join(
      fixture.baseDir,
      "Repos",
      "front",
      "current",
      "src",
    );
    await mkdir(currentDir, { recursive: true });
    process.chdir(currentDir);
    const created = fakeCreateSingleWorktree();

    await runStartCommand(invocation(["follow-up"]), {
      interactive: false,
      writeShellCdPath: fixture.writeShellCdPath,
      createSingleWorktree: created,
      startRepoInitialization: fakeStartRepoInitialization(),
    });

    expect(created).toHaveBeenCalledWith(
      expect.objectContaining({
        branchName: "tomdale/follow-up",
        targetDir: path.join(fixture.baseDir, "Repos", "front", "follow-up"),
      }),
    );
  });

  it("reuses the recorded repo set from the current _adhoc workspace", async () => {
    const fixture = await createStartFixture();
    const workspaceDir = path.join(
      fixture.baseDir,
      "Workspaces",
      "_adhoc",
      "billing",
    );
    const apiDir = path.join(workspaceDir, "api");
    await mkdir(apiDir, { recursive: true });
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "billing",
      branchName: "tomdale/billing",
      repos: [
        metadataRepo("front", "git@github.com:vercel/front.git"),
        metadataRepo("api", "git@github.com:vercel/api.git"),
      ],
    });
    process.chdir(apiDir);
    const stamped = fakeStampWorkspace();

    await runStartCommand(invocation(["follow-up"]), {
      interactive: false,
      writeShellCdPath: fixture.writeShellCdPath,
      stampWorkspace: stamped,
    });

    expect(stamped).toHaveBeenCalledWith({
      featureName: "follow-up",
      branchName: "tomdale/follow-up",
      workspaceDir: path.join(
        fixture.baseDir,
        "Workspaces",
        "_adhoc",
        "follow-up",
      ),
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
        },
        {
          name: "api",
          remote: "git@github.com:vercel/api.git",
          defaultBranch: "main",
        },
      ],
    });
  });

  it("rejects source-less starts outside a Workforest-managed context", async () => {
    const fixture = await createStartFixture();
    const outsideDir = await createTempDir("workforest-outside-");
    process.chdir(outsideDir);

    await expect(
      runStartCommand(invocation(["follow-up"]), {
        interactive: false,
        writeShellCdPath: fixture.writeShellCdPath,
      }),
    ).rejects.toThrow(
      [
        "Not in a Workforest-managed repo or workspace.",
        "Start explicitly: wf start <change> <repo|@template>",
      ].join("\n"),
    );
  });

  it.each([
    ["   ", 'Flag "--branch" requires a non-empty branch name.'],
    ["bad..name", "Invalid Git branch name: bad..name"],
  ])("rejects invalid explicit branch values %#", async (branch, message) => {
    const result = runStartCommand(
      invocation(["fix-auth", "front"], { branch }),
      noOpStartOptions(),
    );

    await expect(result).rejects.toBeInstanceOf(UsageError);
    await expect(result).rejects.toThrow(message);
  });
});

async function createStartFixture(): Promise<{
  baseDir: string;
  cacheDir: string;
  cdTargets: string[];
  writeShellCdPath: (targetDir: string) => Promise<void>;
}> {
  const configDir = await createTempDir("workforest-start-config-");
  const xdgConfigHome = await createTempDir("workforest-start-xdg-");
  const cacheDir = await createTempDir("workforest-start-cache-");
  const baseDir = await createTempDir("workforest-start-base-");
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

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function invocation(
  beforeDoubleDash: readonly string[],
  flags: ParsedInvocation["flags"] = {},
): ParsedInvocation {
  return { beforeDoubleDash, flags } as ParsedInvocation;
}

function noOpStartOptions(): RunStartCommandOptions {
  return {
    interactive: false,
    writeShellCdPath: async () => undefined,
  };
}

function metadataRepo(
  name: string,
  remote: string,
): {
  name: string;
  remote: string;
  defaultBranch: string;
  hasLockfile: boolean;
} {
  return { name, remote, defaultBranch: "main", hasLockfile: false };
}

function fakeCreateSingleWorktree() {
  return vi.fn(async (options: Parameters<CreateSingleWorktree>[0]) => ({
    repo: options.repo,
    branchName: options.branchName,
    targetDir: options.targetDir,
  }));
}

function fakeStartRepoInitialization() {
  return vi.fn(
    async (
      options: Parameters<StartRepoInitialization>[0],
    ): Promise<RepoInitializationState> => {
      const state = await readRepoInitializationState(
        options.scope ?? "",
        options.repo.name,
      );
      if (!state) throw new Error("Expected initialization state");
      return state;
    },
  );
}

function fakeStampWorkspace() {
  return vi.fn(async (options: Parameters<StampWorkspace>[0]) => ({
    workspaceDir: options.workspaceDir,
    setupFailures: [],
    nextSteps: [],
  }));
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
