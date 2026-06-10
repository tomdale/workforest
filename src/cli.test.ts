import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

type PromptOption = {
  value: string;
  label: string;
  description?: string;
};

type PromptOptions = {
  options: PromptOption[];
};

const promptSelectMock = vi.hoisted(() =>
  vi.fn(async (_message: string, options: PromptOptions) => {
    return options.options[0]?.value;
  }),
);
const promptConfirmMock = vi.hoisted(() => vi.fn());
const promptTextMock = vi.hoisted(() => vi.fn());
const runTemplateManagerMock = vi.hoisted(() =>
  vi.fn(async () => ({ type: "quit" as const })),
);
const shouldUseTemplateManagerMock = vi.hoisted(() => vi.fn(() => true));
const runNewWizardMock = vi.hoisted(() => vi.fn());
const shouldUseGridMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("./ui/prompts/index.ts", async () => {
  const actual = await vi.importActual<typeof import("./ui/prompts/index.ts")>(
    "./ui/prompts/index.ts",
  );

  return {
    ...actual,
    promptConfirm: promptConfirmMock,
    promptSelect: promptSelectMock,
    promptText: promptTextMock,
  };
});

vi.mock("./ui/template-manager.ts", () => ({
  runTemplateManager: runTemplateManagerMock,
  shouldUseTemplateManager: shouldUseTemplateManagerMock,
}));

vi.mock("./ui/new-wizard.ts", () => ({
  runNewWizard: runNewWizardMock,
}));

vi.mock("./ui/grid-consumer.ts", async () => {
  const actual = await vi.importActual<typeof import("./ui/grid-consumer.ts")>(
    "./ui/grid-consumer.ts",
  );

  return {
    ...actual,
    shouldUseGrid: shouldUseGridMock,
  };
});

import { cli } from "./cli.ts";
import { saveWorkspaceConfig } from "./config.ts";
import { WORKFOREST_CD_PATH_ENV } from "./shell.ts";
import { createTemplate } from "./templates/index.ts";
import { CancelError } from "./ui/prompts/index.ts";
import { writeWorkspaceMetadata } from "./workspace/metadata.ts";

const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const ORIGINAL_CACHE_DIR = process.env["WORKFOREST_CACHE_DIR"];
const ORIGINAL_XDG_CONFIG_HOME = process.env["XDG_CONFIG_HOME"];
const ORIGINAL_CD_PATH_FILE = process.env[WORKFOREST_CD_PATH_ENV];
const ORIGINAL_PATH = process.env["PATH"];
const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_EXIT_CODE = process.exitCode;
const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;
const ORIGINAL_CWD = process.cwd();

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

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

afterEach(async () => {
  vi.restoreAllMocks();
  promptConfirmMock.mockReset();
  promptSelectMock.mockClear();
  promptTextMock.mockReset();
  runTemplateManagerMock.mockReset();
  runTemplateManagerMock.mockResolvedValue({ type: "quit" });
  shouldUseTemplateManagerMock.mockReset();
  shouldUseTemplateManagerMock.mockReturnValue(true);
  runNewWizardMock.mockReset();
  shouldUseGridMock.mockReset();
  shouldUseGridMock.mockReturnValue(false);

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
  process.chdir(ORIGINAL_CWD);
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: ORIGINAL_STDIN_IS_TTY,
  });

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("cli", () => {
  it("exits cleanly when the fullscreen new wizard is cancelled", async () => {
    const configDir = await createTempDir("workforest-config-");
    const output: string[] = [];

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {});
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    shouldUseGridMock.mockReturnValue(true);
    runNewWizardMock.mockRejectedValue(new CancelError());
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    process.argv = ["node", "wf", "new"];
    process.exitCode = undefined;

    await expect(cli()).resolves.toBeUndefined();

    expect(runNewWizardMock).toHaveBeenCalledOnce();
    expect(output.join("")).toContain("Cancelled");
    expect(process.exitCode).toBeUndefined();
  });

  it("previews and confirms configuration before saving", async () => {
    const configDir = await createTempDir("workforest-config-");
    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    promptTextMock
      .mockResolvedValueOnce("~/Code/workspaces")
      .mockResolvedValueOnce("~/Code/reviews")
      .mockResolvedValueOnce("wf-")
      .mockResolvedValueOnce("tomdale/");
    promptConfirmMock.mockResolvedValue(true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    process.argv = ["node", "wf", "config", "init"];
    process.exitCode = undefined;

    await cli();

    expect(promptConfirmMock).toHaveBeenCalledWith("Save configuration?", true);
    await expect(
      readFile(path.join(configDir, "config.json"), "utf8").then(JSON.parse),
    ).resolves.toEqual({
      defaultDir: "~/Code/workspaces",
      reviewsDir: "~/Code/reviews",
      dirPrefix: "wf-",
      branchPrefix: "tomdale/",
    });
  });

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
    expect(output).toContain("wf review");
    expect(output).toContain('eval "$(wf init zsh)"');
    expect(process.exitCode).toBeUndefined();
  });

  it("parses repositories before -- and a slug after -- for wf new", async () => {
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
      "vercel/front",
      "vercel/api",
      "--",
      "fix-auth",
    ];
    process.exitCode = undefined;

    await cli();

    const output = logs.join("\n");
    expect(output).toContain(
      `Directory: ${path.join(workspaceRoot, "fix-auth")}`,
    );
    expect(output).toMatch(/Feature:\s+fix-auth/);
    expect(output).toMatch(/Branch:\s+tomdale\/fix-auth/);
    expect(output).toContain("front");
    expect(output).toContain("git@github.com:vercel/front.git");
    expect(output).toContain("api");
    expect(output).toContain("git@github.com:vercel/api.git");
    expect(process.exitCode).toBeUndefined();
  });

  it("resolves an unqualified registered repository for wf new", async () => {
    const configDir = await createTempDir("workforest-config-");
    const cacheDir = await createTempDir("workforest-cache-");
    const workspaceRoot = await createTempDir("workforest-root-");
    const logs: string[] = [];

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      defaultDir: workspaceRoot,
      branchPrefix: "tomdale/",
    });
    await createCachedMirror(
      cacheDir,
      "myapp.git",
      "git@github.com:mycompany/myapp.git",
    );

    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    process.argv = [
      "node",
      "wf",
      "new",
      "--dry-run",
      "myapp",
      "--",
      "fix-auth",
    ];
    process.exitCode = undefined;

    await cli();

    const output = logs.join("\n");
    expect(output).toContain("myapp");
    expect(output).toContain("git@github.com:mycompany/myapp.git");
    expect(process.exitCode).toBeUndefined();
  });

  it("prefers a template over a registered repository with the same name", async () => {
    const configDir = await createTempDir("workforest-config-");
    const cacheDir = await createTempDir("workforest-cache-");
    const xdgConfigHome = await createTempDir("workforest-xdg-");
    const workspaceRoot = await createTempDir("workforest-root-");
    const logs: string[] = [];

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      defaultDir: workspaceRoot,
    });
    await createCachedMirror(
      cacheDir,
      "myapp.git",
      "git@github.com:mycompany/myapp.git",
    );
    await createTemplate("myapp", {
      repos: ["vercel/front"],
    });

    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    process.argv = [
      "node",
      "wf",
      "new",
      "--dry-run",
      "myapp",
      "--",
      "fix-auth",
    ];
    process.exitCode = undefined;

    await cli();

    const output = logs.join("\n");
    expect(output).toMatch(/Template:\s+myapp/);
    expect(output).toContain("git@github.com:vercel/front.git");
    expect(output).not.toContain("git@github.com:mycompany/myapp.git");
    expect(process.exitCode).toBeUndefined();
  });

  it("warns and fails when registered repository names collide", async () => {
    const configDir = await createTempDir("workforest-config-");
    const cacheDir = await createTempDir("workforest-cache-");
    const warnings: string[] = [];

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {});
    await createCachedMirror(
      cacheDir,
      "myapp.git",
      "git@github.com:first/myapp.git",
    );
    await createCachedMirror(
      cacheDir,
      "second-myapp.git",
      "git@github.com:second/myapp.git",
    );

    vi.spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args.join(" "));
    });

    process.argv = ["node", "wf", "new", "myapp", "--", "fix-auth"];
    process.exitCode = undefined;

    await cli();

    expect(warnings.join("\n")).toContain(
      'Repository shorthand "myapp" has a naming collision',
    );
    expect(warnings.join("\n")).toContain("first/myapp, second/myapp");
    expect(process.exitCode).toBe(1);
  });

  it("parses templates before -- and prose after -- for wf new", async () => {
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
      "site",
      "--",
      "fixing",
      "auth",
    ];
    process.exitCode = undefined;

    await cli();

    const output = logs.join("\n");
    expect(output).toMatch(/Description:\s+fixing auth/);
    expect(output).toMatch(/Template:\s+site/);
    expect(output).toContain("front");
    expect(output).toContain("git@github.com:vercel/front.git");
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

    process.argv = ["node", "wf", "new", "--", "fix-auth"];
    process.exitCode = undefined;

    await cli();

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain(
      'Missing template or repositories before "--"',
    );
    expect(logs.join("\n")).toContain(
      "Usage: wf new <template|repo...> -- <name-or-description>",
    );

    errors.length = 0;
    logs.length = 0;
    process.argv = ["node", "wf", "new", "site", "--"];
    process.exitCode = undefined;

    await cli();

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain(
      'Missing name or description after "--"',
    );
    expect(logs.join("\n")).toContain(
      "Usage: wf new <template|repo...> -- <name-or-description>",
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
      "Usage: wf new <template|repo...> -- <name-or-description>",
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

  it("exposes development confetti simulation help", async () => {
    const logs: string[] = [];

    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    process.argv = ["node", "wf", "dev", "simulate", "confetti", "--help"];
    process.exitCode = undefined;

    await cli();

    const output = logs.join("\n");
    expect(output).toContain("Usage: wf dev simulate confetti [options]");
    expect(output).toContain("--workspace <path>");
    expect(output).toContain("--repos <names>");
    expect(process.exitCode).toBeUndefined();
  });

  it("lists confetti in development simulation help", async () => {
    const logs: string[] = [];

    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    process.argv = ["node", "wf", "dev", "simulate", "--help"];
    process.exitCode = undefined;

    await cli();

    const output = logs.join("\n");
    expect(output).toContain("Usage: wf dev simulate <flow> [options]");
    expect(output).toContain("confetti");
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

  it.each([
    ["new", "Usage: wf new"],
    ["worktree", "Usage: wf worktree"],
    ["wt", "Usage: wf wt"],
    ["review", "Usage: wf review"],
    ["delete", "Usage: wf delete"],
    ["workspace", "Usage: wf workspace"],
    ["cd", "Usage: wf cd"],
    ["find", "Usage: wf find"],
    ["add", "Usage: wf add"],
    ["fork", "Usage: wf fork"],
    ["clean", "Usage: wf clean"],
    ["list", "Usage: wf list"],
    ["init", "Usage: wf init"],
    ["templates", "Usage: wf templates"],
    ["template", "Usage: wf template"],
    ["repositories", "Usage: wf repositories"],
    ["repos", "Usage: wf repos"],
    ["repository", "Usage: wf repository"],
    ["repo", "Usage: wf repo"],
    ["config", "Usage: wf config"],
    ["dev", "Usage: wf dev"],
    ["skills", "Usage: wf skills"],
    ["version", "Usage: wf version"],
  ])("prints scoped help for wf %s --help", async (command, usage) => {
    const logs: string[] = [];

    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    process.argv = ["node", "wf", command, "--help"];
    process.exitCode = undefined;

    await cli();

    const output = logs.join("\n");
    expect(output).toContain(usage);
    expect(output).not.toContain("Start here (for AI agents):");
    expect(output).not.toContain("Commands:");
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    [["worktree", "list", "--help"], "Usage: wf worktree list"],
    [["worktree", "delete", "--help"], "Usage: wf worktree delete"],
    [["worktree", "rm", "--help"], "Usage: wf worktree delete"],
    [["review", "list", "--help"], "Usage: wf review list"],
    [["review", "delete", "--help"], "Usage: wf review delete"],
    [["review", "rm", "--help"], "Usage: wf review delete"],
    [["workspace", "delete", "--help"], "Usage: wf workspace delete"],
    [["templates", "list", "--help"], "Usage: wf template list"],
    [["template", "new", "--help"], "Usage: wf template new"],
    [["template", "delete", "--help"], "Usage: wf template delete"],
    [["template", "add-file", "--help"], "Usage: wf template add-file"],
    [["repository", "list", "--help"], "Usage: wf repository list"],
    [["repository", "info", "--help"], "Usage: wf repository info"],
    [["repository", "add", "--help"], "Usage: wf repository add"],
    [["repository", "update", "--help"], "Usage: wf repository update"],
    [["repository", "doctor", "--help"], "Usage: wf repository doctor"],
    [["repository", "repair", "--help"], "Usage: wf repository repair"],
    [["repository", "delete", "--help"], "Usage: wf repository delete"],
    [["repository", "clean", "--help"], "Usage: wf repository clean"],
    [["config", "edit", "--help"], "Usage: wf config edit"],
    [["skills", "get", "--help"], "Usage: wf skills get"],
    [["dev", "simulate", "--help"], "Usage: wf dev simulate"],
  ])("prints scoped help for wf %s", async (argv, usage) => {
    const logs: string[] = [];

    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    process.argv = ["node", "wf", ...argv];
    process.exitCode = undefined;

    await cli();

    const output = logs.join("\n");
    expect(output).toContain(usage);
    expect(output).not.toContain("Start here (for AI agents):");
    expect(output).not.toContain("Commands:");
    expect(process.exitCode).toBeUndefined();
  });

  it("does not delete a workspace when confirmation is declined", async () => {
    const workspaceDir = await createTempDir("workforest-workspace-");

    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "demo-work",
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
          hasLockfile: true,
        },
      ],
    });
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    promptConfirmMock.mockResolvedValue(false);

    process.argv = ["node", "wf", "workspace", "delete", workspaceDir];
    process.exitCode = undefined;

    await cli();

    await expect(stat(workspaceDir)).resolves.toBeTruthy();
    expect(promptConfirmMock).toHaveBeenCalledWith(
      `Delete workspace at ${path.resolve(workspaceDir)}?`,
      false,
    );
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

  it("opens the interactive template manager for wf templates", async () => {
    const xdgConfigHome = await createTempDir("workforest-xdg-");
    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });

    await createTemplate("demo", {
      repos: ["vercel/front"],
      description: "Demo template",
    });

    process.argv = ["node", "wf", "templates"];
    process.exitCode = undefined;

    await cli();

    expect(shouldUseTemplateManagerMock).toHaveBeenCalled();
    expect(runTemplateManagerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        templatesDir: path.join(xdgConfigHome, "workforest", "templates"),
        templates: [
          expect.objectContaining({
            id: "demo",
            config: expect.objectContaining({
              description: "Demo template",
              repos: ["vercel/front"],
            }),
          }),
        ],
      }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("falls back to the template list for wf templates outside a TTY", async () => {
    const xdgConfigHome = await createTempDir("workforest-xdg-");
    const logs: string[] = [];
    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    await createTemplate("demo", {
      repos: ["vercel/front"],
      description: "Demo template",
    });

    process.argv = ["node", "wf", "templates"];
    process.exitCode = undefined;

    await cli();

    expect(runTemplateManagerMock).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("Templates");
    expect(logs.join("\n")).toContain("demo");
    expect(process.exitCode).toBeUndefined();
  });

  it("opens the template manager for wf template without a subcommand", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });

    process.argv = ["node", "wf", "template"];
    process.exitCode = undefined;

    await cli();

    expect(runTemplateManagerMock).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("adds a workspace file to the source template files directory", async () => {
    const xdgConfigHome = await createTempDir("workforest-xdg-");
    const workspaceDir = await createTempDir("workforest-workspace-");

    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;

    await createTemplate("demo", {
      repos: ["vercel/front"],
    });
    await mkdir(path.join(workspaceDir, "front"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, "front", ".env.local"),
      "FEATURE_FLAG=1\n",
      "utf8",
    );
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "demo-work",
      templateId: "demo",
      branchName: "tomdale/demo-work",
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
    process.argv = ["node", "wf", "template", "add-file", "front/.env.local"];
    process.exitCode = undefined;

    await cli();

    const copied = await readFile(
      path.join(
        xdgConfigHome,
        "workforest",
        "templates",
        "demo",
        "files",
        "front",
        ".env.local",
      ),
      "utf8",
    );
    expect(copied).toBe("FEATURE_FLAG=1\n");
    expect(process.exitCode).toBeUndefined();
  });

  it("adds workspace files to an explicit template", async () => {
    const xdgConfigHome = await createTempDir("workforest-xdg-");
    const workspaceDir = await createTempDir("workforest-workspace-");

    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;

    await createTemplate("source", {
      repos: ["vercel/front"],
    });
    await createTemplate("target", {
      repos: ["vercel/front"],
    });
    await mkdir(path.join(workspaceDir, "front"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, "front", ".env.local"),
      "FEATURE_FLAG=1\n",
      "utf8",
    );
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "demo-work",
      templateId: "source",
      branchName: "tomdale/demo-work",
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
    process.argv = [
      "node",
      "wf",
      "template",
      "add-file",
      "--template",
      "target",
      "front/.env.local",
    ];
    process.exitCode = undefined;

    await cli();

    await expect(
      readFile(
        path.join(
          xdgConfigHome,
          "workforest",
          "templates",
          "target",
          "files",
          "front",
          ".env.local",
        ),
        "utf8",
      ),
    ).resolves.toBe("FEATURE_FLAG=1\n");
    await expect(
      readFile(
        path.join(
          xdgConfigHome,
          "workforest",
          "templates",
          "source",
          "files",
          "front",
          ".env.local",
        ),
        "utf8",
      ),
    ).rejects.toThrow();
    expect(process.exitCode).toBeUndefined();
  });

  it("adds workspace files to a positional template", async () => {
    const xdgConfigHome = await createTempDir("workforest-xdg-");
    const workspaceDir = await createTempDir("workforest-workspace-");

    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;

    await createTemplate("source", {
      repos: ["vercel/front"],
    });
    await createTemplate("target", {
      repos: ["vercel/front"],
    });
    await mkdir(path.join(workspaceDir, "front"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, "front", ".env.local"),
      "FEATURE_FLAG=1\n",
      "utf8",
    );
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "demo-work",
      templateId: "source",
      branchName: "tomdale/demo-work",
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
    process.argv = [
      "node",
      "wf",
      "template",
      "add-file",
      "target",
      "front/.env.local",
    ];
    process.exitCode = undefined;

    await cli();

    await expect(
      readFile(
        path.join(
          xdgConfigHome,
          "workforest",
          "templates",
          "target",
          "files",
          "front",
          ".env.local",
        ),
        "utf8",
      ),
    ).resolves.toBe("FEATURE_FLAG=1\n");
    await expect(
      readFile(
        path.join(
          xdgConfigHome,
          "workforest",
          "templates",
          "source",
          "files",
          "front",
          ".env.local",
        ),
        "utf8",
      ),
    ).rejects.toThrow();
    expect(process.exitCode).toBeUndefined();
  });

  it("rejects an ambiguous positional template that also exists as a workspace path", async () => {
    const xdgConfigHome = await createTempDir("workforest-xdg-");
    const workspaceDir = await createTempDir("workforest-workspace-");
    const errors: string[] = [];

    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;
    vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });

    await createTemplate("front", {
      repos: ["vercel/front"],
    });
    await mkdir(path.join(workspaceDir, "front"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, "front", ".env.local"),
      "FEATURE_FLAG=1\n",
      "utf8",
    );
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "demo-work",
      templateId: "front",
      branchName: "tomdale/demo-work",
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
    process.argv = [
      "node",
      "wf",
      "template",
      "add-file",
      "front",
      "front/.env.local",
    ];
    process.exitCode = undefined;

    await cli();

    expect(errors.join("\n")).toContain('Ambiguous add-file argument "front"');
    expect(process.exitCode).toBe(1);
  });

  it("rejects a first workspace argument that is neither a template nor an existing path", async () => {
    const xdgConfigHome = await createTempDir("workforest-xdg-");
    const workspaceDir = await createTempDir("workforest-workspace-");
    const errors: string[] = [];

    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;
    vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });

    await createTemplate("source", {
      repos: ["vercel/front"],
    });
    await mkdir(path.join(workspaceDir, "front"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, "front", ".env.local"),
      "FEATURE_FLAG=1\n",
      "utf8",
    );
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "demo-work",
      templateId: "source",
      branchName: "tomdale/demo-work",
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
    process.argv = [
      "node",
      "wf",
      "template",
      "add-file",
      "missing",
      "front/.env.local",
    ];
    process.exitCode = undefined;

    await cli();

    expect(errors.join("\n")).toContain(
      'Could not resolve add-file argument "missing"',
    );
    expect(process.exitCode).toBe(1);
  });

  it("adds files to an explicit template outside a workspace", async () => {
    const xdgConfigHome = await createTempDir("workforest-xdg-");
    const cwd = await createTempDir("workforest-outside-");

    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;

    await createTemplate("demo", {
      repos: ["vercel/front"],
    });
    await mkdir(path.join(cwd, "front"), { recursive: true });
    await writeFile(path.join(cwd, ".envrc"), "use workforest\n", "utf8");
    await writeFile(
      path.join(cwd, "front", ".env.local"),
      "FEATURE_FLAG=1\n",
      "utf8",
    );

    process.chdir(cwd);
    process.argv = [
      "node",
      "wf",
      "template",
      "add-file",
      "-t",
      "demo",
      ".envrc",
      "front/.env.local",
    ];
    process.exitCode = undefined;

    await cli();

    const templateFilesDir = path.join(
      xdgConfigHome,
      "workforest",
      "templates",
      "demo",
      "files",
    );
    await expect(
      readFile(path.join(templateFilesDir, ".envrc"), "utf8"),
    ).resolves.toBe("use workforest\n");
    await expect(
      readFile(path.join(templateFilesDir, "front", ".env.local"), "utf8"),
    ).resolves.toBe("FEATURE_FLAG=1\n");
    expect(process.exitCode).toBeUndefined();
  });

  it("adds files to a positional template outside a workspace", async () => {
    const xdgConfigHome = await createTempDir("workforest-xdg-");
    const cwd = await createTempDir("workforest-outside-");

    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;

    await createTemplate("demo", {
      repos: ["vercel/front"],
    });
    await mkdir(path.join(cwd, "front"), { recursive: true });
    await writeFile(
      path.join(cwd, "front", ".env.local"),
      "FEATURE_FLAG=1\n",
      "utf8",
    );

    process.chdir(cwd);
    process.argv = [
      "node",
      "wf",
      "template",
      "add-file",
      "demo",
      "front/.env.local",
    ];
    process.exitCode = undefined;

    await cli();

    await expect(
      readFile(
        path.join(
          xdgConfigHome,
          "workforest",
          "templates",
          "demo",
          "files",
          "front",
          ".env.local",
        ),
        "utf8",
      ),
    ).resolves.toBe("FEATURE_FLAG=1\n");
    expect(process.exitCode).toBeUndefined();
  });

  it("rejects an unknown positional template outside a workspace", async () => {
    const cwd = await createTempDir("workforest-outside-");
    const errors: string[] = [];

    vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });

    await writeFile(path.join(cwd, ".envrc"), "use workforest\n", "utf8");

    process.chdir(cwd);
    process.argv = [
      "node",
      "wf",
      "template",
      "add-file",
      "missing-template",
      ".envrc",
    ];
    process.exitCode = undefined;

    await cli();

    expect(errors.join("\n")).toContain(
      'Template "missing-template" not found',
    );
    expect(process.exitCode).toBe(1);
  });

  it("prompts before overwriting an existing template file", async () => {
    const xdgConfigHome = await createTempDir("workforest-xdg-");
    const workspaceDir = await createTempDir("workforest-workspace-");

    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;

    await createTemplate("demo", {
      repos: ["vercel/front"],
    });
    await mkdir(path.join(workspaceDir, "front"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, "front", ".env.local"),
      "FEATURE_FLAG=1\n",
      "utf8",
    );
    const templateFilePath = path.join(
      xdgConfigHome,
      "workforest",
      "templates",
      "demo",
      "files",
      "front",
      ".env.local",
    );
    await mkdir(path.dirname(templateFilePath), { recursive: true });
    await writeFile(templateFilePath, "FEATURE_FLAG=0\n", "utf8");
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "demo-work",
      templateId: "demo",
      branchName: "tomdale/demo-work",
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
          hasLockfile: true,
        },
      ],
    });
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    promptSelectMock.mockResolvedValueOnce("overwrite");

    process.chdir(workspaceDir);
    process.argv = ["node", "wf", "template", "add-file", "front/.env.local"];
    process.exitCode = undefined;

    await cli();

    expect(promptSelectMock).toHaveBeenCalledOnce();
    const options = promptSelectMock.mock.calls[0]?.[1].options ?? [];
    expect(options.map((option) => option.value)).toEqual([
      "overwrite",
      "diff",
      "skip",
    ]);
    await expect(readFile(templateFilePath, "utf8")).resolves.toBe(
      "FEATURE_FLAG=1\n",
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("adds a workspace directory recursively to the source template files directory", async () => {
    const xdgConfigHome = await createTempDir("workforest-xdg-");
    const workspaceDir = await createTempDir("workforest-workspace-");

    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;

    await createTemplate("demo", {
      repos: ["vercel/front"],
    });
    await mkdir(path.join(workspaceDir, "front", "config", "nested"), {
      recursive: true,
    });
    await mkdir(path.join(workspaceDir, "front", "config", "empty"), {
      recursive: true,
    });
    await writeFile(
      path.join(workspaceDir, "front", "config", ".env.local"),
      "FEATURE_FLAG=1\n",
      "utf8",
    );
    await writeFile(
      path.join(workspaceDir, "front", "config", "nested", "settings.json"),
      "{}\n",
      "utf8",
    );
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "demo-work",
      templateId: "demo",
      branchName: "tomdale/demo-work",
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
    process.argv = ["node", "wf", "template", "add-file", "front/config"];
    process.exitCode = undefined;

    await cli();

    const templateConfigDir = path.join(
      xdgConfigHome,
      "workforest",
      "templates",
      "demo",
      "files",
      "front",
      "config",
    );
    await expect(
      readFile(path.join(templateConfigDir, ".env.local"), "utf8"),
    ).resolves.toBe("FEATURE_FLAG=1\n");
    await expect(
      readFile(path.join(templateConfigDir, "nested", "settings.json"), "utf8"),
    ).resolves.toBe("{}\n");
    await expect(
      stat(path.join(templateConfigDir, "empty")),
    ).resolves.toSatisfy((entry) => entry.isDirectory());
    expect(process.exitCode).toBeUndefined();
  });

  it("shows a diff and can skip an existing file while adding a directory", async () => {
    const xdgConfigHome = await createTempDir("workforest-xdg-");
    const workspaceDir = await createTempDir("workforest-workspace-");
    const logs: string[] = [];

    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;

    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    await createTemplate("demo", {
      repos: ["vercel/front"],
    });
    await mkdir(path.join(workspaceDir, "front", "config"), {
      recursive: true,
    });
    await writeFile(
      path.join(workspaceDir, "front", "config", ".env.local"),
      "FEATURE_FLAG=1\n",
      "utf8",
    );
    await writeFile(
      path.join(workspaceDir, "front", "config", "settings.json"),
      "{}\n",
      "utf8",
    );
    const templateConfigDir = path.join(
      xdgConfigHome,
      "workforest",
      "templates",
      "demo",
      "files",
      "front",
      "config",
    );
    await mkdir(templateConfigDir, { recursive: true });
    await writeFile(
      path.join(templateConfigDir, ".env.local"),
      "FEATURE_FLAG=0\n",
      "utf8",
    );
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "demo-work",
      templateId: "demo",
      branchName: "tomdale/demo-work",
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
          hasLockfile: true,
        },
      ],
    });
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    promptSelectMock
      .mockResolvedValueOnce("diff")
      .mockResolvedValueOnce("skip");

    process.chdir(workspaceDir);
    process.argv = ["node", "wf", "template", "add-file", "front/config"];
    process.exitCode = undefined;

    await cli();

    expect(promptSelectMock).toHaveBeenCalledTimes(2);
    const options = promptSelectMock.mock.calls[0]?.[1].options ?? [];
    expect(options.map((option) => option.value)).toEqual([
      "overwrite",
      "diff",
      "skip",
      "cancel",
    ]);
    expect(logs.join("\n")).toContain("-FEATURE_FLAG=0");
    expect(logs.join("\n")).toContain("+FEATURE_FLAG=1");
    await expect(
      readFile(path.join(templateConfigDir, ".env.local"), "utf8"),
    ).resolves.toBe("FEATURE_FLAG=0\n");
    await expect(
      readFile(path.join(templateConfigDir, "settings.json"), "utf8"),
    ).resolves.toBe("{}\n");
    expect(process.exitCode).toBeUndefined();
  });

  it("skips automatically before prompting when the diff is empty", async () => {
    const xdgConfigHome = await createTempDir("workforest-xdg-");
    const workspaceDir = await createTempDir("workforest-workspace-");
    const logs: string[] = [];

    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;

    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    await createTemplate("demo", {
      repos: ["vercel/front"],
    });
    await mkdir(path.join(workspaceDir, "front"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, "front", ".env.local"),
      "FEATURE_FLAG=1\n",
      "utf8",
    );
    const templateFilePath = path.join(
      xdgConfigHome,
      "workforest",
      "templates",
      "demo",
      "files",
      "front",
      ".env.local",
    );
    await mkdir(path.dirname(templateFilePath), { recursive: true });
    await writeFile(templateFilePath, "FEATURE_FLAG=1\n", "utf8");
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "demo-work",
      templateId: "demo",
      branchName: "tomdale/demo-work",
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
          hasLockfile: true,
        },
      ],
    });
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    process.chdir(workspaceDir);
    process.argv = ["node", "wf", "template", "add-file", "front/.env.local"];
    process.exitCode = undefined;

    await cli();

    expect(promptSelectMock).not.toHaveBeenCalled();
    expect(logs.join("\n")).not.toContain("No differences");
    await expect(readFile(templateFilePath, "utf8")).resolves.toBe(
      "FEATURE_FLAG=1\n",
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("requires wf template add-file outside a workspace to include a path", async () => {
    const cwd = await createTempDir("workforest-outside-");
    const errors: string[] = [];

    vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });

    await writeFile(path.join(cwd, ".envrc"), "use workforest\n", "utf8");
    process.chdir(cwd);
    process.argv = ["node", "wf", "template", "add-file", ".envrc"];
    process.exitCode = undefined;

    await cli();

    expect(errors.join("\n")).toContain(
      "Usage: workforest template add-file <template> <path...>",
    );
    expect(process.exitCode).toBe(1);
  });

  it("requires wf template add-file workspaces to have a source template", async () => {
    const workspaceDir = await createTempDir("workforest-workspace-");
    const errors: string[] = [];

    vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });

    await writeFile(
      path.join(workspaceDir, ".envrc"),
      "use workforest\n",
      "utf8",
    );
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "manual-work",
      branchName: "tomdale/manual-work",
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
    process.argv = ["node", "wf", "template", "add-file", ".envrc"];
    process.exitCode = undefined;

    await cli();

    expect(errors.join("\n")).toContain(
      "Current workspace was not created from a template",
    );
    expect(process.exitCode).toBe(1);
  });
});
