import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderCommandResult } from "./cli/output.ts";
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
  restoreEnvironment("WORKFOREST_CONFIG_DIR", ORIGINAL_CONFIG_DIR);
  restoreEnvironment("WORKFOREST_CACHE_DIR", ORIGINAL_CACHE_DIR);
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("workspace CLI conformance", () => {
  it.each([
    [["new", "--help"], "Usage: wf new"],
    [["clean", "--help"], "Usage: wf clean"],
    [["workspace", "create", "--help"], "Usage: wf workspace create"],
    [["workspace", "delete", "--help"], "Usage: wf workspace delete"],
    [["workspace", "open", "--help"], "Usage: wf workspace open"],
    [["workspace", "list", "--help"], "Usage: wf workspace list"],
    [["workspace", "status", "--help"], "Usage: wf workspace status"],
    [["workspace", "add", "--help"], "Usage: wf workspace add"],
  ])("renders scoped help for %j", async (argv, usage) => {
    const result = await executeCli(argv);
    expect(result).toMatchObject({
      exitCode: 0,
      render: { kind: "text", stream: "stdout" },
    });
    if (result.render.kind === "text") {
      expect(result.render.value).toContain(usage);
    }
  });

  it.each([
    [["workspace", "delete"], "Invalid operands for wf workspace delete"],
    [["clean"], "Invalid operands for wf workspace delete"],
    [["workspace", "delete", "one", "two"], "Invalid operands"],
    [["workspace", "open", "one", "two"], "Invalid operands"],
    [
      ["workspace", "open", "one", "--search"],
      "Invalid operands for wf workspace open",
    ],
    [["workspace", "add"], "Invalid operands for wf workspace add"],
    [["workspace", "list", "extra"], "Invalid operands"],
    [["workspace", "list", "--dry-run"], 'Unknown flag "--dry-run"'],
    [["workspace", "status", "extra"], "Invalid operands"],
    [["workspace", "create", "--like", "other", "--", "next"], "Unsupported"],
    [["cd", "workspace"], "Unknown command"],
    [["find"], "Unknown command"],
    [["fork", "workspace"], "Unknown command"],
    [["add", "vercel/front"], "Unknown command"],
    [["status"], "Unknown command"],
    [["delete", "workspace"], "Unknown command"],
  ])("returns exit 2 for unsupported invocation %j", async (argv, message) => {
    const result = await executeCli(argv);
    expect(result).toMatchObject({
      exitCode: 2,
      render: { kind: "text", stream: "stderr" },
    });
    if (result.render.kind === "text") {
      expect(result.render.value).toContain(message);
      expect(result.render.value).not.toMatch(/\n\s+at /);
    }
  });

  it("returns workspace status JSON", async () => {
    const { workspaceRoot } = await configureWorkspaceRoot();
    const workspaceDir = await createWorkspace(
      workspaceRoot,
      "status-workspace",
    );
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
      "workspace",
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
          workspace: { status: "creating" },
          repos: [{ repo: "front", status: "pending" }],
        },
      },
    });
    const output = renderResult(result);
    expect(output).toEqual({
      stdout: expect.stringContaining('"ok":true'),
      stderr: "",
    });
    expect(JSON.parse(output.stdout)).toMatchObject({
      ok: true,
      data: {
        workspace: { status: "creating" },
        repos: [{ repo: "front", status: "pending" }],
      },
    });
  });

  it("returns workspace status JSON errors on stdout", async () => {
    const result = await executeCli(["workspace", "status", "--json"]);
    const output = renderResult(result);

    expect(result.exitCode).toBe(1);
    expect(output.stderr).toBe("");
    expect(JSON.parse(output.stdout)).toEqual({
      ok: false,
      error: {
        kind: "operational",
        message: "Run wf workspace status from inside a workforest workspace.",
      },
    });
  });

  it.each([
    ["new", ["new", "--dry-run", "vercel/front", "--", "fix-auth"]],
    [
      "workspace create",
      ["workspace", "create", "--dry-run", "vercel/front", "--", "fix-auth"],
    ],
  ])("does not create a workspace during %s --dry-run", async (_label, argv) => {
    const { workspaceRoot } = await configureWorkspaceRoot();
    expect((await executeCli(argv)).exitCode).toBe(0);
    await expectPathMissing(path.join(workspaceRoot, "fix-auth"));
  });

  it("creates a sibling plan with workspace create --like current", async () => {
    const { workspaceRoot } = await configureWorkspaceRoot();
    const source = await createWorkspace(workspaceRoot, "source");
    process.chdir(source);

    const result = await executeCli([
      "workspace",
      "create",
      "--like",
      "current",
      "--dry-run",
      "--",
      "next",
    ]);

    expect(result.exitCode).toBe(0);
    await expectPathMissing(path.join(workspaceRoot, "next"));
  });

  it("does not mutate workspace metadata during workspace add --dry-run", async () => {
    const { workspaceRoot } = await configureWorkspaceRoot();
    const workspaceDir = await createWorkspace(workspaceRoot, "add-workspace");

    const result = await executeCli([
      "workspace",
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
  });

  it.each([
    ["clean", (workspace: string) => ["clean", "--dry-run", workspace]],
    [
      "workspace delete",
      (workspace: string) => ["workspace", "delete", "--dry-run", workspace],
    ],
  ])("deletes only an explicit workspace target for %s", async (_label, argv) => {
    const { workspaceRoot } = await configureWorkspaceRoot();
    const workspaceDir = await createWorkspace(
      workspaceRoot,
      "delete-workspace",
    );
    process.chdir(workspaceDir);

    expect((await executeCli(argv(workspaceDir))).exitCode).toBe(0);
    await expect(stat(workspaceDir)).resolves.toBeTruthy();
  });
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function renderResult(result: Awaited<ReturnType<typeof executeCli>>): {
  stdout: string;
  stderr: string;
} {
  let stdout = "";
  let stderr = "";
  renderCommandResult(result, {
    stdout(value) {
      stdout += value;
    },
    stderr(value) {
      stderr += value;
    },
  });
  return { stdout, stderr };
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

async function createWorkspace(root: string, name: string): Promise<string> {
  const workspaceDir = path.join(root, name);
  await mkdir(path.join(workspaceDir, "front"), { recursive: true });
  await writeWorkspaceMetadata(workspaceDir, {
    featureName: name,
    branchName: `tomdale/${name}`,
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

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
