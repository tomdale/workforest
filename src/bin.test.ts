import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("bin/workforest.js", () => {
  it("runs through node and loads the source CLI", async () => {
    const result = await execFileAsync(
      process.execPath,
      [path.resolve("bin/workforest.js"), "--help"],
      { timeout: 10_000 },
    );

    expect(result.stdout).toContain("Start here (for AI agents):");
    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
  });
});
