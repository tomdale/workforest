import { execFile } from "node:child_process";
import {
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
import { createTemplate, loadTemplate } from "./templates/index.ts";
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
  it("previews and confirms configuration before saving", async () => {
    const configDir = await createTempDir("workforest-config-");
    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    promptTextMock
      .mockResolvedValueOnce("~/Code")
      .mockResolvedValueOnce("Repos")
      .mockResolvedValueOnce("Workspaces")
      .mockResolvedValueOnce("Reviews")
      .mockResolvedValueOnce("tomdale/");
    promptConfirmMock.mockResolvedValue(true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    process.argv = ["node", "wf", "config", "init"];
    process.exitCode = undefined;

    await cli();

    expect(promptConfirmMock).toHaveBeenCalledOnce();
    await expect(
      readFile(path.join(configDir, "config.json"), "utf8").then(JSON.parse),
    ).resolves.toEqual({
      directory: {
        base: "~/Code",
        repos: "Repos",
        workspaces: "Workspaces",
        reviews: "Reviews",
      },
      branchPrefix: "tomdale/",
    });
  });

  it("stores qualified repositories when creating a template", async () => {
    const cacheDir = await createTempDir("workforest-cache-");
    const xdgConfigHome = await createTempDir("workforest-xdg-");

    process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;
    await createCachedMirror(
      cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );

    process.argv = ["node", "wf", "template", "new", "site", "front"];
    process.exitCode = undefined;

    await cli();

    await expect(loadTemplate("site")).resolves.toMatchObject({
      config: { repos: ["vercel/front"] },
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("warns and fails when registered repository names collide", async () => {
    const configDir = await createTempDir("workforest-config-");
    const cacheDir = await createTempDir("workforest-cache-");
    const errors: string[] = [];

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

    vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });

    process.argv = ["node", "wf", "new", "fix-auth", "myapp"];
    process.exitCode = undefined;

    await cli();

    expect(errors.join("\n")).toContain(
      'Repository shorthand "myapp" has a naming collision',
    );
    expect(errors.join("\n")).toContain("first/myapp, second/myapp");
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["new", "Usage: wf new"],
    ["add", "Usage: wf add"],
    ["switch", "Usage: wf switch"],
    ["list", "Usage: wf list"],
    ["status", "Usage: wf status"],
    ["delete", "Usage: wf delete"],
    ["ai", "Usage: wf ai"],
    ["migrate", "Usage: wf migrate"],
    ["task", "Usage: wf task"],
    ["review", "Usage: wf review"],
    ["template", "Usage: wf template"],
    ["cache", "Usage: wf cache"],
    ["shell", "Usage: wf shell"],
    ["config", "Usage: wf config"],
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
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    [["task", "new", "--help"], "Usage: wf task new"],
    [["task", "list", "--help"], "Usage: wf task list"],
    [["task", "delete", "--help"], "Usage: wf task delete"],
    [["ai", "status", "--help"], "Usage: wf ai status"],
    [["migrate", "workspaces", "--help"], "Usage: wf migrate workspaces"],
    [["review", "open", "--help"], "Usage: wf review open"],
    [["review", "checkout", "--help"], "Usage: wf review checkout"],
    [["template", "list", "--help"], "Usage: wf template list"],
    [["template", "open", "--help"], "Usage: wf template open"],
    [["template", "show", "--help"], "Usage: wf template show"],
    [["template", "new", "--help"], "Usage: wf template new"],
    [["template", "delete", "--help"], "Usage: wf template delete"],
    [["template", "add-file", "--help"], "Usage: wf template add-file"],
    [["cache", "list", "--help"], "Usage: wf cache list"],
    [["cache", "show", "--help"], "Usage: wf cache show"],
    [["cache", "sync", "--help"], "Usage: wf cache sync"],
    [["cache", "doctor", "--help"], "Usage: wf cache doctor"],
    [["cache", "delete", "--help"], "Usage: wf cache delete"],
    [["cache", "clean", "--help"], "Usage: wf cache clean"],
    [["shell", "init", "--help"], "Usage: wf shell init"],
    [["config", "edit", "--help"], "Usage: wf config edit"],
    [["skills", "get", "--help"], "Usage: wf skills get"],
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
    expect(process.exitCode).toBeUndefined();
  });

  it("writes the template directory for wf template open", async () => {
    const xdgConfigHome = await createTempDir("workforest-xdg-");
    const cdDir = await createTempDir("workforest-cd-");
    const cdPathFile = path.join(cdDir, "target");

    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;
    process.env[WORKFOREST_CD_PATH_ENV] = cdPathFile;

    await createTemplate("demo", {
      repos: ["vercel/front"],
      description: "Demo template",
    });

    process.argv = ["node", "wf", "template", "open", "demo"];
    process.exitCode = undefined;

    await cli();

    const written = await readFile(cdPathFile, "utf8");
    expect(written).toBe(
      `${path.resolve(xdgConfigHome, "workforest", "templates", "demo")}\n`,
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("lists templates for wf template list outside a TTY", async () => {
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

    process.argv = ["node", "wf", "template", "list"];
    process.exitCode = undefined;

    await cli();

    expect(logs.join("\n")).toContain("Templates");
    expect(logs.join("\n")).toContain("demo");
    expect(process.exitCode).toBeUndefined();
  });

  it("shows scoped help for wf template without a subcommand", async () => {
    const logs: string[] = [];
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    process.argv = ["node", "wf", "template"];
    process.exitCode = undefined;

    await cli();

    expect(logs.join("\n")).toContain("Usage: wf template");
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
