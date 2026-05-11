import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveWorkspaceConfig } from "./config.ts";
import { WORKFOREST_CD_PATH_ENV } from "./shell.ts";

const { createSingleWorktreeMock } = vi.hoisted(() => ({
  createSingleWorktreeMock: vi.fn(),
}));

const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const ORIGINAL_CD_PATH_FILE = process.env[WORKFOREST_CD_PATH_ENV];
const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_EXIT_CODE = process.exitCode;
const ORIGINAL_CWD = process.cwd();

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function importCliWithWorktreeMock(): Promise<typeof import("./cli.ts")> {
  vi.doMock("./worktree.ts", () => ({
    createSingleWorktree: createSingleWorktreeMock,
  }));

  return import("./cli.ts");
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unmock("./worktree.ts");
  createSingleWorktreeMock.mockReset();

  if (ORIGINAL_CONFIG_DIR === undefined) {
    delete process.env["WORKFOREST_CONFIG_DIR"];
  } else {
    process.env["WORKFOREST_CONFIG_DIR"] = ORIGINAL_CONFIG_DIR;
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

    expect(logs.join("\n")).toContain("Repository: front");
    expect(logs.join("\n")).toContain("Branch: tomdale/fix-auth");
    expect(logs.join("\n")).toContain(
      `Target: ${path.join(resolvedCwd, "fix-auth")}`,
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

    expect(logs.join("\n")).toContain(`Target: ${targetDir}`);
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

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Usage: wf worktree");

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

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Usage: wf worktree");
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
});
