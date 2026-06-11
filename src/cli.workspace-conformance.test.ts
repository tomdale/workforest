import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeCli } from "./cli.ts";
import { saveWorkspaceConfig } from "./config.ts";
import { initializeWorkspaceInitialization } from "./workspace/initialization.ts";
import {
  readWorkspaceMetadata,
  writeWorkspaceMetadata,
} from "./workspace/metadata.ts";

const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const ORIGINAL_CACHE_DIR = process.env["WORKFOREST_CACHE_DIR"];
const ORIGINAL_CWD = process.cwd();
const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;

const tempDirs: string[] = [];

beforeEach(() => {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: false,
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(ORIGINAL_CWD);
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: ORIGINAL_STDIN_IS_TTY,
  });

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

describe("workspace CLI conformance", () => {
  it.each([
    [["new", "--help"], "Usage: wf new"],
    [["status", "--help"], "Usage: wf status"],
    [["cd", "--help"], "Usage: wf cd"],
    [["find", "--help"], "Usage: wf find"],
    [["add", "--help"], "Usage: wf add"],
    [["fork", "--help"], "Usage: wf fork"],
    [["list", "--help"], "Usage: wf list"],
    [["ls", "--help"], "Usage: wf ls"],
    [["delete", "--help"], "Usage: wf delete"],
    [["clean", "--help"], "Usage: wf clean"],
    [["workspace", "delete", "--help"], "Usage: wf workspace delete"],
    [["workspace", "rm", "--help"], "Usage: wf workspace delete"],
  ])("renders scoped help for %j on stdout", async (argv, usage) => {
    const result = await executeCli(argv);

    expect(result).toMatchObject({
      exitCode: 0,
      render: {
        kind: "text",
        stream: "stdout",
      },
    });
    if (result.render.kind === "text") {
      expect(result.render.value).toContain(usage);
    }
  });

  it.each([
    [["new"], "Invalid operands for wf new"],
    [["new", "vercel/front"], "Invalid operands for wf new"],
    [["new", "--", "fix-auth"], "Invalid operands for wf new"],
    [["new", "vercel/front", "--"], "Invalid operands for wf new"],
    [["add"], "Invalid operands for wf add"],
    [["fork", "one", "two"], "Invalid operands for wf fork"],
    [["list", "extra"], "Invalid operands for wf list"],
    [["cd"], "Invalid operands for wf cd"],
    [["cd", "one", "two"], "Invalid operands for wf cd"],
    [["find", "extra"], "Invalid operands for wf find"],
    [["status", "extra"], "Unknown wf status subcommand"],
    [
      ["workspace", "delete", "one", "two"],
      "Invalid operands for wf workspace delete",
    ],
    [["clean", "one", "two"], "Invalid operands for wf clean"],
    [["delete", "one", "two"], "Invalid operands for wf delete"],
    [["list", "--dry-run"], 'Unknown flag "--dry-run" for wf list'],
    [["add", "--force", "repo"], 'Unknown flag "--force" for wf add'],
    [["status", "cancel", "--json"], 'Unknown flag "--json"'],
    [["clean", "--json"], 'Unknown flag "--json" for wf clean'],
  ])("returns a stack-free usage failure for %j", async (argv, message) => {
    const result = await executeCli(argv);

    expect(result).toMatchObject({
      exitCode: 2,
      render: {
        kind: "text",
        stream: "stderr",
      },
    });
    if (result.render.kind === "text") {
      expect(result.render.value).toContain(message);
      expect(result.render.value).not.toContain("at parse");
      expect(result.render.value).not.toContain("node_modules");
    }
  });

  it("returns status JSON through the typed stdout result", async () => {
    const workspaceDir = await createWorkspace("status-workspace");
    await initializeWorkspaceInitialization({
      workspaceDir,
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
        },
      ],
    });

    const result = await executeCli([
      "status",
      "--workspace",
      workspaceDir,
      "--json",
    ]);

    expect(result).toMatchObject({
      exitCode: 0,
      render: {
        kind: "json",
        stream: "stdout",
        value: {
          workspace: {
            status: "creating",
          },
          repos: [
            {
              repo: "front",
              status: "pending",
            },
          ],
        },
      },
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("does not create a workspace during new --dry-run", async () => {
    const { workspaceRoot } = await configureWorkspaceRoot();

    const result = await executeCli([
      "new",
      "--dry-run",
      "vercel/front",
      "--",
      "fix-auth",
    ]);

    expect(result.exitCode).toBe(0);
    await expectPathMissing(path.join(workspaceRoot, "fix-auth"));
  });

  it("does not mutate workspace metadata during add --dry-run", async () => {
    await configureWorkspaceRoot();
    const workspaceDir = await createWorkspace("add-workspace");

    const result = await executeCli([
      "add",
      "--dry-run",
      "--workspace",
      workspaceDir,
      "vercel/api",
    ]);

    expect(result.exitCode).toBe(0);
    await expect(readWorkspaceMetadata(workspaceDir)).resolves.toMatchObject({
      repos: [{ name: "front" }],
    });
    await expectPathMissing(path.join(workspaceDir, "api"));
  });

  it("does not create a sibling workspace during fork --dry-run", async () => {
    await configureWorkspaceRoot();
    const workspaceDir = await createWorkspace("source-workspace", {
      featureName: "source-workspace",
    });
    process.chdir(workspaceDir);

    const result = await executeCli(["fork", "--dry-run", "forked"]);

    expect(result.exitCode).toBe(0);
    await expectPathMissing(path.join(path.dirname(workspaceDir), "forked"));
  });

  it.each([
    { label: "clean", command: ["clean"] },
    { label: "workspace delete", command: ["workspace", "delete"] },
    { label: "delete", command: ["delete"] },
  ])("does not remove a workspace during $label --dry-run", async ({
    command,
  }) => {
    await configureWorkspaceRoot();
    const workspaceDir = await createWorkspace(
      `delete-workspace-${command.join("-")}`,
    );

    const result = await executeCli([...command, "--dry-run", workspaceDir]);

    expect(result.exitCode).toBe(0);
    await expect(stat(workspaceDir)).resolves.toBeTruthy();
    await expect(readWorkspaceMetadata(workspaceDir)).resolves.not.toBeNull();
  });
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

async function configureWorkspaceRoot(): Promise<{
  workspaceRoot: string;
  cacheDir: string;
}> {
  const configDir = await createTempDir("workforest-config");
  const workspaceRoot = await createTempDir("workforest-root");
  const cacheDir = await createTempDir("workforest-cache");
  process.env["WORKFOREST_CONFIG_DIR"] = configDir;
  process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
  await saveWorkspaceConfig(path.join(configDir, "config.json"), {
    defaultDir: workspaceRoot,
  });
  return { workspaceRoot, cacheDir };
}

async function createWorkspace(
  name: string,
  options: { featureName?: string } = {},
): Promise<string> {
  const workspaceDir = await createTempDir(name);
  await mkdir(path.join(workspaceDir, "front"), { recursive: true });
  await writeWorkspaceMetadata(workspaceDir, {
    featureName: options.featureName ?? name,
    branchName: `tomdale/${options.featureName ?? name}`,
    repos: [
      {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        defaultBranch: "main",
        hasLockfile: false,
      },
    ],
  });
  return workspaceDir;
}

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}
