import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import stripAnsi from "strip-ansi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSubprocess } from "./test-utils/subprocess.ts";

const CLI_MODULE_URL = pathToFileURL(path.resolve("src/cli.ts")).href;
const CLI_SCRIPT = [
  `const { cli } = await import(${JSON.stringify(CLI_MODULE_URL)});`,
  'process.argv = ["node", "wf", ...JSON.parse(process.env.WORKFOREST_TEST_ARGV ?? "[]")];',
  "await cli();",
].join("\n");
const tempDirs: string[] = [];

let cacheDir: string;
let configDir: string;
let homeDir: string;
let skillsDir: string;
let unrelatedDir: string;

beforeAll(async () => {
  cacheDir = await createTempDir("workforest-errors-cache-");
  configDir = await createTempDir("workforest-errors-config-");
  homeDir = await createTempDir("workforest-errors-home-");
  skillsDir = await createTempDir("workforest-errors-skills-");
  unrelatedDir = await createTempDir("workforest-errors-unrelated-");
});

afterAll(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("expected CLI errors", () => {
  it.each([
    [["status"], 1, "Not in a Workforest change."],
    [["cache", "info", "missing"], 1, "Cached repository not found: missing"],
    [["skills", "get", "missing"], 1, "Skill not found: missing"],
    [["wat"], 2, "Unknown command: wat"],
    [["status", "one", "two"], 2, "Invalid operands for wf status."],
  ])("prints a concise error without a stack for %j", async (argv, exitCode, message) => {
    const result = await runCli(argv);

    expect(result.exitCode).toBe(exitCode);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
    expect(result.stderr).toBe(stripAnsi(result.stderr));
    expect(result.stderr.endsWith("\n")).toBe(true);
    expectNoStack(result.stderr);
  });

  it("prints malformed configuration errors without a stack", async () => {
    await writeFile(path.join(configDir, "config.json"), "{ malformed", "utf8");

    const result = await runCli(["config", "show"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unable to parse workspace config");
    expectNoStack(result.stderr);
  });
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function runCli(argv: readonly string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    NO_COLOR: "1",
    WORKFOREST_CACHE_DIR: cacheDir,
    WORKFOREST_CONFIG_DIR: configDir,
    WORKFOREST_SKILLS_DIR: skillsDir,
    WORKFOREST_TEST_ARGV: JSON.stringify(argv),
  };
  delete env["FORCE_COLOR"];

  return runSubprocess(
    process.execPath,
    ["--input-type=module", "--eval", CLI_SCRIPT],
    {
      cwd: unrelatedDir,
      env,
      timeout: 10_000,
    },
  );
}

function expectNoStack(output: string): void {
  expect(output).not.toContain("node_modules/");
  expect(output).not.toMatch(/\n\s+at /);
  expect(output).not.toMatch(/\b(?:UsageError|OperationalError):/);
  expect(output).not.toContain("at executeCli");
  expect(output).not.toContain("at parseInvocation");
}
