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

    expect(result.stderr).toContain("Running local copy");
    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
  });

  it("styles help when color is supported", async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FORCE_COLOR: "1",
    };
    Reflect.deleteProperty(env, "NO_COLOR");

    const result = await execFileAsync(
      process.execPath,
      [path.resolve("bin/workforest.js"), "--help"],
      {
        env,
        timeout: 10_000,
      },
    );

    expect(result.stdout).toContain("\u001b[");
    expect(stripAnsi(result.stdout)).toContain("Usage: wf");
  });

  it("keeps bundled skill content undecorated on stdout", async () => {
    const result = await execFileAsync(
      process.execPath,
      [path.resolve("bin/workforest.js"), "skills", "get", "core"],
      {
        env: {
          ...process.env,
          WORKFOREST_SKILLS_DIR: path.resolve("skill-data"),
        },
        timeout: 10_000,
      },
    );

    expect(result.stdout).toMatch(/^---\nname: core\n/);
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

  it("keeps JSON output as a single envelope before dashboard preload", async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NO_COLOR: "1",
    };
    Reflect.deleteProperty(env, "WORKFOREST_NO_TUI");
    Reflect.deleteProperty(env, "WORKFOREST_USE_SOURCE_CLI");

    const result = await execFileAsync(
      process.execPath,
      [path.resolve("bin/workforest.js"), "version", "--json"],
      { env, timeout: 10_000 },
    );

    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual({
      ok: true,
      data: { version: expect.any(String) },
    });
    expect(result.stdout).toBe(`${JSON.stringify(parsed)}\n`);
    expect(result.stderr).toBe("");
  });

  it("reports invocation errors without parser stacks", async () => {
    const result = await runSubprocess(
      process.execPath,
      [path.resolve("bin/workforest.js"), "wat"],
      { timeout: 10_000 },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown command: wat");
    expect(result.stderr).not.toContain("ArgError");
    expect(result.stderr).not.toContain("at parse");
    expect(result.stderr).not.toContain("node_modules/arg");
  });

  it("renders JSON invocation errors as valid envelopes", async () => {
    const result = await runSubprocess(
      process.execPath,
      [path.resolve("bin/workforest.js"), "list", "--bogus", "--json"],
      { timeout: 10_000 },
    );

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: {
        kind: "usage",
        message: 'Unknown flag "--bogus" for wf list.',
      },
    });
    expect(result.stdout).not.toContain("Running local copy");
    expect(result.stderr).not.toContain("ArgError");
    expect(result.stderr).not.toContain("at parse");
  });
});
