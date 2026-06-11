import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderCommandResult } from "./cli/output.ts";
import { executeCli } from "./cli.ts";

const execFileAsync = promisify(execFile);
const originalCacheDir = process.env["WORKFOREST_CACHE_DIR"];
const tempDirs: string[] = [];

type CliResult = {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
};

async function createCache(): Promise<string> {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "workforest-cache-"));
  tempDirs.push(cacheDir);
  process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
  return cacheDir;
}

async function createMirror(
  cacheDir: string,
  name: string,
  remote: string,
): Promise<void> {
  const mirrorDir = path.join(cacheDir, name);
  await mkdir(mirrorDir);
  await execFileAsync("git", ["init", "--bare", "--quiet"], {
    cwd: mirrorDir,
  });
  await execFileAsync("git", ["remote", "add", "origin", remote], {
    cwd: mirrorDir,
  });
}

async function createBrokenMirror(
  cacheDir: string,
  name = "broken.git",
): Promise<void> {
  const mirrorDir = path.join(cacheDir, name);
  await mkdir(mirrorDir);
  await writeFile(path.join(mirrorDir, "README"), "broken\n", "utf8");
}

async function runCommand(argv: readonly string[]): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const append = (values: unknown[]) => `${values.map(String).join(" ")}\n`;

  vi.spyOn(console, "log").mockImplementation((...values) => {
    stdout += append(values);
  });
  vi.spyOn(console, "warn").mockImplementation((...values) => {
    stderr += append(values);
  });
  vi.spyOn(console, "error").mockImplementation((...values) => {
    stderr += append(values);
  });

  const result = await executeCli(argv);
  renderCommandResult(result, {
    stdout(value) {
      stdout += value;
    },
    stderr(value) {
      stderr += value;
    },
  });

  return {
    exitCode: result.exitCode,
    stdout: stripAnsi(stdout),
    stderr: stripAnsi(stderr),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalCacheDir === undefined) {
    delete process.env["WORKFOREST_CACHE_DIR"];
  } else {
    process.env["WORKFOREST_CACHE_DIR"] = originalCacheDir;
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("cache commands", () => {
  it("keeps the bare namespace scoped to help", async () => {
    const result = await runCommand(["cache"]);

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("Usage: wf cache");
    expect(result.stdout).toContain("manage");
  });

  it("routes explicit management through the cache manager", async () => {
    const cacheDir = await createCache();
    const result = await runCommand(["cache", "manage"]);

    expect(result).toMatchObject({
      exitCode: 0,
      stderr: "",
    });
    expect(result.stdout).toContain("No cached repositories.");
    expect(result.stdout).toContain(cacheDir);
  });

  it.each([
    ["cache", "--help"],
    ["cache", "manage", "--help"],
    ["cache", "list", "--help"],
    ["cache", "info", "--help"],
    ["cache", "path", "--help"],
    ["cache", "add", "--help"],
    ["cache", "update", "--help"],
    ["cache", "doctor", "--help"],
    ["cache", "repair", "--help"],
    ["cache", "delete", "--help"],
    ["cache", "prune", "--help"],
  ])("renders cache help successfully for %j", async (...argv) => {
    const result = await runCommand(argv);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: wf");
    expect(result.stderr).toBe("");
  });

  it.each([
    [["cache", "list"], 0, "No cached repositories.", ""],
    [["cache", "add", "unknown"], 1, "", "Unknown repository"],
    [["cache", "update"], 0, "No cached repositories to update.", ""],
    [["cache", "doctor"], 0, "No cached repositories.", ""],
    [["cache", "repair"], 0, "No cached repositories to repair.", ""],
    [
      ["cache", "delete", "missing"],
      1,
      "",
      "Cached repository not found: missing",
    ],
    [["cache", "prune"], 0, "No unused cached repositories.", ""],
  ] as const)("implements canonical cache behavior for %j", async (argv, exitCode, stdout, stderr) => {
    await createCache();
    const result = await runCommand(argv);

    expect(result.exitCode).toBe(exitCode);
    expect(result.stdout).toContain(stdout);
    expect(result.stderr).toContain(stderr);
  });

  it.each([
    ["cache", "wat"],
    ["cache", "manage", "extra"],
    ["cache", "list", "extra"],
    ["cache", "info"],
    ["cache", "info", "one", "two"],
    ["cache", "path", "one", "two"],
    ["cache", "add"],
    ["cache", "delete"],
    ["cache", "prune", "extra"],
  ])("rejects invalid cache operands for %j", async (...argv) => {
    const result = await runCommand(argv);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
    expect(result.stderr).not.toContain("ArgError");
    expect(result.stderr).not.toContain("node_modules/arg");
  });

  it.each([
    ["cache", "manage", "--json"],
    ["cache", "list", "--bogus"],
    ["cache", "list", "--json", "--json"],
    ["cache", "list", "--force"],
    ["cache", "info", "front", "--force"],
    ["cache", "path", "--json"],
    ["cache", "add", "vercel/front", "--json"],
    ["cache", "update", "--json"],
    ["cache", "doctor", "--force"],
    ["cache", "repair", "--json"],
    ["cache", "delete", "front", "--json"],
    ["cache", "delete", "front", "-n", "--dry-run"],
    ["cache", "prune", "--json"],
  ])("rejects inapplicable cache flags for %j", async (...argv) => {
    const result = await runCommand(argv);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/Unknown flag|may only be specified once/);
    expect(result.stderr).not.toContain("node_modules/arg");
  });

  it("renders repository reports, JSON, and paths on their expected streams", async () => {
    const cacheDir = await createCache();
    await createMirror(
      cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );

    const human = await runCommand(["cache", "list"]);
    const list = await runCommand(["cache", "list", "--json"]);
    const info = await runCommand(["cache", "info", "vercel/front", "--json"]);
    const selectedPath = await runCommand(["cache", "path", "vercel/front"]);

    expect(human).toMatchObject({ exitCode: 0, stderr: "" });
    expect(human.stdout).toContain("Cached repositories");
    expect(human.stdout).toContain("vercel/front");
    expect(human.stdout).toContain(`Directory: ${cacheDir}`);
    expect(list).toMatchObject({ exitCode: 0, stderr: "" });
    expect(info).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(list.stdout)).toEqual([
      expect.objectContaining({
        slug: "vercel/front",
        mirrorPath: path.join(cacheDir, "front.git"),
      }),
    ]);
    expect(JSON.parse(info.stdout)).toEqual(
      expect.objectContaining({ slug: "vercel/front" }),
    );
    expect(selectedPath).toEqual({
      exitCode: 0,
      stdout: `${path.join(cacheDir, "front.git")}\n`,
      stderr: "",
    });
  }, 15_000);

  it("prints undecorated cache paths", async () => {
    const cacheDir = await createCache();
    const result = await runCommand(["cache", "path"]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: `${cacheDir}\n`,
      stderr: "",
    });
  });

  it("reports unhealthy mirrors and continues partial repairs", async () => {
    const cacheDir = await createCache();
    await createBrokenMirror(cacheDir);
    await createBrokenMirror(cacheDir, "damaged.git");

    const human = await runCommand(["cache", "doctor"]);
    const json = await runCommand(["cache", "doctor", "--json"]);
    const repair = await runCommand(["cache", "repair", "broken", "damaged"]);

    expect(human).toMatchObject({ exitCode: 1, stderr: "" });
    expect(human.stdout).toContain("invalid");
    expect(json).toMatchObject({ exitCode: 1, stderr: "" });
    expect(JSON.parse(json.stdout)).toEqual([
      expect.objectContaining({ name: "broken", health: "invalid" }),
      expect.objectContaining({ name: "damaged", health: "invalid" }),
    ]);
    expect(repair.exitCode).toBe(1);
    expect(repair.stderr).toContain(
      "broken is not a valid bare Git repository",
    );
    expect(repair.stderr).toContain(
      "damaged is not a valid bare Git repository",
    );
    expect(repair.stderr).not.toContain("at runRepositoryRepair");
  }, 15_000);

  it("supports destructive flags without deleting repositories", async () => {
    const cacheDir = await createCache();
    await createMirror(
      cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );

    const deletion = await runCommand([
      "cache",
      "delete",
      "vercel/front",
      "-n",
    ]);
    const pruning = await runCommand(["cache", "prune", "--dry-run", "-f"]);

    expect(deletion).toMatchObject({ exitCode: 0, stderr: "" });
    expect(deletion.stdout).toContain("Would delete vercel/front");
    expect(pruning).toMatchObject({ exitCode: 0, stderr: "" });
    expect(pruning.stdout).toContain("Would delete 1 unused repository");
    await expect(
      execFileAsync("git", ["rev-parse", "--is-bare-repository"], {
        cwd: path.join(cacheDir, "front.git"),
      }),
    ).resolves.toMatchObject({ stdout: "true\n" });
  });

  it("reports expected operational failures on stderr without a stack", async () => {
    await createCache();

    const result = await runCommand(["cache", "info", "missing"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Cached repository not found: missing");
    expect(result.stderr).not.toContain("at requireRepository");
  });
});
