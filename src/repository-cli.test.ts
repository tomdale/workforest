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
const originalConfigDir = process.env["WORKFOREST_CONFIG_DIR"];
const tempDirs: string[] = [];

type CliResult = {
  exitCode: number;
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

async function createBareRemote(): Promise<string> {
  const remoteDir = await mkdtemp(path.join(os.tmpdir(), "workforest-remote-"));
  tempDirs.push(remoteDir);
  await execFileAsync("git", ["init", "--bare", "--quiet"], {
    cwd: remoteDir,
  });
  return remoteDir;
}

/**
 * Point WORKFOREST_CONFIG_DIR at a scratch config whose managed base is an empty
 * temp dir, and return that base. The managed-directory guard is a pure path
 * check, so the base need not exist on disk — tests build paths relative to it.
 */
async function createManagedConfig(): Promise<string> {
  const base = await mkdtemp(path.join(os.tmpdir(), "workforest-managed-"));
  tempDirs.push(base);
  const configDir = await mkdtemp(path.join(os.tmpdir(), "workforest-config-"));
  tempDirs.push(configDir);
  await writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ directory: { base } }),
  );
  process.env["WORKFOREST_CONFIG_DIR"] = configDir;
  return base;
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
  if (originalConfigDir === undefined) {
    delete process.env["WORKFOREST_CONFIG_DIR"];
  } else {
    process.env["WORKFOREST_CONFIG_DIR"] = originalConfigDir;
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
  });

  it.each([
    ["cache", "--help"],
    ["cache", "list", "--help"],
    ["cache", "show", "--help"],
    ["cache", "sync", "--help"],
    ["cache", "doctor", "--help"],
    ["cache", "delete", "--help"],
    ["cache", "clean", "--help"],
  ])("renders cache help successfully for %j", async (...argv) => {
    const result = await runCommand(argv);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: wf");
    expect(result.stderr).toBe("");
  });

  it.each([
    [["cache", "list"], 0, "No cached repositories", ""],
    [["cache", "sync", "unknown"], 1, "", "Unknown repository"],
    [["cache", "sync"], 0, "No cached repositories to sync", ""],
    [["cache", "doctor"], 0, "No cached repositories", ""],
    [["cache", "doctor", "--fix"], 0, "No cached repositories", ""],
    [
      ["cache", "delete", "missing"],
      1,
      "",
      "Cached repository not found: missing",
    ],
    [["cache", "clean"], 0, "No unused cached repositories", ""],
  ] as const)("implements canonical cache behavior for %j", async (argv, exitCode, stdout, stderr) => {
    await createCache();
    const result = await runCommand(argv);

    expect(result.exitCode).toBe(exitCode);
    expect(result.stdout).toContain(stdout);
    expect(result.stderr).toContain(stderr);
  });

  it("rejects invalid cache operands", async () => {
    const result = await runCommand(["cache", "list", "extra"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
    expect(result.stderr).not.toContain("ArgError");
    expect(result.stderr).not.toContain("node_modules/arg");
  });

  it.each([
    ["cache", "show", "front", "--path", "--json"],
    ["cache", "delete", "front", "-n", "--dry-run"],
  ])("rejects inapplicable cache flags for %j", async (...argv) => {
    const result = await runCommand(argv);

    expect(result.exitCode).toBe(2);
    if (argv.includes("--json")) {
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        ok: false,
        error: {
          kind: "usage",
          message: expect.stringMatching(
            /Unknown flag|may only be specified once|cannot be combined/,
          ),
        },
      });
    } else {
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/Unknown flag|may only be specified once/);
    }
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
    const info = await runCommand(["cache", "show", "vercel/front", "--json"]);
    const selectedPath = await runCommand([
      "cache",
      "show",
      "vercel/front",
      "--path",
    ]);

    expect(human).toMatchObject({ exitCode: 0, stderr: "" });
    expect(human.stdout).toContain("Cached repositories");
    expect(human.stdout).toContain("vercel/front");
    expect(human.stdout).toContain(`Directory: ${cacheDir}`);
    expect(list).toMatchObject({ exitCode: 0, stderr: "" });
    expect(info).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(list.stdout)).toEqual({
      ok: true,
      data: [
        expect.objectContaining({
          slug: "vercel/front",
          mirrorPath: path.join(cacheDir, "front.git"),
        }),
      ],
    });
    expect(JSON.parse(info.stdout)).toEqual({
      ok: true,
      data: expect.objectContaining({ slug: "vercel/front" }),
    });
    expect(selectedPath).toEqual({
      exitCode: 0,
      stdout: `${path.join(cacheDir, "front.git")}\n`,
      stderr: "",
    });
  }, 30_000);

  it("prints undecorated cache paths", async () => {
    const cacheDir = await createCache();
    const result = await runCommand(["cache", "show", "--path"]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: `${cacheDir}\n`,
      stderr: "",
    });
  });

  it("reports unhealthy mirrors and continues partial fixes", async () => {
    const cacheDir = await createCache();
    await createBrokenMirror(cacheDir);
    await createBrokenMirror(cacheDir, "damaged.git");

    const human = await runCommand(["cache", "doctor"]);
    const json = await runCommand(["cache", "doctor", "--json"]);
    const fixed = await runCommand([
      "cache",
      "doctor",
      "broken",
      "damaged",
      "--fix",
    ]);

    expect(human).toMatchObject({ exitCode: 1, stderr: "" });
    expect(human.stdout).toContain("invalid");
    expect(json).toMatchObject({ exitCode: 1, stderr: "" });
    expect(JSON.parse(json.stdout)).toEqual({
      ok: true,
      data: [
        expect.objectContaining({ name: "broken", health: "invalid" }),
        expect.objectContaining({ name: "damaged", health: "invalid" }),
      ],
    });
    expect(fixed).toMatchObject({ exitCode: 1, stderr: "" });
    expect(fixed.stdout).toContain("broken");
    expect(fixed.stdout).toContain("damaged");
    expect(fixed.stdout).toContain("invalid");
  }, 15_000);

  it("syncs cached selections and continues after missing repository errors", async () => {
    const cacheDir = await createCache();
    const remote = await createBareRemote();
    await createMirror(cacheDir, "front.git", remote);

    const result = await runCommand(["cache", "sync", "front.git", "unknown"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Updated ${remote}`);
    expect(result.stderr).toContain("unknown: Unknown repository");
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
    const pruning = await runCommand(["cache", "clean", "--dry-run", "-f"]);

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

    const result = await runCommand(["cache", "show", "missing"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Cached repository not found: missing");
    expect(result.stderr).not.toContain("at requireRepository");
  });
});

describe("cache worktree commands", () => {
  it("refuses raw worktree ops inside managed directories", async () => {
    const cacheDir = await createCache();
    await createMirror(
      cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );
    const base = await createManagedConfig();
    const inside = path.join(base, "Repos", "front", "fix-auth");

    const result = await runCommand([
      "cache",
      "worktree",
      "add",
      "vercel/front",
      inside,
      "fix-auth",
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Refusing to run a raw cache worktree op inside a managed Workforest directory",
    );
  });

  it("allows raw worktree ops outside managed directories", async () => {
    const cacheDir = await createCache();
    await createMirror(
      cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );
    await createManagedConfig();
    const outsideRoot = await mkdtemp(
      path.join(os.tmpdir(), "workforest-worktree-outside-"),
    );
    tempDirs.push(outsideRoot);
    const outside = path.join(outsideRoot, "checkout");

    const result = await runCommand([
      "cache",
      "worktree",
      "add",
      "vercel/front",
      outside,
    ]);

    // The guard permits the path (it is outside every managed directory). The op
    // then reaches git, which fails only because this throwaway mirror has no
    // commits to branch from — the point is that this is *not* the guard's
    // refusal (which would exit 2 with the message asserted above).
    expect(result.exitCode).not.toBe(2);
    expect(result.stderr).not.toContain(
      "Refusing to run a raw cache worktree op",
    );
  });
});
