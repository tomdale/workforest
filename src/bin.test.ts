import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { runSubprocess } from "./test-utils/subprocess.ts";

const execFileAsync = promisify(execFile);

describe("bin/workforest.js", () => {
  it("runs through node and loads the built CLI by default", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    Reflect.deleteProperty(env, "WORKFOREST_USE_SOURCE_CLI");

    const result = await execFileAsync(
      process.execPath,
      [path.resolve("bin/workforest.js"), "--help"],
      { env, timeout: 10_000 },
    );

    expect(result.stdout).toContain("Start here (for AI agents):");
    expect(result.stdout).toBe(stripAnsi(result.stdout));
    expect(result.stderr).not.toContain("Running local copy");
  });

  it("loads the source CLI when WORKFOREST_USE_SOURCE_CLI is set", async () => {
    const result = await execFileAsync(
      process.execPath,
      [path.resolve("bin/workforest.js"), "--help"],
      {
        env: {
          ...process.env,
          WORKFOREST_USE_SOURCE_CLI: "1",
        },
        timeout: 10_000,
      },
    );

    expect(result.stdout).toContain("Start here (for AI agents):");
    expect(result.stderr).toContain("Running local copy");
    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
  });

  it("styles every help level when color is supported", async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FORCE_COLOR: "1",
    };
    Reflect.deleteProperty(env, "NO_COLOR");

    const results = await Promise.all(
      [
        ["--help"],
        ["worktree", "--help"],
        ["worktree", "delete", "--help"],
        ["workspace", "create", "--help"],
      ].map((args) =>
        execFileAsync(
          process.execPath,
          [path.resolve("bin/workforest.js"), ...args],
          {
            env,
            timeout: 10_000,
          },
        ),
      ),
    );

    for (const result of results) {
      expect(result.stdout).toContain("\u001b[");
      expect(stripAnsi(result.stdout)).toContain("Usage: wf");
    }

    const coloredOutput = results.map((result) => result.stdout).join("");
    expect(coloredOutput).toContain("\u001b[36m");
    expect(coloredOutput).toContain("\u001b[33m");
    expect(coloredOutput).toContain("\u001b[96m");
    expect(coloredOutput).toContain("\u001b[97m");
    expect(coloredOutput).not.toContain("\u001b[32m");
    expect(coloredOutput).not.toContain("\u001b[35m");
  });

  it("keeps bundled skill content undecorated on stdout", async () => {
    const result = await execFileAsync(
      process.execPath,
      [path.resolve("bin/workforest.js"), "skills", "get", "terminal-ui"],
      {
        env: {
          ...process.env,
          WORKFOREST_SKILLS_DIR: path.resolve("skill-data"),
        },
        timeout: 10_000,
      },
    );

    expect(result.stdout).toMatch(/^---\nname: terminal-ui\n/);
    expect(result.stdout).not.toContain("Running local copy");
  });

  it("keeps JSON skill output parseable", async () => {
    const result = await execFileAsync(
      process.execPath,
      [path.resolve("bin/workforest.js"), "skills", "list", "--json"],
      {
        env: {
          ...process.env,
          WORKFOREST_SKILLS_DIR: path.resolve("skill-data"),
        },
        timeout: 10_000,
      },
    );

    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({ ok: true }),
    );
  });

  it.each([
    [["wat"], "Unknown command: wat"],
    [
      ["workspace", "list", "--bogus"],
      'Unknown flag "--bogus" for wf workspace list',
    ],
    [["template", "copy", "only-one"], "Invalid operands for wf template copy"],
  ])("reports invocation errors without parser stacks for %j", async (args, message) => {
    const result = await runSubprocess(
      process.execPath,
      [path.resolve("bin/workforest.js"), ...args],
      { timeout: 10_000 },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(message);
    expect(result.stderr).not.toContain("ArgError");
    expect(result.stderr).not.toContain("at parse");
    expect(result.stderr).not.toContain("node_modules/arg");
  });

  it("renders JSON invocation errors as valid envelopes", async () => {
    const result = await runSubprocess(
      process.execPath,
      [path.resolve("bin/workforest.js"), "task", "list", "--json"],
      { timeout: 10_000 },
    );

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: {
        kind: "usage",
        message: 'Unknown flag "--json" for wf task list.',
      },
    });
    expect(result.stdout).not.toContain("Running local copy");
    expect(result.stderr).not.toContain("ArgError");
    expect(result.stderr).not.toContain("at parse");
  });
});
