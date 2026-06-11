import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderCommandResult } from "./cli/output.ts";
import { executeCli } from "./cli.ts";

const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const ORIGINAL_SKILLS_DIR = process.env["WORKFOREST_SKILLS_DIR"];
const tempDirs: string[] = [];
let configDir: string;
let skillsDir: string;
let skillDir: string;

type CommandExecution = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

beforeAll(async () => {
  configDir = await createTempDir("workforest-core-config-");
  skillsDir = await createTempDir("workforest-core-skills-");
  skillDir = path.join(skillsDir, "core");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: core",
      "description: Core command guide",
      "---",
      "",
      "# Core",
      "",
      "Core content.",
      "",
    ].join("\n"),
    "utf8",
  );
  process.env["WORKFOREST_CONFIG_DIR"] = configDir;
  process.env["WORKFOREST_SKILLS_DIR"] = skillsDir;
});

afterAll(async () => {
  restoreEnv("WORKFOREST_CONFIG_DIR", ORIGINAL_CONFIG_DIR);
  restoreEnv("WORKFOREST_SKILLS_DIR", ORIGINAL_SKILLS_DIR);
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("core command family conformance", () => {
  it.each([
    [["version", "--help"], "Usage: wf version"],
    [["shell", "--help"], "Usage: wf shell"],
    [["shell", "init", "--help"], "Usage: wf shell init"],
    [["config", "--help"], "Usage: wf config"],
    [["config", "show", "--help"], "Usage: wf config show"],
    [["config", "init", "--help"], "Usage: wf config init"],
    [["config", "edit", "--help"], "Usage: wf config edit"],
    [["skills", "--help"], "Usage: wf skills"],
    [["skills", "list", "--help"], "Usage: wf skills list"],
    [["skills", "get", "--help"], "Usage: wf skills get"],
    [["skills", "path", "--help"], "Usage: wf skills path"],
  ])("renders scoped help for %j", async (argv, usage) => {
    const result = await runCommand(argv);

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain(usage);
  });

  it("renders version output raw on stdout", async () => {
    const canonical = await runCommand(["version"]);

    expect(canonical).toMatchObject({
      exitCode: 0,
      stdout: "workforest 0.0.1\n",
      stderr: "",
    });
  });

  it("keeps bare config and skills defaults equivalent to their leaves", async () => {
    const bareConfig = await runCommandCapturingConsole(["config"]);
    const shownConfig = await runCommandCapturingConsole(["config", "show"]);
    const [bareSkills, listedSkills] = await Promise.all([
      runCommand(["skills", "--json"]),
      runCommand(["skills", "list", "--json"]),
    ]);

    expect(bareConfig).toEqual(shownConfig);
    expect(bareConfig).toMatchObject({ exitCode: 0, stderr: "" });
    expect(bareConfig.stdout).toContain("Workspace configuration");
    expect(bareSkills).toEqual(listedSkills);
    expect(JSON.parse(bareSkills.stdout)).toEqual({
      ok: true,
      data: [{ name: "core", description: "Core command guide" }],
    });
  });

  it("renders shell init source without stderr decoration", async () => {
    const result = await runCommand(["shell", "init", "bash"]);

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toMatch(
      /^# workforest shell integration for bash\n__workforest_invoke\(\)/,
    );
  });

  it("keeps skills get and path raw on stdout", async () => {
    const [getResult, pathResult] = await Promise.all([
      runCommand(["skills", "get", "core"]),
      runCommand(["skills", "path", "core"]),
    ]);

    expect(getResult).toMatchObject({ exitCode: 0, stderr: "" });
    expect(getResult.stdout).toMatch(/^---\nname: core\n/);
    expect(pathResult).toEqual({
      exitCode: 0,
      stdout: `${skillDir}\n`,
      stderr: "",
    });
  });

  it("keeps skills JSON failures parseable on stdout", async () => {
    const result = await runCommand(["skills", "get", "missing", "--json"]);

    expect(result).toMatchObject({ exitCode: 1, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: {
        kind: "operational",
        message: "Skill not found: missing",
      },
    });
  });

  it.each([
    [["version", "extra"], "Invalid operands for wf version"],
    [["shell", "init", "bash", "extra"], "Invalid operands for wf shell init"],
    [["config", "show", "extra"], "Invalid operands for wf config show"],
    [["config", "init", "extra"], "Invalid operands for wf config init"],
    [["config", "edit", "extra"], "Invalid operands for wf config edit"],
    [["skills", "list", "extra"], "Invalid operands for wf skills list"],
    [
      ["skills", "path", "core", "extra"],
      "Invalid operands for wf skills path",
    ],
    [["skills", "get", "--all", "core"], "Invalid operands for wf skills get"],
  ])("rejects surplus operands for %j", async (argv, message) => {
    await expectUsageError(argv, message);
  });

  it.each([
    [["version", "--json"], 'Unknown flag "--json" for wf version'],
    [["shell", "init", "--json"], 'Unknown flag "--json" for wf shell init'],
    [["config", "show", "--json"], 'Unknown flag "--json" for wf config show'],
    [["config", "init", "--json"], 'Unknown flag "--json" for wf config init'],
    [["config", "edit", "--json"], 'Unknown flag "--json" for wf config edit'],
    [["skills", "list", "--full"], 'Unknown flag "--full" for wf skills list'],
    [["skills", "get", "--bogus"], 'Unknown flag "--bogus" for wf skills get'],
    [["skills", "path", "--full"], 'Unknown flag "--full" for wf skills path'],
  ])("rejects unknown or inapplicable flags for %j", async (argv, message) => {
    if (argv.includes("--json")) {
      await expectJsonUsageError(argv, message);
    } else {
      await expectUsageError(argv, message);
    }
  });

  it("reports valid non-interactive config init as an operational failure", async () => {
    const result = await runCommand(["config", "init"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Config init requires an interactive terminal.",
    );
    expect(result.stderr).toContain("Use 'wf config edit'");
    expect(result.stderr).not.toContain("at runConfigInit");
  });

  it("runs config edit with an explicit editor", async () => {
    const result = await runCommandCapturingConsole(["config", "edit"], {
      EDITOR: "/usr/bin/true",
    });

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("Opening");
    expect(result.stdout).toContain("Config file closed");
  });

  it("reports malformed config as an operational failure without a stack", async () => {
    const malformedConfigDir = await createTempDir(
      "workforest-malformed-config-",
    );
    await writeFile(
      path.join(malformedConfigDir, "config.json"),
      "{ invalid",
      "utf8",
    );

    const result = await runCommandCapturingConsole(["config", "show"], {
      WORKFOREST_CONFIG_DIR: malformedConfigDir,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("at loadWorkspaceConfig");
    expect(result.stderr).not.toContain("\n    at ");
  });

  it("reports unsupported shells as usage failures", async () => {
    const result = await runCommand(["shell", "init", "fish"]);

    expect(result).toEqual({
      exitCode: 2,
      stdout: "",
      stderr:
        "Unsupported shell. Use 'wf shell init zsh' or 'wf shell init bash'.\n",
    });
  });

  it("reports human skills failures on stderr without stacks", async () => {
    const result = await runCommand(["skills", "get", "missing"]);

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Skill not found: missing\n",
    });
  });
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function runCommandCapturingConsole(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<CommandExecution> {
  const originalEnv = new Map(
    Object.keys(env).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, env);
  let stdout = "";
  let stderr = "";
  const log = vi.spyOn(console, "log").mockImplementation((...args) => {
    stdout += `${args.join(" ")}\n`;
  });
  const error = vi.spyOn(console, "error").mockImplementation((...args) => {
    stderr += `${args.join(" ")}\n`;
  });

  try {
    const result = await executeCli(argv);
    renderCommandResult(result, {
      stdout(value) {
        stdout += value;
      },
      stderr(value) {
        stderr += value;
      },
    });
    return { exitCode: result.exitCode, stdout, stderr };
  } finally {
    log.mockRestore();
    error.mockRestore();
    for (const [name, value] of originalEnv) {
      restoreEnv(name, value);
    }
  }
}

async function runCommand(argv: readonly string[]): Promise<CommandExecution> {
  const result = await executeCli(argv);
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
  return { exitCode: result.exitCode, stdout, stderr };
}

async function expectUsageError(
  argv: readonly string[],
  message: string,
): Promise<void> {
  const result = await runCommand(argv);

  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(message);
  expect(result.stderr).not.toContain("ArgError");
  expect(result.stderr).not.toContain("node_modules/arg");
  expect(result.stderr).not.toContain("at parseInvocation");
}

async function expectJsonUsageError(
  argv: readonly string[],
  message: string,
): Promise<void> {
  const result = await runCommand(argv);

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    ok: false,
    error: {
      kind: "usage",
      message: expect.stringContaining(message),
    },
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
