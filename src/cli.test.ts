import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cli } from "./cli.ts";
import { saveWorkspaceConfig } from "./config.ts";
import { WORKFOREST_CD_PATH_ENV } from "./shell.ts";
import { createTemplate } from "./templates/index.ts";
import { writeWorkspaceMetadata } from "./workspace/metadata.ts";

const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const ORIGINAL_XDG_CONFIG_HOME = process.env["XDG_CONFIG_HOME"];
const ORIGINAL_CD_PATH_FILE = process.env[WORKFOREST_CD_PATH_ENV];
const ORIGINAL_PATH = process.env["PATH"];
const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_EXIT_CODE = process.exitCode;
const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();

  if (ORIGINAL_CONFIG_DIR === undefined) {
    delete process.env["WORKFOREST_CONFIG_DIR"];
  } else {
    process.env["WORKFOREST_CONFIG_DIR"] = ORIGINAL_CONFIG_DIR;
  }

  if (ORIGINAL_XDG_CONFIG_HOME === undefined) {
    delete process.env["XDG_CONFIG_HOME"];
  } else {
    process.env["XDG_CONFIG_HOME"] = ORIGINAL_XDG_CONFIG_HOME;
  }

  if (ORIGINAL_CD_PATH_FILE === undefined) {
    delete process.env[WORKFOREST_CD_PATH_ENV];
  } else {
    process.env[WORKFOREST_CD_PATH_ENV] = ORIGINAL_CD_PATH_FILE;
  }
  if (ORIGINAL_PATH === undefined) {
    delete process.env["PATH"];
  } else {
    process.env["PATH"] = ORIGINAL_PATH;
  }

  process.argv = [...ORIGINAL_ARGV];
  process.exitCode = ORIGINAL_EXIT_CODE;
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: ORIGINAL_STDIN_IS_TTY,
  });

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("cli", () => {
  it("prints agent skills guidance first in top-level help", async () => {
    const logs: string[] = [];

    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    process.argv = ["node", "wf", "--help"];
    process.exitCode = undefined;

    await cli();

    const output = logs.join("\n");
    expect(output).toContain("Start here (for AI agents):");
    expect(output).toContain("wf skills get core --full");
    expect(output.indexOf("Start here (for AI agents):")).toBeLessThan(
      output.indexOf("Commands:"),
    );
    expect(output).not.toContain("Skills ship with the CLI");
    expect(output).not.toContain("skills get parallel-worktrees");
    expect(output).toContain("wf find");
    expect(output).toContain('eval "$(wf init zsh)"');
    expect(process.exitCode).toBeUndefined();
  });

  it("parses a slug before -- and repositories after -- for wf new", async () => {
    const configDir = await createTempDir("workforest-config-");
    const workspaceRoot = await createTempDir("workforest-root-");
    const logs: string[] = [];

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      defaultDir: workspaceRoot,
      branchPrefix: "tomdale/",
    });

    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    process.argv = [
      "node",
      "wf",
      "new",
      "--dry-run",
      "fix-auth",
      "--",
      "vercel/front",
      "vercel/api",
    ];
    process.exitCode = undefined;

    await cli();

    const output = logs.join("\n");
    expect(output).toContain(
      `Directory: ${path.join(workspaceRoot, "fix-auth")}`,
    );
    expect(output).toContain("Feature: fix-auth");
    expect(output).toContain("Branch: tomdale/fix-auth");
    expect(output).toContain("front (git@github.com:vercel/front.git)");
    expect(output).toContain("api (git@github.com:vercel/api.git)");
    expect(process.exitCode).toBeUndefined();
  });

  it("parses prose before -- and templates after -- for wf new", async () => {
    const configDir = await createTempDir("workforest-config-");
    const xdgConfigHome = await createTempDir("workforest-xdg-");
    const binDir = await createTempDir("workforest-bin-");
    const logs: string[] = [];

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;
    process.env["PATH"] =
      `${binDir}${path.delimiter}${process.env["PATH"] ?? ""}`;
    const claudePath = path.join(binDir, "claude");
    await writeFile(claudePath, "#!/bin/sh\nprintf 'fix-auth\\n'\n");
    await chmod(claudePath, 0o755);
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {});
    await createTemplate("site", {
      repos: ["vercel/front"],
      description: "Site template",
    });

    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    process.argv = [
      "node",
      "wf",
      "new",
      "--dry-run",
      "fixing",
      "auth",
      "--",
      "site",
    ];
    process.exitCode = undefined;

    await cli();

    const output = logs.join("\n");
    expect(output).toContain("Description: fixing auth");
    expect(output).toContain("Template: site");
    expect(output).toContain("front (git@github.com:vercel/front.git)");
    expect(process.exitCode).toBeUndefined();
  });

  it("rejects wf new without both sides of the -- delimiter", async () => {
    const errors: string[] = [];
    const logs: string[] = [];

    vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    process.argv = ["node", "wf", "new", "--", "site"];
    process.exitCode = undefined;

    await cli();

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain(
      'Missing name or description before "--"',
    );
    expect(logs.join("\n")).toContain(
      "Usage: wf new <name-or-description> -- <template|repo...>",
    );

    errors.length = 0;
    logs.length = 0;
    process.argv = ["node", "wf", "new", "fix-auth", "--"];
    process.exitCode = undefined;

    await cli();

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain(
      'Missing template or repositories after "--"',
    );
    expect(logs.join("\n")).toContain(
      "Usage: wf new <name-or-description> -- <template|repo...>",
    );
  });

  it("rejects the old wf new -d syntax", async () => {
    const errors: string[] = [];
    const logs: string[] = [];

    vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    process.argv = ["node", "wf", "new", "site", "-d", "fix auth"];
    process.exitCode = undefined;

    await cli();

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("unknown or unexpected option: -d");
    expect(logs.join("\n")).toContain(
      "Usage: wf new <name-or-description> -- <template|repo...>",
    );
  });

  it("exposes development UI simulation help", async () => {
    const logs: string[] = [];

    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    process.argv = ["node", "wf", "dev", "simulate", "new", "--help"];
    process.exitCode = undefined;

    await cli();

    const output = logs.join("\n");
    expect(output).toContain("Usage: wf dev simulate new [options]");
    expect(output).toContain("--fail-repo <name>");
    expect(output).toContain("--speed <speed>");
    expect(process.exitCode).toBeUndefined();
  });

  it("writes the configured workspace path for wf cd", async () => {
    const configDir = await createTempDir("workforest-config-");
    const workspaceRoot = await createTempDir("workforest-root-");
    const cdDir = await createTempDir("workforest-cd-");
    const workspaceDir = path.join(workspaceRoot, "wf-fix-auth");
    const cdPathFile = path.join(cdDir, "target");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    process.env[WORKFOREST_CD_PATH_ENV] = cdPathFile;

    await mkdir(workspaceDir, { recursive: true });
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "fix-auth",
      branchName: "tomdale/fix-auth",
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
          hasLockfile: true,
        },
      ],
    });

    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      defaultDir: workspaceRoot,
      dirPrefix: "wf-",
    });

    process.argv = ["node", "wf", "cd", "fix-auth"];
    process.exitCode = undefined;

    await cli();

    const written = await readFile(cdPathFile, "utf8");
    expect(written).toBe(`${path.resolve(workspaceDir)}\n`);
    expect(process.exitCode).toBeUndefined();
  });

  it("prints top-level help for wf find --help", async () => {
    const logs: string[] = [];

    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    process.argv = ["node", "wf", "find", "--help"];
    process.exitCode = undefined;

    await cli();

    const output = logs.join("\n");
    expect(output).toContain("Start here (for AI agents):");
    expect(output).toContain("Fuzzy-find");
    expect(process.exitCode).toBeUndefined();
  });

  it("requires an interactive terminal for wf find", async () => {
    const errors: string[] = [];
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });

    vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });

    process.argv = ["node", "wf", "find"];
    process.exitCode = undefined;

    await cli();

    expect(errors.join("\n")).toContain(
      "wf find requires an interactive terminal",
    );
    expect(process.exitCode).toBe(1);
  });

  it("reports missing defaultDir for wf find", async () => {
    const configDir = await createTempDir("workforest-config-");
    const writes: string[] = [];

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });

    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    process.argv = ["node", "wf", "find"];
    process.exitCode = undefined;

    await cli();

    expect(writes.join("")).toContain("No defaultDir configured");
    expect(process.exitCode).toBe(1);
  });

  it("writes the template directory for wf template show", async () => {
    const xdgConfigHome = await createTempDir("workforest-xdg-");
    const cdDir = await createTempDir("workforest-cd-");
    const cdPathFile = path.join(cdDir, "target");

    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;
    process.env[WORKFOREST_CD_PATH_ENV] = cdPathFile;

    await createTemplate("demo", {
      repos: ["vercel/front"],
      description: "Demo template",
    });

    process.argv = ["node", "wf", "template", "show", "demo"];
    process.exitCode = undefined;

    await cli();

    const written = await readFile(cdPathFile, "utf8");
    expect(written).toBe(
      `${path.resolve(xdgConfigHome, "workforest", "templates", "demo")}\n`,
    );
    expect(process.exitCode).toBeUndefined();
  });
});
