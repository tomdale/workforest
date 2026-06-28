import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { saveWorkspaceConfig } from "../config.ts";
import { createTemplate } from "../templates/index.ts";
import {
  filterSourceCandidates,
  inferEntry,
  listSourceCandidates,
  type SourceCandidate,
} from "./sources-data.ts";

const execFileAsync = promisify(execFile);
const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const ORIGINAL_CACHE_DIR = process.env["WORKFOREST_CACHE_DIR"];
const ORIGINAL_XDG_CONFIG_HOME = process.env["XDG_CONFIG_HOME"];
const tempDirs: string[] = [];

afterEach(async () => {
  restoreEnv("WORKFOREST_CONFIG_DIR", ORIGINAL_CONFIG_DIR);
  restoreEnv("WORKFOREST_CACHE_DIR", ORIGINAL_CACHE_DIR);
  restoreEnv("XDG_CONFIG_HOME", ORIGINAL_XDG_CONFIG_HOME);
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("listSourceCandidates", () => {
  it("lists cached repositories and templates as candidates", async () => {
    const fixture = await createSourcesFixture();
    await createCachedMirror(
      fixture.cacheDir,
      "front.git",
      "git@github.com:vercel/front.git",
    );
    await createTemplate("vercel-agent", {
      repos: ["vercel/front", "vercel/api"],
      description: "Agent workspace",
    });

    const candidates = await listSourceCandidates();
    const repo = candidates.find((c) => c.kind === "repo");
    const template = candidates.find((c) => c.kind === "template");

    expect(repo).toMatchObject({
      kind: "repo",
      id: "vercel/front",
      label: "vercel/front",
      hint: "Cached repository",
    });
    expect(template).toMatchObject({
      kind: "template",
      id: "vercel-agent",
      label: "vercel-agent",
      hint: "Agent workspace",
    });
  });

  it("falls back to a repo-count hint when a template has no description", async () => {
    await createSourcesFixture();
    await createTemplate("solo", { repos: ["vercel/front"] });

    const candidates = await listSourceCandidates();
    expect(candidates.find((c) => c.id === "solo")?.hint).toBe(
      "Template · 1 repo",
    );
  });
});

describe("filterSourceCandidates", () => {
  const candidates: SourceCandidate[] = [
    { kind: "repo", id: "vercel/front", label: "vercel/front", hint: "" },
    { kind: "template", id: "vercel-agent", label: "vercel-agent", hint: "" },
  ];

  it("returns all candidates for an empty query", () => {
    expect(filterSourceCandidates(candidates, "")).toEqual(candidates);
  });

  it("matches case-insensitive subsequences", () => {
    expect(
      filterSourceCandidates(candidates, "agent").map((c) => c.id),
    ).toEqual(["vercel-agent"]);
  });
});

describe("inferEntry", () => {
  it("infers a single-repository change", async () => {
    await createSourcesFixture();

    const result = await inferEntry({
      changeName: "redesign-cli",
      sources: [{ kind: "repo", token: "vercel/front" }],
    });

    expect(result).toEqual({
      type: "repository",
      relativePath: path.join("Repos", "front", "redesign-cli"),
      branch: "tomdale/redesign-cli",
      repoPreview: ["front"],
    });
  });

  it("infers an ad-hoc workspace for multiple repositories", async () => {
    await createSourcesFixture();

    const result = await inferEntry({
      changeName: "billing",
      sources: [
        { kind: "repo", token: "vercel/front" },
        { kind: "repo", token: "vercel/api" },
      ],
    });

    expect(result).toEqual({
      type: "adhoc",
      relativePath: path.join("Workspaces", "_adhoc", "billing"),
      branch: "tomdale/billing",
      repoPreview: ["front", "api"],
    });
  });

  it("infers a template workspace with the template branch prefix", async () => {
    await createSourcesFixture();
    await createTemplate("vercel-agent", {
      repos: ["vercel/front", "vercel/api"],
      branchPrefix: "agent",
    });

    const result = await inferEntry({
      changeName: "auth-fix",
      sources: [{ kind: "template", name: "vercel-agent" }],
    });

    expect(result).toEqual({
      type: "template",
      relativePath: path.join("Workspaces", "vercel-agent", "auth-fix"),
      branch: "agent/auth-fix",
      repoPreview: ["front", "api"],
    });
  });

  it("uses the global branch prefix for a template without its own", async () => {
    await createSourcesFixture();
    await createTemplate("plain", { repos: ["vercel/front"] });

    const result = await inferEntry({
      changeName: "auth-fix",
      sources: [{ kind: "template", name: "plain" }],
    });

    expect(result.branch).toBe("tomdale/auth-fix");
  });

  it("throws when a template is combined with repository sources", async () => {
    await createSourcesFixture();
    await createTemplate("vercel-agent", { repos: ["vercel/front"] });

    await expect(
      inferEntry({
        changeName: "auth-fix",
        sources: [
          { kind: "template", name: "vercel-agent" },
          { kind: "repo", token: "vercel/api" },
        ],
      }),
    ).rejects.toThrow(
      "Template sources cannot be combined with repository sources.",
    );
  });

  it("throws for an invalid change name", async () => {
    await createSourcesFixture();

    await expect(
      inferEntry({
        changeName: "../escape",
        sources: [{ kind: "repo", token: "vercel/front" }],
      }),
    ).rejects.toThrow("Name");
  });

  it("throws when no sources are provided", async () => {
    await createSourcesFixture();

    await expect(
      inferEntry({ changeName: "lonely", sources: [] }),
    ).rejects.toThrow("No repositories specified.");
  });
});

async function createSourcesFixture(): Promise<{
  baseDir: string;
  cacheDir: string;
}> {
  const configDir = await createTempDir("workforest-sources-config-");
  const xdgConfigHome = await createTempDir("workforest-sources-xdg-");
  const cacheDir = await createTempDir("workforest-sources-cache-");
  const baseDir = await createTempDir("workforest-sources-base-");
  process.env["WORKFOREST_CONFIG_DIR"] = configDir;
  process.env["XDG_CONFIG_HOME"] = xdgConfigHome;
  process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
  await saveWorkspaceConfig(path.join(configDir, "config.json"), {
    directory: { base: baseDir },
    branchPrefix: "tomdale",
  });
  return { baseDir, cacheDir };
}

async function createCachedMirror(
  cacheDir: string,
  directoryName: string,
  remote: string,
): Promise<void> {
  const mirrorDir = path.join(cacheDir, directoryName);
  await mkdir(mirrorDir, { recursive: true });
  await execFileAsync("git", ["init", "--bare", "--quiet"], { cwd: mirrorDir });
  await execFileAsync("git", ["remote", "add", "origin", remote], {
    cwd: mirrorDir,
  });
  await execFileAsync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: mirrorDir,
  });
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
