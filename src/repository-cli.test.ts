import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cli } from "./cli.ts";

const execFileAsync = promisify(execFile);
const originalArgv = [...process.argv];
const originalExitCode = process.exitCode;
const originalCacheDir = process.env["WORKFOREST_CACHE_DIR"];
const tempDirs: string[] = [];

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

afterEach(async () => {
  vi.restoreAllMocks();
  process.argv = [...originalArgv];
  process.exitCode = originalExitCode;
  if (originalCacheDir === undefined) {
    delete process.env["WORKFOREST_CACHE_DIR"];
  } else {
    process.env["WORKFOREST_CACHE_DIR"] = originalCacheDir;
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("repository commands", () => {
  it("lists cached repositories as human-readable output", async () => {
    const cacheDir = await createCache();
    await createMirror(
      cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => {
      output.push(String(value));
    });

    process.argv = ["node", "wf", "repository", "list"];
    await cli();

    expect(output.join("\n")).toContain("Cached repositories");
    expect(output.join("\n")).toContain("vercel/front");
    expect(output.join("\n")).toContain(`Directory: ${cacheDir}`);
  });

  it("keeps JSON repository output parseable", async () => {
    const cacheDir = await createCache();
    await createMirror(
      cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => {
      output.push(String(value));
    });

    process.argv = ["node", "wf", "repository", "list", "--json"];
    await cli();

    expect(JSON.parse(output.join("\n"))).toEqual([
      expect.objectContaining({
        slug: "vercel/front",
        mirrorPath: path.join(cacheDir, "front.git"),
      }),
    ]);
  });

  it("prints undecorated cache paths", async () => {
    const cacheDir = await createCache();
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => {
      output.push(String(value));
    });

    process.argv = ["node", "wf", "repository", "path"];
    await cli();

    expect(output).toEqual([cacheDir]);
  });

  it("reports unhealthy mirrors and exits unsuccessfully", async () => {
    const cacheDir = await createCache();
    const broken = path.join(cacheDir, "broken.git");
    await mkdir(broken);
    await writeFile(path.join(broken, "README"), "broken\n", "utf8");
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => {
      output.push(String(value));
    });

    process.argv = ["node", "wf", "repository", "doctor"];
    process.exitCode = undefined;
    await cli();

    expect(output.join("\n")).toContain("invalid");
    expect(process.exitCode).toBe(1);
  });

  it("previews unused repository cleanup", async () => {
    const cacheDir = await createCache();
    await createMirror(
      cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...values) => {
      output.push(values.join(" "));
    });

    process.argv = ["node", "wf", "repository", "clean", "--dry-run"];
    await cli();

    expect(output.join("")).toContain("Would delete 1 unused repository");
    await expect(
      execFileAsync("git", ["rev-parse", "--is-bare-repository"], {
        cwd: path.join(cacheDir, "front.git"),
      }),
    ).resolves.toMatchObject({ stdout: "true\n" });
  });
});
