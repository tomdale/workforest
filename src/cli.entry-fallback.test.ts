import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const runEntryMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => undefined),
);
const buildCreateInputMock = vi.hoisted(() =>
  vi.fn(async (args) => ({
    changeName: args.changeName,
    source: {
      kind: "repository",
      repo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        defaultBranch: "main",
      },
    },
    branchName: args.branchOverride ?? `tomdale/${args.changeName}`,
    directories: {
      base: "/tmp/workforest",
      repos: "/tmp/workforest/Repos",
      workspaces: "/tmp/workforest/Workspaces",
      reviews: "/tmp/workforest/Reviews",
    },
  })),
);
const createMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./entry/surface.ts", () => ({
  runEntry: runEntryMock,
}));

vi.mock("./workspace/create.ts", async () => {
  const actual = await vi.importActual<typeof import("./workspace/create.ts")>(
    "./workspace/create.ts",
  );
  return {
    ...actual,
    buildCreateInput: buildCreateInputMock,
    create: createMock,
  };
});

import { executeCli } from "./cli.ts";
import { saveWorkspaceConfig } from "./config.ts";

const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const ORIGINAL_XDG_CONFIG_HOME = process.env["XDG_CONFIG_HOME"];
const ORIGINAL_CWD = process.cwd();
const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;
const ORIGINAL_STDOUT_IS_TTY = process.stdout.isTTY;
const ORIGINAL_STDOUT_COLUMNS = process.stdout.columns;
const ORIGINAL_STDOUT_ROWS = process.stdout.rows;
const ORIGINAL_NO_TUI = process.env["WORKFOREST_NO_TUI"];
const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  runEntryMock.mockReset();
  buildCreateInputMock.mockClear();
  createMock.mockClear();
  process.chdir(ORIGINAL_CWD);
  restoreEnv("WORKFOREST_CONFIG_DIR", ORIGINAL_CONFIG_DIR);
  restoreEnv("XDG_CONFIG_HOME", ORIGINAL_XDG_CONFIG_HOME);
  restoreEnv("WORKFOREST_NO_TUI", ORIGINAL_NO_TUI);
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: ORIGINAL_STDIN_IS_TTY,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: ORIGINAL_STDOUT_IS_TTY,
  });
  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: ORIGINAL_STDOUT_COLUMNS,
  });
  Object.defineProperty(process.stdout, "rows", {
    configurable: true,
    value: ORIGINAL_STDOUT_ROWS,
  });
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("wf new TUI fallback", () => {
  it("opens create mode with the provided name outside a resolvable context", async () => {
    await configureOutsideTuiContext();

    const result = await executeCli(["new", "follow-up"]);

    expect(result.exitCode).toBe(0);
    expect(runEntryMock).toHaveBeenCalledOnce();
    const calls = runEntryMock.mock.calls as Array<
      [string, Record<string, unknown>]
    >;
    expect(calls[0]?.[0]).toBe("create");
    expect(calls[0]?.[1]).toMatchObject({
      initialName: "follow-up",
    });
  });

  it("passes --cloud as the initial target for the fallback picker", async () => {
    await configureOutsideTuiContext();

    const result = await executeCli(["new", "--cloud", "follow-up"]);

    expect(result.exitCode).toBe(0);
    const calls = runEntryMock.mock.calls as Array<
      [string, Record<string, unknown>]
    >;
    expect(calls[0]?.[1]).toMatchObject({
      initialName: "follow-up",
      initialTarget: "cloud",
    });
  });

  it("carries a validated --branch override through fallback commit", async () => {
    await configureOutsideTuiContext();
    runEntryMock.mockImplementationOnce(async (...args: unknown[]) => {
      const deps = args[1] as {
        commit: (intent: {
          changeName: string;
          sources: Array<{ kind: "repo"; token: string }>;
          target: "local";
        }) => Promise<void>;
      };
      await deps.commit({
        changeName: "follow-up",
        sources: [{ kind: "repo", token: "front" }],
        target: "local",
      });
    });

    const result = await executeCli([
      "new",
      "--branch",
      "tomdale/custom",
      "follow-up",
    ]);

    expect(result.exitCode).toBe(0);
    expect(buildCreateInputMock).toHaveBeenCalledWith({
      changeName: "follow-up",
      sources: [{ kind: "repo", token: "front" }],
      branchOverride: "tomdale/custom",
    });
    expect(createMock).toHaveBeenCalledOnce();
  });

  it("does not open the picker for explicit source failures", async () => {
    await configureOutsideTuiContext();

    const result = await executeCli(["new", "follow-up", "missing"]);

    expect(result.exitCode).toBe(1);
    expect(runEntryMock).not.toHaveBeenCalled();
  });
});

async function configureOutsideTuiContext(): Promise<void> {
  const configDir = await createTempDir("workforest-entry-config-");
  const xdgConfigHome = await createTempDir("workforest-entry-xdg-");
  const baseDir = await createTempDir("workforest-entry-base-");
  const outsideDir = await createTempDir("workforest-entry-outside-");
  process.env["WORKFOREST_CONFIG_DIR"] = configDir;
  process.env["XDG_CONFIG_HOME"] = xdgConfigHome;
  await saveWorkspaceConfig(path.join(configDir, "config.json"), {
    directory: { base: baseDir },
    branchPrefix: "tomdale",
  });
  await mkdir(baseDir, { recursive: true });
  process.chdir(outsideDir);
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: 120,
  });
  Object.defineProperty(process.stdout, "rows", {
    configurable: true,
    value: 40,
  });
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
