import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveWorkspaceConfig } from "./config.ts";
import { WORKFOREST_CD_PATH_ENV } from "./shell.ts";

const {
  createSingleWorktreeMock,
  createManagedWorktreeMock,
  listManagedWorktreesMock,
  removeManagedWorktreeMock,
  promoteManagedWorktreeMock,
  resolveManagedWorktreeContextMock,
  resolveStandaloneWorktreeMock,
  removeStandaloneWorktreeMock,
  createTemporaryWorktreesMock,
  listTemporaryWorktreesMock,
  removeTemporaryWorktreesMock,
  promptConfirmMock,
  promptSelectMock,
  isInteractiveMock,
} = vi.hoisted(() => ({
  createSingleWorktreeMock: vi.fn(),
  createManagedWorktreeMock: vi.fn(),
  listManagedWorktreesMock: vi.fn(),
  removeManagedWorktreeMock: vi.fn(),
  promoteManagedWorktreeMock: vi.fn(),
  resolveManagedWorktreeContextMock: vi.fn(),
  resolveStandaloneWorktreeMock: vi.fn(),
  removeStandaloneWorktreeMock: vi.fn(),
  createTemporaryWorktreesMock: vi.fn(),
  listTemporaryWorktreesMock: vi.fn(),
  removeTemporaryWorktreesMock: vi.fn(),
  promptConfirmMock: vi.fn(),
  promptSelectMock: vi.fn(),
  isInteractiveMock: vi.fn(),
}));

const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const ORIGINAL_CACHE_DIR = process.env["WORKFOREST_CACHE_DIR"];
const ORIGINAL_CD_PATH_FILE = process.env[WORKFOREST_CD_PATH_ENV];
const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_EXIT_CODE = process.exitCode;
const ORIGINAL_CWD = process.cwd();

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
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
}

function managedContext(defaultDir: string) {
  const checkoutPath = path.join(defaultDir, "front", "fix-auth");
  return {
    repo: {
      name: "front",
      remote: "git@github.com:vercel/front.git",
      defaultBranch: "main",
    },
    mirrorDir: path.join(defaultDir, "cache", "front.git"),
    familyDir: path.join(defaultDir, "front"),
    checkoutPath,
    name: "fix-auth",
    branch: "tomdale/fix-auth",
    detached: false,
    locked: false,
  };
}

async function importCliWithWorktreeMock(): Promise<typeof import("./cli.ts")> {
  vi.doMock("./worktree.ts", () => ({
    createSingleWorktree: createSingleWorktreeMock,
    resolveStandaloneWorktree: resolveStandaloneWorktreeMock,
    removeStandaloneWorktree: removeStandaloneWorktreeMock,
  }));
  vi.doMock("./managed-worktrees.ts", () => ({
    createManagedWorktree: createManagedWorktreeMock,
    listManagedWorktrees: listManagedWorktreesMock,
    removeManagedWorktree: removeManagedWorktreeMock,
    promoteManagedWorktree: promoteManagedWorktreeMock,
    resolveManagedWorktreeContext: resolveManagedWorktreeContextMock,
  }));
  vi.doMock("./workspace/temporary-worktrees.ts", () => ({
    createTemporaryWorktrees: createTemporaryWorktreesMock,
    listTemporaryWorktrees: listTemporaryWorktreesMock,
    removeTemporaryWorktrees: removeTemporaryWorktreesMock,
  }));
  vi.doMock("./ui/prompts/index.ts", async () => {
    const actual = await vi.importActual<
      typeof import("./ui/prompts/index.ts")
    >("./ui/prompts/index.ts");
    return {
      ...actual,
      isInteractive: isInteractiveMock,
      promptConfirm: promptConfirmMock,
      promptSelect: promptSelectMock,
    };
  });

  return import("./cli.ts");
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unmock("./worktree.ts");
  vi.unmock("./managed-worktrees.ts");
  vi.unmock("./workspace/temporary-worktrees.ts");
  vi.unmock("./ui/prompts/index.ts");
  createSingleWorktreeMock.mockReset();
  createManagedWorktreeMock.mockReset();
  listManagedWorktreesMock.mockReset();
  removeManagedWorktreeMock.mockReset();
  promoteManagedWorktreeMock.mockReset();
  resolveManagedWorktreeContextMock.mockReset();
  resolveStandaloneWorktreeMock.mockReset();
  removeStandaloneWorktreeMock.mockReset();
  createTemporaryWorktreesMock.mockReset();
  listTemporaryWorktreesMock.mockReset();
  removeTemporaryWorktreesMock.mockReset();
  promptConfirmMock.mockReset();
  promptSelectMock.mockReset();
  isInteractiveMock.mockReset();

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

  if (ORIGINAL_CD_PATH_FILE === undefined) {
    delete process.env[WORKFOREST_CD_PATH_ENV];
  } else {
    process.env[WORKFOREST_CD_PATH_ENV] = ORIGINAL_CD_PATH_FILE;
  }

  process.argv = [...ORIGINAL_ARGV];
  process.exitCode = ORIGINAL_EXIT_CODE;
  process.chdir(ORIGINAL_CWD);

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("wf worktree", () => {
  it.each([
    ["root", ["worktree", "--help"]],
    ["root alias", ["wt", "--help"]],
    ["new", ["worktree", "new", "--help"]],
    ["promote", ["worktree", "promote", "--help"]],
    ["list", ["worktree", "list", "--help"]],
    ["delete", ["worktree", "delete", "--help"]],
    ["delete alias", ["wt", "rm", "--help"]],
  ])("renders %s help on stdout with exit 0", async (_name, argv) => {
    const { executeCli } = await importCliWithWorktreeMock();

    const result = await executeCli(argv);

    expect(result).toMatchObject({
      exitCode: 0,
      render: {
        kind: "text",
        stream: "stdout",
      },
    });
  });

  it.each([
    ["missing create operands", ["worktree"]],
    ["missing new operands", ["worktree", "new"]],
    ["surplus new operands", ["worktree", "new", "repo", "name", "extra"]],
    ["inapplicable promote flag", ["worktree", "promote", "--repo", "front"]],
    ["surplus list operands", ["worktree", "list", "extra"]],
    ["inapplicable delete flag", ["worktree", "delete", "--dir", "target"]],
    ["unknown create flag", ["worktree", "fix-auth", "--bogus"]],
  ])("returns exit 2 without a stack for %s", async (_name, argv) => {
    const { executeCli } = await importCliWithWorktreeMock();

    const result = await executeCli(argv);

    expect(result).toMatchObject({
      exitCode: 2,
      render: {
        kind: "text",
        stream: "stderr",
      },
    });
    if (result.render.kind === "text") {
      expect(result.render.value).not.toMatch(/\n\s+at /);
    }
  });

  it("creates a managed worktree under defaultDir", async () => {
    const configDir = await createTempDir("workforest-config-");
    const defaultDir = await createTempDir("workforest-default-");
    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      defaultDir,
      branchPrefix: "tomdale",
    });
    createManagedWorktreeMock.mockResolvedValue({
      repo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        defaultBranch: "main",
      },
      name: "fix-auth",
      branchName: "tomdale/fix-auth",
      targetDir: path.join(defaultDir, "front", "fix-auth"),
      dryRun: false,
      setupStatus: "ready",
    });

    const { cli } = await importCliWithWorktreeMock();
    process.argv = [
      "node",
      "wf",
      "worktree",
      "new",
      "vercel/front",
      "fix-auth",
    ];
    process.exitCode = undefined;

    await cli();

    expect(createManagedWorktreeMock).toHaveBeenCalledWith({
      repo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        defaultBranch: "main",
      },
      name: "fix-auth",
      defaultDir: path.resolve(defaultDir),
      branchPrefix: "tomdale/",
      dryRun: false,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("creates a managed sibling from managed context shorthand", async () => {
    const configDir = await createTempDir("workforest-config-");
    const defaultDir = await createTempDir("workforest-default-");
    const checkoutPath = path.join(defaultDir, "front", "fix-auth");
    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await mkdir(checkoutPath, { recursive: true });
    process.chdir(checkoutPath);
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      defaultDir,
      branchPrefix: "tomdale",
    });
    const context = {
      repo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        defaultBranch: "main",
      },
      mirrorDir: path.join(defaultDir, "cache", "front.git"),
      familyDir: path.join(defaultDir, "front"),
      checkoutPath,
      name: "fix-auth",
      branch: "tomdale/fix-auth",
      detached: false,
      locked: false,
    };
    resolveManagedWorktreeContextMock.mockResolvedValue(context);
    createManagedWorktreeMock.mockResolvedValue({
      repo: context.repo,
      name: "experiment",
      branchName: "tomdale/experiment",
      targetDir: path.join(defaultDir, "front", "experiment"),
      dryRun: false,
      setupStatus: "ready",
    });

    const { cli } = await importCliWithWorktreeMock();
    process.argv = ["node", "wf", "wt", "experiment"];
    process.exitCode = undefined;

    await cli();

    expect(createTemporaryWorktreesMock).not.toHaveBeenCalled();
    expect(createManagedWorktreeMock).toHaveBeenCalledWith({
      repo: context.repo,
      name: "experiment",
      defaultDir: path.resolve(defaultDir),
      branchPrefix: "tomdale/",
      dryRun: false,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("creates a managed sibling with the contextual new form", async () => {
    const configDir = await createTempDir("workforest-config-");
    const defaultDir = await createTempDir("workforest-default-");
    const checkoutPath = path.join(defaultDir, "front", "fix-auth");
    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await mkdir(checkoutPath, { recursive: true });
    process.chdir(checkoutPath);
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      defaultDir,
    });
    const context = {
      repo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        defaultBranch: "main",
      },
      mirrorDir: path.join(defaultDir, "cache", "front.git"),
      familyDir: path.join(defaultDir, "front"),
      checkoutPath,
      name: "fix-auth",
      branch: "fix-auth",
      detached: false,
      locked: false,
    };
    resolveManagedWorktreeContextMock.mockResolvedValue(context);
    createManagedWorktreeMock.mockResolvedValue({
      repo: context.repo,
      name: "experiment",
      branchName: "experiment",
      targetDir: path.join(defaultDir, "front", "experiment"),
      dryRun: false,
      setupStatus: "ready",
    });

    const { cli } = await importCliWithWorktreeMock();
    process.argv = ["node", "wf", "wt", "new", "experiment"];
    process.exitCode = undefined;

    await cli();

    expect(createManagedWorktreeMock).toHaveBeenCalledWith({
      repo: context.repo,
      name: "experiment",
      defaultDir: path.resolve(defaultDir),
      branchPrefix: "",
      dryRun: false,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("retains a managed worktree and exits 1 when setup fails", async () => {
    const configDir = await createTempDir("workforest-config-");
    const defaultDir = await createTempDir("workforest-default-");
    const targetDir = path.join(defaultDir, "front", "fix-auth");
    const errors: string[] = [];
    const logs: string[] = [];
    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      defaultDir,
    });
    createManagedWorktreeMock.mockResolvedValue({
      repo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        defaultBranch: "main",
      },
      name: "fix-auth",
      branchName: "fix-auth",
      targetDir,
      dryRun: false,
      setupStatus: "failed",
      setupError: new Error("pnpm install failed"),
    });
    vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    const { cli } = await importCliWithWorktreeMock();
    process.argv = [
      "node",
      "wf",
      "worktree",
      "new",
      "vercel/front",
      "fix-auth",
    ];
    process.exitCode = undefined;

    await cli();

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain(
      "Worktree created, but setup failed: pnpm install failed",
    );
    expect(logs.join("\n")).toContain(`Worktree retained at ${targetDir}`);
  });

  it("lists managed worktrees from managed context", async () => {
    const configDir = await createTempDir("workforest-config-");
    const defaultDir = await createTempDir("workforest-default-");
    const context = managedContext(defaultDir);
    const logs: string[] = [];
    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await mkdir(context.checkoutPath, { recursive: true });
    process.chdir(context.checkoutPath);
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      defaultDir,
    });
    resolveManagedWorktreeContextMock.mockResolvedValue(context);
    listManagedWorktreesMock.mockResolvedValue([
      {
        name: "experiment",
        path: path.join(context.familyDir, "experiment"),
        branch: "tomdale/experiment",
        detached: false,
        locked: false,
      },
    ]);
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    const { cli } = await importCliWithWorktreeMock();
    process.argv = ["node", "wf", "worktree", "list"];
    process.exitCode = undefined;

    await cli();

    expect(listManagedWorktreesMock).toHaveBeenCalledWith(context);
    expect(logs.join("\n")).toContain("experiment");
    expect(process.exitCode).toBeUndefined();
  });

  it("deletes a managed worktree through the runtime rm alias", async () => {
    const configDir = await createTempDir("workforest-config-");
    const defaultDir = await createTempDir("workforest-default-");
    const context = managedContext(defaultDir);
    const removedPath = path.join(context.familyDir, "experiment");
    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await mkdir(context.checkoutPath, { recursive: true });
    process.chdir(context.checkoutPath);
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      defaultDir,
    });
    resolveManagedWorktreeContextMock.mockResolvedValue(context);
    removeManagedWorktreeMock.mockResolvedValue({
      name: "experiment",
      path: removedPath,
      branch: "tomdale/experiment",
      detached: false,
      locked: false,
    });

    const { cli } = await importCliWithWorktreeMock();
    process.argv = ["node", "wf", "wt", "rm", "experiment", "--force"];
    process.exitCode = undefined;

    await cli();

    expect(removeManagedWorktreeMock).toHaveBeenCalledWith({
      context,
      name: "experiment",
      dryRun: false,
      force: true,
    });
    expect(promptConfirmMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("promotes a managed worktree through the typed leaf", async () => {
    const configDir = await createTempDir("workforest-config-");
    const defaultDir = await createTempDir("workforest-default-");
    const context = managedContext(defaultDir);
    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await mkdir(context.checkoutPath, { recursive: true });
    process.chdir(context.checkoutPath);
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      defaultDir,
      dirPrefix: "task-",
    });
    resolveManagedWorktreeContextMock.mockResolvedValue(context);
    promoteManagedWorktreeMock.mockResolvedValue({
      workspaceDir: path.join(defaultDir, "task-fix-auth"),
      repoDir: path.join(defaultDir, "task-fix-auth", "front"),
      repos: [context.repo],
      addedRepos: [],
      failures: [],
      dryRun: true,
    });

    const { cli } = await importCliWithWorktreeMock();
    process.argv = ["node", "wf", "worktree", "promote", "--dry-run"];
    process.exitCode = undefined;

    await cli();

    expect(promoteManagedWorktreeMock).toHaveBeenCalledWith({
      context,
      defaultDir: path.resolve(defaultDir),
      dirPrefix: "task-",
      template: null,
      repos: [],
      dryRun: true,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("infers the owner for a cached standalone repository", async () => {
    const configDir = await createTempDir("workforest-config-");
    const cacheDir = await createTempDir("workforest-cache-");
    const cwd = await createTempDir("workforest-cwd-");
    const logs: string[] = [];

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
    process.chdir(cwd);
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {});
    await createCachedMirror(
      cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    const { cli } = await importCliWithWorktreeMock();
    process.argv = ["node", "wf", "worktree", "front", "fix-auth", "-n"];
    process.exitCode = undefined;

    await cli();

    expect(logs.join("\n")).toContain("git@github.com:vercel/front.git");
    expect(createSingleWorktreeMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("prints a dry-run preview without creating a worktree", async () => {
    const configDir = await createTempDir("workforest-config-");
    const cwd = await createTempDir("workforest-cwd-");
    const logs: string[] = [];

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    process.chdir(cwd);
    const resolvedCwd = process.cwd();
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      branchPrefix: "tomdale",
    });

    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    const { cli } = await importCliWithWorktreeMock();
    process.argv = ["node", "wf", "worktree", "vercel/front", "fix-auth", "-n"];
    process.exitCode = undefined;

    await cli();

    expect(logs.join("\n")).toMatch(/Repository:\s+front/);
    expect(logs.join("\n")).toMatch(/Branch:\s+tomdale\/fix-auth/);
    expect(logs.join("\n")).toMatch(
      new RegExp(
        `Target:\\s+${escapeRegExp(path.join(resolvedCwd, "fix-auth"))}`,
      ),
    );
    expect(createSingleWorktreeMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("uses --dir as the exact target path", async () => {
    const configDir = await createTempDir("workforest-config-");
    const targetDir = path.join(
      await createTempDir("workforest-target-"),
      "front",
    );
    const logs: string[] = [];

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await mkdir(configDir, { recursive: true });

    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    const { cli } = await importCliWithWorktreeMock();
    process.argv = [
      "node",
      "wf",
      "worktree",
      "vercel/front",
      "fix-auth",
      "--dir",
      targetDir,
      "--dry-run",
    ];
    process.exitCode = undefined;

    await cli();

    expect(logs.join("\n")).toMatch(
      new RegExp(`Target:\\s+${escapeRegExp(targetDir)}`),
    );
    expect(createSingleWorktreeMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("rejects missing, extra, and invalid arguments", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });

    const { cli } = await importCliWithWorktreeMock();
    process.argv = ["node", "wf", "worktree", "vercel/front"];
    process.exitCode = undefined;

    await cli();

    expect(process.exitCode).toBe(2);
    expect(errors.join("\n")).toContain("Invalid operands for wf worktree");

    errors.length = 0;
    process.argv = ["node", "wf", "worktree", "vercel/front", "not a slug"];
    process.exitCode = undefined;

    await cli();

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Invalid slug");

    errors.length = 0;
    process.argv = [
      "node",
      "wf",
      "worktree",
      "vercel/front",
      "fix-auth",
      "extra",
    ];
    process.exitCode = undefined;

    await cli();

    expect(process.exitCode).toBe(2);
    expect(errors.join("\n")).toContain("Invalid operands for wf worktree");
    expect(errors.join("\n")).not.toContain("at run");
  });

  it("rejects context-inapplicable flags with exit 2 and no stack", async () => {
    const configDir = await createTempDir("workforest-config-");
    const workspaceDir = await createTempDir("workforest-workspace-");
    const repoDir = path.join(workspaceDir, "front");
    const defaultDir = await createTempDir("workforest-default-");
    const context = managedContext(defaultDir);
    const errors: string[] = [];
    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await mkdir(repoDir, { recursive: true });
    await mkdir(context.checkoutPath, { recursive: true });
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      defaultDir,
    });
    const { writeWorkspaceMetadata } = await import("./workspace/metadata.ts");
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "my-feature",
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
          hasLockfile: true,
        },
      ],
    });
    vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });
    resolveManagedWorktreeContextMock.mockResolvedValue(context);

    const { cli } = await importCliWithWorktreeMock();

    process.chdir(repoDir);
    process.argv = ["node", "wf", "worktree", "fix-tests", "--dir", "./target"];
    process.exitCode = undefined;
    await cli();
    expect(process.exitCode).toBe(2);
    expect(errors.at(-1)).toContain(
      "--dir is only supported for standalone worktrees.",
    );

    process.chdir(context.checkoutPath);
    process.argv = ["node", "wf", "wt", "experiment", "--force"];
    process.exitCode = undefined;
    await cli();
    expect(process.exitCode).toBe(2);
    expect(errors.at(-1)).toContain(
      "--force is only supported for workspace temporary worktrees.",
    );

    process.argv = ["node", "wf", "worktree", "list", "--repo", "front"];
    process.exitCode = undefined;
    await cli();
    expect(process.exitCode).toBe(2);
    expect(errors.at(-1)).toContain(
      "--repo is only supported for workspace temporary worktrees.",
    );

    process.argv = [
      "node",
      "wf",
      "worktree",
      "delete",
      "one",
      "two",
      "--force",
    ];
    process.exitCode = undefined;
    await cli();
    expect(process.exitCode).toBe(2);
    expect(errors.at(-1)).toContain("Invalid operands for wf worktree delete");
    expect(removeManagedWorktreeMock).not.toHaveBeenCalled();

    process.argv = [
      "node",
      "wf",
      "worktree",
      "vercel/front",
      "fix-auth",
      "--repo",
      "front",
    ];
    process.exitCode = undefined;
    await cli();
    expect(process.exitCode).toBe(2);
    expect(errors.at(-1)).toContain(
      "--repo is only supported for workspace temporary worktrees.",
    );
    expect(errors.join("\n")).not.toMatch(/\n\s+at /);
  });

  it("routes wt to worktree creation and writes the shell cd target", async () => {
    const configDir = await createTempDir("workforest-config-");
    const cdDir = await createTempDir("workforest-cd-");
    const targetDir = path.join(
      await createTempDir("workforest-target-"),
      "front",
    );
    const cdPathFile = path.join(cdDir, "target");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    process.env[WORKFOREST_CD_PATH_ENV] = cdPathFile;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      branchPrefix: "tomdale/",
    });
    createSingleWorktreeMock.mockResolvedValueOnce({
      repo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        defaultBranch: "main",
      },
      branchName: "tomdale/fix-auth",
      targetDir,
    });

    vi.spyOn(console, "log").mockImplementation(() => {});

    const { cli } = await importCliWithWorktreeMock();
    process.argv = [
      "node",
      "wf",
      "wt",
      "vercel/front",
      "fix-auth",
      "--dir",
      targetDir,
    ];
    process.exitCode = undefined;

    await cli();

    expect(createSingleWorktreeMock).toHaveBeenCalledWith({
      repo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        defaultBranch: "main",
      },
      branchName: "tomdale/fix-auth",
      targetDir,
    });
    await mkdir(targetDir, { recursive: true });
    const written = await readFile(cdPathFile, "utf8");
    expect(written).toBe(`${path.resolve(targetDir)}\n`);
    expect(process.exitCode).toBeUndefined();
  });

  it("creates workspace-scoped temporary worktrees from inside a repo", async () => {
    const configDir = await createTempDir("workforest-config-");
    const workspaceDir = await createTempDir("workforest-workspace-");
    const repoDir = path.join(workspaceDir, "front");
    const logs: string[] = [];

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await mkdir(repoDir, { recursive: true });
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      branchPrefix: "tomdale/",
    });
    const { writeWorkspaceMetadata } = await import("./workspace/metadata.ts");
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "my-feature",
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
          hasLockfile: true,
        },
      ],
    });
    process.chdir(repoDir);
    const resolvedWorkspaceDir = path.dirname(process.cwd());

    createTemporaryWorktreesMock.mockResolvedValueOnce({
      created: [
        {
          slug: "fix-tests",
          parentRepo: "front",
          path: path.join(workspaceDir, "fix-tests"),
          branch: "tomdale/fix-tests",
          setupStatus: "ready",
        },
      ],
      failures: [],
    });
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    const { cli } = await importCliWithWorktreeMock();
    process.argv = ["node", "wf", "worktree", "fix-tests"];
    process.exitCode = undefined;

    await cli();

    expect(createTemporaryWorktreesMock).toHaveBeenCalledWith({
      workspaceDir: resolvedWorkspaceDir,
      parentRepo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        default_branch: "main",
        has_lockfile: true,
      },
      slugs: ["fix-tests"],
      branchPrefix: "tomdale/",
      dryRun: false,
      force: false,
    });
    expect(createSingleWorktreeMock).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("fix-tests");
    expect(process.exitCode).toBeUndefined();
  });

  it("requires --repo when creating from the workspace root", async () => {
    const workspaceDir = await createTempDir("workforest-workspace-");
    const errors: string[] = [];
    const { writeWorkspaceMetadata } = await import("./workspace/metadata.ts");
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "my-feature",
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
          hasLockfile: true,
        },
      ],
    });
    process.chdir(workspaceDir);
    vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });

    const { cli } = await importCliWithWorktreeMock();
    process.argv = ["node", "wf", "worktree", "fix-tests"];
    process.exitCode = undefined;

    await cli();

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("pass --repo");
    expect(createTemporaryWorktreesMock).not.toHaveBeenCalled();
  });

  it("creates review temporary worktrees from the review workspace root", async () => {
    const configDir = await createTempDir("workforest-config-");
    const workspaceDir = await createTempDir("workforest-review-");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      branchPrefix: "tomdale/",
    });
    const { writeWorkspaceMetadata } = await import("./workspace/metadata.ts");
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "omniagent",
      type: "review",
      review: { owner: "vercel", repo: "omniagent" },
      repos: [
        {
          name: "omniagent",
          remote: "git@github.com:vercel/omniagent.git",
          defaultBranch: "main",
          hasLockfile: false,
        },
      ],
    });
    process.chdir(workspaceDir);
    const resolvedWorkspaceDir = process.cwd();

    createTemporaryWorktreesMock.mockResolvedValueOnce({
      created: [
        {
          slug: "fix-tests",
          parentRepo: "omniagent",
          path: path.join(workspaceDir, "fix-tests"),
          branch: "tomdale/fix-tests",
          setupStatus: "ready",
        },
      ],
      failures: [],
    });

    const { cli } = await importCliWithWorktreeMock();
    process.argv = ["node", "wf", "worktree", "fix-tests"];
    process.exitCode = undefined;

    await cli();

    expect(createTemporaryWorktreesMock).toHaveBeenCalledWith({
      workspaceDir: resolvedWorkspaceDir,
      parentRepo: {
        name: "omniagent",
        remote: "git@github.com:vercel/omniagent.git",
        default_branch: "main",
        has_lockfile: false,
      },
      slugs: ["fix-tests"],
      branchPrefix: "tomdale/",
      dryRun: false,
      force: false,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("branches review temporary worktrees from the current PR checkout", async () => {
    const configDir = await createTempDir("workforest-config-");
    const workspaceDir = await createTempDir("workforest-review-");
    const prDir = path.join(workspaceDir, "pr-123");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await mkdir(prDir, { recursive: true });
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      branchPrefix: "tomdale/",
    });
    const { upsertReviewWorktree, writeWorkspaceMetadata } = await import(
      "./workspace/metadata.ts"
    );
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "omniagent",
      type: "review",
      review: { owner: "vercel", repo: "omniagent" },
      repos: [
        {
          name: "omniagent",
          remote: "git@github.com:vercel/omniagent.git",
          defaultBranch: "main",
          hasLockfile: false,
        },
      ],
    });
    await upsertReviewWorktree(workspaceDir, {
      pr_number: 123,
      path: "pr-123",
      branch: "pull/123",
      created_at: "2026-05-15T00:00:00.000Z",
    });
    process.chdir(prDir);
    const resolvedPrDir = process.cwd();
    const resolvedWorkspaceDir = path.dirname(resolvedPrDir);

    createTemporaryWorktreesMock.mockResolvedValueOnce({
      created: [
        {
          slug: "fix-tests",
          parentRepo: "omniagent",
          path: path.join(workspaceDir, "fix-tests"),
          branch: "tomdale/fix-tests",
          setupStatus: "ready",
        },
      ],
      failures: [],
    });

    const { cli } = await importCliWithWorktreeMock();
    process.argv = ["node", "wf", "worktree", "fix-tests"];
    process.exitCode = undefined;

    await cli();

    expect(createTemporaryWorktreesMock).toHaveBeenCalledWith({
      workspaceDir: resolvedWorkspaceDir,
      parentRepo: {
        name: "omniagent",
        remote: "git@github.com:vercel/omniagent.git",
        default_branch: "main",
        has_lockfile: false,
      },
      sourceRepoDir: resolvedPrDir,
      slugs: ["fix-tests"],
      branchPrefix: "tomdale/",
      dryRun: false,
      force: false,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("lists temporary worktrees scoped to the current repo", async () => {
    const workspaceDir = await createTempDir("workforest-workspace-");
    const repoDir = path.join(workspaceDir, "front");
    const logs: string[] = [];
    const { writeWorkspaceMetadata } = await import("./workspace/metadata.ts");
    await mkdir(repoDir, { recursive: true });
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "my-feature",
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
          hasLockfile: true,
        },
      ],
    });
    process.chdir(repoDir);
    const resolvedWorkspaceDir = path.dirname(process.cwd());
    listTemporaryWorktreesMock.mockResolvedValueOnce([
      {
        slug: "fix-tests",
        parent_repo: "front",
        path: "fix-tests",
        absolutePath: path.join(workspaceDir, "fix-tests"),
        branch: "tomdale/fix-tests",
        base_branch: "tomdale/my-feature",
        base_sha: "abc123",
        created_at: "2026-05-15T00:00:00.000Z",
        setup_status: "ready",
        state: "ready",
        merged: false,
      },
    ]);
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    const { cli } = await importCliWithWorktreeMock();
    process.argv = ["node", "wf", "worktree", "list"];
    process.exitCode = undefined;

    await cli();

    expect(listTemporaryWorktreesMock).toHaveBeenCalledWith(
      resolvedWorkspaceDir,
      "front",
    );
    expect(logs.join("\n")).toContain("fix-tests");
  });

  it("deletes temporary worktrees with an explicit slug", async () => {
    const workspaceDir = await createTempDir("workforest-workspace-");
    const repoDir = path.join(workspaceDir, "front");
    const { writeWorkspaceMetadata } = await import("./workspace/metadata.ts");
    await mkdir(repoDir, { recursive: true });
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "my-feature",
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
          hasLockfile: true,
        },
      ],
    });
    process.chdir(repoDir);
    const resolvedWorkspaceDir = path.dirname(process.cwd());
    isInteractiveMock.mockReturnValue(true);
    promptConfirmMock.mockResolvedValue(true);
    removeTemporaryWorktreesMock.mockResolvedValueOnce({
      removed: [
        {
          slug: "fix-tests",
          parent_repo: "front",
          path: "fix-tests",
          branch: "tomdale/fix-tests",
          base_branch: "tomdale/my-feature",
          base_sha: "abc123",
          created_at: "2026-05-15T00:00:00.000Z",
          setup_status: "ready",
        },
      ],
    });

    const { cli } = await importCliWithWorktreeMock();
    process.argv = ["node", "wf", "worktree", "delete", "fix-tests"];
    process.exitCode = undefined;

    await cli();

    expect(promptConfirmMock).toHaveBeenCalledWith(
      `Delete temporary worktree "fix-tests" at ${resolvedWorkspaceDir}?`,
      false,
    );
    expect(removeTemporaryWorktreesMock).toHaveBeenCalledWith({
      workspaceDir: resolvedWorkspaceDir,
      slugs: ["fix-tests"],
      parentRepoName: "front",
      dryRun: false,
      force: false,
    });
  });

  it("infers the current temporary worktree for bare delete", async () => {
    const workspaceDir = await createTempDir("workforest-workspace-");
    const worktreeDir = path.join(workspaceDir, "fix-tests");
    const { appendTemporaryWorktrees, writeWorkspaceMetadata } = await import(
      "./workspace/metadata.ts"
    );
    await mkdir(worktreeDir, { recursive: true });
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "my-feature",
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
          hasLockfile: true,
        },
      ],
    });
    await appendTemporaryWorktrees(workspaceDir, [
      {
        slug: "fix-tests",
        parent_repo: "front",
        path: "fix-tests",
        branch: "tomdale/fix-tests",
        base_branch: "tomdale/my-feature",
        base_sha: "abc123",
        created_at: "2026-05-15T00:00:00.000Z",
        setup_status: "ready",
      },
    ]);
    process.chdir(worktreeDir);
    const resolvedWorkspaceDir = path.dirname(process.cwd());
    removeTemporaryWorktreesMock.mockResolvedValueOnce({
      removed: [
        {
          slug: "fix-tests",
          parent_repo: "front",
          path: "fix-tests",
          branch: "tomdale/fix-tests",
          base_branch: "tomdale/my-feature",
          base_sha: "abc123",
          created_at: "2026-05-15T00:00:00.000Z",
          setup_status: "ready",
        },
      ],
    });

    const { cli } = await importCliWithWorktreeMock();
    process.argv = ["node", "wf", "delete", "--force"];
    process.exitCode = undefined;

    await cli();

    expect(removeTemporaryWorktreesMock).toHaveBeenCalledWith({
      workspaceDir: resolvedWorkspaceDir,
      slugs: ["fix-tests"],
      parentRepoName: "front",
      dryRun: false,
      force: true,
    });
    expect(promptConfirmMock).not.toHaveBeenCalled();
  });

  it("deletes standalone worktrees outside a workspace", async () => {
    const targetDir = await createTempDir("workforest-standalone-");
    process.chdir(targetDir);
    const resolvedTargetDir = process.cwd();
    isInteractiveMock.mockReturnValue(true);
    promptConfirmMock.mockResolvedValue(true);
    removeStandaloneWorktreeMock.mockResolvedValueOnce({
      path: resolvedTargetDir,
      dryRun: false,
    });

    const { cli } = await importCliWithWorktreeMock();
    process.argv = [
      "node",
      "wf",
      "worktree",
      "delete",
      path.basename(resolvedTargetDir),
    ];
    process.exitCode = undefined;

    await cli();

    expect(promptConfirmMock).toHaveBeenCalledWith(
      `Delete standalone worktree at ${resolvedTargetDir}?`,
      false,
    );
    expect(removeStandaloneWorktreeMock).toHaveBeenCalledWith({
      targetDir: resolvedTargetDir,
      dryRun: false,
      force: false,
    });
  });

  it("prompts before deleting a standalone worktree inside a workspace", async () => {
    const workspaceDir = await createTempDir("workforest-workspace-");
    const repoDir = path.join(workspaceDir, "front");
    const { writeWorkspaceMetadata } = await import("./workspace/metadata.ts");
    await mkdir(repoDir, { recursive: true });
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "my-feature",
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
          hasLockfile: true,
        },
      ],
    });
    process.chdir(repoDir);
    const resolvedRepoDir = process.cwd();
    const resolvedWorkspaceDir = path.dirname(resolvedRepoDir);
    isInteractiveMock.mockReturnValue(true);
    resolveStandaloneWorktreeMock.mockResolvedValue({
      path: resolvedRepoDir,
      branch: "refs/heads/tomdale/front-work",
    });
    promptSelectMock.mockResolvedValue("worktree");
    removeStandaloneWorktreeMock.mockResolvedValueOnce({
      path: resolvedRepoDir,
      dryRun: false,
    });

    const { cli } = await importCliWithWorktreeMock();
    process.argv = ["node", "wf", "delete"];
    process.exitCode = undefined;

    await cli();

    expect(promptSelectMock).toHaveBeenCalledWith("Delete what?", {
      options: [
        {
          label: "Worktree",
          description: resolvedRepoDir,
          value: "worktree",
        },
        {
          label: "Workspace",
          description: resolvedWorkspaceDir,
          value: "workspace",
        },
        { label: "Cancel", value: "cancel" },
      ],
    });
    expect(promptConfirmMock).not.toHaveBeenCalled();
    expect(removeStandaloneWorktreeMock).toHaveBeenCalledWith({
      targetDir: resolvedRepoDir,
      dryRun: false,
      force: false,
    });
  });

  it("does not delete an explicit temporary worktree when confirmation is declined", async () => {
    const workspaceDir = await createTempDir("workforest-workspace-");
    const repoDir = path.join(workspaceDir, "front");
    const { writeWorkspaceMetadata } = await import("./workspace/metadata.ts");
    await mkdir(repoDir, { recursive: true });
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "my-feature",
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
          hasLockfile: true,
        },
      ],
    });
    process.chdir(repoDir);
    isInteractiveMock.mockReturnValue(true);
    promptConfirmMock.mockResolvedValue(false);

    const { cli } = await importCliWithWorktreeMock();
    process.argv = ["node", "wf", "worktree", "delete", "fix-tests"];
    process.exitCode = undefined;

    await cli();

    expect(removeTemporaryWorktreesMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("requires --force for explicit worktree deletion in non-interactive mode", async () => {
    const workspaceDir = await createTempDir("workforest-workspace-");
    const repoDir = path.join(workspaceDir, "front");
    const { writeWorkspaceMetadata } = await import("./workspace/metadata.ts");
    await mkdir(repoDir, { recursive: true });
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "my-feature",
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
          hasLockfile: true,
        },
      ],
    });
    process.chdir(repoDir);
    isInteractiveMock.mockReturnValue(false);

    const { cli } = await importCliWithWorktreeMock();
    process.argv = ["node", "wf", "worktree", "delete", "fix-tests"];
    process.exitCode = undefined;

    await cli();

    expect(removeTemporaryWorktreesMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
