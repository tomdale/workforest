import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "./cli/errors.ts";
import {
  parseNewOperands,
  type RunNewCommandOptions,
  runNewCommand,
} from "./cli/new.ts";
import type { ParsedInvocation } from "./cli/types.ts";
import { saveWorkspaceConfig } from "./config.ts";
import { createTemplate, createTemplateVariant } from "./templates/index.ts";
import { buildCreateInput } from "./workspace/create.ts";
import {
  readWorktreeMetadata,
  writeWorkspaceMetadata,
} from "./workspace/metadata.ts";
import type { RepoPipelineState } from "./workspace/pipeline.ts";

const execFileAsync = promisify(execFile);
const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const ORIGINAL_CACHE_DIR = process.env["WORKFOREST_CACHE_DIR"];
const ORIGINAL_XDG_CONFIG_HOME = process.env["XDG_CONFIG_HOME"];
const ORIGINAL_CWD = process.cwd();
const tempDirs: string[] = [];
type RunScopedRepoSetupPipeline = NonNullable<
  RunNewCommandOptions["runScopedRepoSetupPipeline"]
>;
type StampWorkspace = NonNullable<RunNewCommandOptions["stampWorkspace"]>;
type PresentRun = NonNullable<RunNewCommandOptions["presentRun"]>;

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

describe("parseNewOperands", () => {
  it("parses repository, template, multiple-repository, and current-context sources", () => {
    expect(parseNewOperands(["redesign-cli", "tomdale/workforest"])).toEqual({
      changeName: "redesign-cli",
      source: { kind: "repositories", tokens: ["tomdale/workforest"] },
    });
    expect(parseNewOperands(["auth-fix", "@vercel-agent"])).toEqual({
      changeName: "auth-fix",
      source: { kind: "template", templateName: "vercel-agent" },
    });
    expect(parseNewOperands(["billing", "vercel/front", "vercel/api"])).toEqual(
      {
        changeName: "billing",
        source: {
          kind: "repositories",
          tokens: ["vercel/front", "vercel/api"],
        },
      },
    );
    expect(parseNewOperands(["follow-up"])).toEqual({
      changeName: "follow-up",
      source: { kind: "current" },
    });
  });

  it("rejects mixed or empty template sources", () => {
    expect(() =>
      parseNewOperands(["auth-fix", "@vercel-agent", "vercel/api"]),
    ).toThrow("Template sources cannot be combined with repository sources.");
    expect(() => parseNewOperands(["auth-fix", "@"])).toThrow(
      "Template source must be @<template>.",
    );
  });
});

describe("wf new", () => {
  it("routes a single repository source through the repo setup pipeline", async () => {
    const fixture = await createStartFixture();
    await createCachedMirror(
      fixture.cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );
    const pipeline = fakeRepoSetupPipeline();

    await runNewCommand(invocation(["redesign-cli", "front"]), {
      interactive: false,
      writeShellCdPath: fixture.writeShellCdPath,
      runScopedRepoSetupPipeline: pipeline,
    });

    const repoRootDir = path.join(fixture.baseDir, "Repos", "front");
    const targetDir = path.join(repoRootDir, "redesign-cli");
    expect(pipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: {
          name: "front",
          remote: "git@github.com:vercel/front.git",
        },
        branchName: "tomdale/redesign-cli",
        rootDir: repoRootDir,
        repoDir: targetDir,
        scope: {
          kind: "worktree",
          repoRootDir,
          changeName: "redesign-cli",
        },
        isNewWorkspace: true,
        monitorBackground: false,
      }),
    );
    expect(fixture.cdTargets).toEqual([targetDir]);
    await expect(
      readWorktreeMetadata(repoRootDir, "redesign-cli"),
    ).resolves.toMatchObject({
      workspace: {
        feature_name: "redesign-cli",
      },
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          feature_branch: "tomdale/redesign-cli",
          has_lockfile: false,
        },
      ],
    });
  });

  it("drives a single-repo interactive start through the setup view", async () => {
    const fixture = await createStartFixture();
    await createCachedMirror(
      fixture.cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );
    const pipeline = fakeRepoSetupPipeline();
    const presentRun = fakePresentRun([["front", { hasLockfile: false }]]);

    await runNewCommand(invocation(["redesign-cli", "front"]), {
      interactive: true,
      writeShellCdPath: fixture.writeShellCdPath,
      runScopedRepoSetupPipeline: pipeline,
      initializeWorktreeSetup: vi.fn(async () => undefined),
      shouldUseGrid: () => true,
      presentRun,
    });

    // Single-repo creation renders the worktree pipeline through the same
    // session-native seam as multi-repo, deferring finalization into
    // onBeforeCompletionPrompt.
    expect(presentRun).toHaveBeenCalledTimes(1);
    const presentOptions = presentRun.mock.calls[0]?.[0];
    expect(presentOptions?.repoNames).toEqual(["front"]);
    expect(presentOptions?.pipelines.size).toBe(1);
    expect(presentOptions?.pipelines.has("front")).toBe(true);
    expect(presentOptions?.interactive).toBe(true);
    expect(presentOptions?.session).toBeDefined();
    expect(presentOptions?.scope).toEqual(
      expect.objectContaining({ kind: "worktree" }),
    );
    expect(typeof presentOptions?.onBeforeCompletionPrompt).toBe("function");
    // The attached grid renders worker progress from the event stream; the
    // pipeline itself ends at handoff.
    expect(pipeline).toHaveBeenCalledWith(
      expect.objectContaining({ monitorBackground: false }),
    );
    expect(fixture.cdTargets).toEqual([
      path.join(fixture.baseDir, "Repos", "front", "redesign-cli"),
    ]);
  });

  it("keeps a failed interactive start failed while writing the cd target", async () => {
    const fixture = await createStartFixture();
    await createCachedMirror(
      fixture.cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );
    const targetDir = path.join(
      fixture.baseDir,
      "Repos",
      "front",
      "redesign-cli",
    );

    const result = await runNewCommand(invocation(["redesign-cli", "front"]), {
      interactive: true,
      writeShellCdPath: fixture.writeShellCdPath,
      initializeWorktreeSetup: vi.fn(async () => undefined),
      shouldUseGrid: () => true,
      presentRun: fakeFailedPresentRun("front"),
    });

    expect(result.exitCode).toBe(1);
    expect(fixture.cdTargets).toEqual([targetDir]);
  });

  it("drives an interactive workspace start through the setup view", async () => {
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
    const presentRun = fakePresentRun([
      ["front", { hasLockfile: false }],
      ["api", { hasLockfile: false }],
    ]);

    await runNewCommand(invocation(["billing", "front", "api"]), {
      interactive: true,
      writeShellCdPath: fixture.writeShellCdPath,
      shouldUseGrid: () => true,
      presentRun,
    });

    expect(presentRun).toHaveBeenCalledTimes(1);
    const presentOptions = presentRun.mock.calls[0]?.[0];
    expect(presentOptions?.repoNames).toEqual(["front", "api"]);
    expect(presentOptions?.pipelines.size).toBe(2);
    expect(presentOptions?.targetDir).toBe(
      path.join(fixture.baseDir, "Workspaces", "_adhoc", "billing"),
    );
    expect(presentOptions?.interactive).toBe(true);
    expect(presentOptions?.session).toBeDefined();
    expect(typeof presentOptions?.onBeforeCompletionPrompt).toBe("function");
    expect(fixture.cdTargets).toEqual([
      path.join(fixture.baseDir, "Workspaces", "_adhoc", "billing"),
    ]);
  });

  it("uses an explicit branch for a single repository without renaming the change", async () => {
    const fixture = await createStartFixture();
    await createCachedMirror(
      fixture.cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );
    const pipeline = fakeRepoSetupPipeline();

    await runNewCommand(
      invocation(["fix-auth", "front"], { branch: "tomdale/custom" }),
      {
        interactive: false,
        writeShellCdPath: fixture.writeShellCdPath,
        runScopedRepoSetupPipeline: pipeline,
      },
    );

    expect(pipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: {
          name: "front",
          remote: "git@github.com:vercel/front.git",
        },
        branchName: "tomdale/custom",
        repoDir: path.join(fixture.baseDir, "Repos", "front", "fix-auth"),
      }),
    );
    await expect(
      readWorktreeMetadata(
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

  it("uses the current repository root for a source-less start", async () => {
    const fixture = await createStartFixture();
    await createCachedMirror(
      fixture.cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );
    const repoRoot = path.join(fixture.baseDir, "Repos", "front");
    await mkdir(repoRoot, { recursive: true });
    process.chdir(repoRoot);
    const pipeline = fakeRepoSetupPipeline();

    await runNewCommand(invocation(["follow-up"]), {
      interactive: false,
      writeShellCdPath: fixture.writeShellCdPath,
      runScopedRepoSetupPipeline: pipeline,
    });

    expect(pipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: {
          name: "front",
          remote: "git@github.com:vercel/front.git",
        },
        branchName: "tomdale/follow-up",
        repoDir: path.join(fixture.baseDir, "Repos", "front", "follow-up"),
      }),
    );
    expect(fixture.cdTargets).toEqual([
      path.join(fixture.baseDir, "Repos", "front", "follow-up"),
    ]);
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

    await runNewCommand(invocation(["auth-fix", "@vercel-agent"]), {
      interactive: false,
      writeShellCdPath: fixture.writeShellCdPath,
      stampWorkspace: stamped,
    });

    expect(stamped).toHaveBeenCalledWith({
      interactive: false,
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
        },
      ],
      templateId: "vercel-agent",
    });
    expect(fixture.cdTargets).toEqual([
      path.join(fixture.baseDir, "Workspaces", "vercel-agent", "auth-fix"),
    ]);
  });

  it("routes a template variant to a canonical group and split metadata", async () => {
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
    await createTemplateVariant("vercel-agent", "chat", {
      branchPrefix: "chat",
    });
    const stamped = fakeStampWorkspace();

    await runNewCommand(invocation(["auth-fix", "@vercel-agent+chat"]), {
      interactive: false,
      writeShellCdPath: fixture.writeShellCdPath,
      stampWorkspace: stamped,
    });

    expect(stamped).toHaveBeenCalledWith({
      interactive: false,
      featureName: "auth-fix",
      branchName: "chat/auth-fix",
      workspaceDir: path.join(
        fixture.baseDir,
        "Workspaces",
        "vercel-agent+chat",
        "auth-fix",
      ),
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
        },
      ],
      templateId: "vercel-agent",
      templateVariant: "chat",
    });
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

    await runNewCommand(
      invocation(["auth-fix", "@vercel-agent"], { branch: "tomdale/custom" }),
      {
        interactive: false,
        writeShellCdPath: fixture.writeShellCdPath,
        stampWorkspace: stamped,
      },
    );

    expect(stamped).toHaveBeenCalledWith({
      interactive: false,
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

    await runNewCommand(invocation(["billing", "front", "api"]), {
      interactive: false,
      writeShellCdPath: fixture.writeShellCdPath,
      stampWorkspace: stamped,
    });

    expect(stamped).toHaveBeenCalledWith({
      interactive: false,
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
        },
        {
          name: "api",
          remote: "git@github.com:vercel/api.git",
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

    await runNewCommand(
      invocation(["billing", "front", "api"], { branch: "tomdale/custom" }),
      {
        interactive: false,
        writeShellCdPath: fixture.writeShellCdPath,
        stampWorkspace: stamped,
      },
    );

    expect(stamped).toHaveBeenCalledWith({
      interactive: false,
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
        },
        {
          name: "api",
          remote: "git@github.com:vercel/api.git",
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
    const pipeline = fakeRepoSetupPipeline();

    await runNewCommand(invocation(["follow-up"]), {
      interactive: false,
      writeShellCdPath: fixture.writeShellCdPath,
      runScopedRepoSetupPipeline: pipeline,
    });

    expect(pipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        branchName: "tomdale/follow-up",
        repoDir: path.join(fixture.baseDir, "Repos", "front", "follow-up"),
      }),
    );
  });

  it("uses the repository root as the source when no source is provided", async () => {
    const fixture = await createStartFixture();
    await createCachedMirror(
      fixture.cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );
    const currentDir = path.join(fixture.baseDir, "Repos", "front");
    await mkdir(currentDir, { recursive: true });
    process.chdir(currentDir);
    const pipeline = fakeRepoSetupPipeline();

    await runNewCommand(invocation(["follow-up"]), {
      interactive: false,
      writeShellCdPath: fixture.writeShellCdPath,
      runScopedRepoSetupPipeline: pipeline,
    });

    expect(pipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: {
          name: "front",
          remote: "git@github.com:vercel/front.git",
        },
        branchName: "tomdale/follow-up",
        rootDir: currentDir,
        repoDir: path.join(fixture.baseDir, "Repos", "front", "follow-up"),
        scope: {
          kind: "worktree",
          repoRootDir: currentDir,
          changeName: "follow-up",
        },
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

    await runNewCommand(invocation(["follow-up"]), {
      interactive: false,
      writeShellCdPath: fixture.writeShellCdPath,
      stampWorkspace: stamped,
    });

    expect(stamped).toHaveBeenCalledWith({
      interactive: false,
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
        },
        {
          name: "api",
          remote: "git@github.com:vercel/api.git",
        },
      ],
    });
  });

  it("rejects source-less starts outside a Workforest-managed context", async () => {
    const fixture = await createStartFixture();
    const outsideDir = await createTempDir("workforest-outside-");
    process.chdir(outsideDir);

    await expect(
      runNewCommand(invocation(["follow-up"]), {
        interactive: false,
        writeShellCdPath: fixture.writeShellCdPath,
      }),
    ).rejects.toThrow(
      [
        "Not in a Workforest-managed repo or workspace.",
        "Create explicitly: wf new <name> <repo|@template>",
      ].join("\n"),
    );
  });

  it.each([
    ["   ", 'Flag "--branch" requires a non-empty branch name.'],
    ["bad..name", "Invalid Git branch name: bad..name"],
  ])("rejects invalid explicit branch values %#", async (branch, message) => {
    const result = runNewCommand(
      invocation(["fix-auth", "front"], { branch }),
      noOpStartOptions(),
    );

    await expect(result).rejects.toBeInstanceOf(UsageError);
    await expect(result).rejects.toThrow(message);
  });
});

describe("buildCreateInput", () => {
  it("resolves a single repo token to a repository change input", async () => {
    const fixture = await createStartFixture();
    await createCachedMirror(
      fixture.cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );

    const input = await buildCreateInput({
      changeName: "redesign-cli",
      sources: [{ kind: "repo", token: "front" }],
    });

    expect(input).toEqual({
      changeName: "redesign-cli",
      branchName: "tomdale/redesign-cli",
      source: {
        kind: "repository",
        repo: {
          name: "front",
          remote: "git@github.com:vercel/front.git",
        },
      },
      directories: expect.objectContaining({ base: fixture.baseDir }),
    });
  });

  it("resolves multiple repo tokens to an adhoc workspace input", async () => {
    const fixture = await createStartFixture();
    for (const name of ["front", "api"]) {
      await createCachedMirror(
        fixture.cacheDir,
        `${name}.git`,
        `git@github.com:vercel/${name}.git`,
      );
    }

    const input = await buildCreateInput({
      changeName: "billing",
      sources: [
        { kind: "repo", token: "front" },
        { kind: "repo", token: "api" },
      ],
    });

    expect(input.source.kind).toBe("adhoc");
    expect(input.branchName).toBe("tomdale/billing");
  });

  it("resolves a template source and applies its branch prefix", async () => {
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

    const input = await buildCreateInput({
      changeName: "auth-fix",
      sources: [{ kind: "template", name: "vercel-agent" }],
    });

    expect(input.source).toMatchObject({
      kind: "template",
      templateId: "vercel-agent",
    });
    expect(input.branchName).toBe("agent/auth-fix");
  });

  it("honors a branch override verbatim", async () => {
    const fixture = await createStartFixture();
    await createCachedMirror(
      fixture.cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );

    const input = await buildCreateInput({
      changeName: "fix-auth",
      sources: [{ kind: "repo", token: "front" }],
      branchOverride: "tomdale/custom",
    });

    expect(input.branchName).toBe("tomdale/custom");
  });

  it("rejects combining a template with repository sources", async () => {
    await createStartFixture();

    await expect(
      buildCreateInput({
        changeName: "auth-fix",
        sources: [
          { kind: "template", name: "vercel-agent" },
          { kind: "repo", token: "api" },
        ],
      }),
    ).rejects.toThrow(
      "Template sources cannot be combined with repository sources.",
    );
  });

  it("rejects an empty source list", async () => {
    await createStartFixture();

    await expect(
      buildCreateInput({ changeName: "auth-fix", sources: [] }),
    ).rejects.toThrow("No repositories specified.");
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

function noOpStartOptions(): RunNewCommandOptions {
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
  hasLockfile: boolean;
} {
  return { name, remote, hasLockfile: false };
}

async function* repoSetupPipelineStates(
  hasLockfile: boolean,
): AsyncGenerator<RepoPipelineState> {
  yield { phase: "worktree-ready", hasLockfile };
  yield { phase: "complete", hasLockfile };
}

/**
 * A stand-in for the single-repo setup pipeline that single-repo `wf new` routes
 * through the shared {@link presentPipelines} seam. It records the options it was
 * called with (so tests can assert repo/branch/scope/target wiring) and yields the
 * worktree-ready + complete states the drain records to finalize metadata.
 */
function fakeRepoSetupPipeline(hasLockfile = false) {
  return vi.fn((_options: Parameters<RunScopedRepoSetupPipeline>[0]) =>
    repoSetupPipelineStates(hasLockfile),
  );
}

function fakeStampWorkspace() {
  return vi.fn(async (options: Parameters<StampWorkspace>[0]) => ({
    workspaceDir: options.workspaceDir,
    setupFailures: [],
    nextSteps: [],
    outcome: "background" as const,
  }));
}

function fakePresentRun(repoResults: [string, { hasLockfile: boolean }][]) {
  return vi.fn(async (_options: Parameters<PresentRun>[0]) => ({
    results: new Map(repoResults),
    outcome: "ready" as const,
  }));
}

function fakeFailedPresentRun(repoName: string) {
  return vi.fn(async (options: Parameters<PresentRun>[0]) => {
    await options.onFailure?.(repoName, {
      phase: "failed",
      error: new Error("install failed"),
      step: "init:install",
    });
    return {
      results: new Map<string, { hasLockfile: boolean }>(),
      outcome: "failed" as const,
    };
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
