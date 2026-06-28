import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  writeWorkspaceMetadata,
  writeWorktreeMetadata,
} from "../workspace/metadata.ts";
import {
  type Candidate,
  candidateInScope,
  cdToEntry,
  dirtyHintFor,
  filterCandidates,
  listCandidates,
  type Scope,
} from "./entries-data.ts";

const execFileAsync = promisify(execFile);
const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const ORIGINAL_CD_PATH = process.env["WORKFOREST_CD_PATH_FILE"];
const tempDirs: string[] = [];

afterEach(async () => {
  restoreEnv("WORKFOREST_CONFIG_DIR", ORIGINAL_CONFIG_DIR);
  restoreEnv("WORKFOREST_CD_PATH_FILE", ORIGINAL_CD_PATH);
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("listCandidates", () => {
  it("flattens workspaces and repositories sorted by most-recently modified", async () => {
    const { baseDir } = await createInventoryFixture();

    // Pin each change directory's mtime well past its children (so the
    // aggregate newest-mtime is deterministic) and at known deltas before a
    // fixed `now`, so both the descending order and the relative-time hints
    // are deterministic. `now` is 10 days ahead of the real clock, keeping the
    // pinned mtimes newer than the just-created child files.
    const now = (Date.now() / 1000 + 10 * 86_400) * 1000;
    const nowSec = now / 1000;
    await utimes(
      path.join(baseDir, "Repos", "workforest", "cli-redesign"),
      nowSec - 300, // 5m ago — newest
      nowSec - 300,
    );
    await utimes(
      path.join(baseDir, "Workspaces", "_adhoc", "billing"),
      nowSec - 7_200, // 2h ago
      nowSec - 7_200,
    );
    await utimes(
      path.join(baseDir, "Workspaces", "vercel-agent", "auth-fix"),
      nowSec - 259_200, // 3d ago — oldest
      nowSec - 259_200,
    );

    const candidates = await listCandidates(now);
    const bySelector = new Map(candidates.map((c) => [c.selector, c]));

    expect(bySelector.get("vercel-agent/auth-fix")).toMatchObject({
      kind: "workspace",
      changeName: "auth-fix",
      // Template-backed workspace: shows the @template with its repos in parens.
      statusHint: "3d ago · @vercel-agent (agents, api)",
      path: path.join(baseDir, "Workspaces", "vercel-agent", "auth-fix"),
    });
    expect(bySelector.get("_adhoc/billing")).toMatchObject({
      kind: "workspace",
      statusHint: "2h ago · front, api",
    });
    expect(bySelector.get("workforest/cli-redesign")).toMatchObject({
      kind: "repository",
      changeName: "cli-redesign",
      statusHint: "5m ago · workforest",
    });

    expect(candidates.map((c) => c.selector)).toEqual([
      "workforest/cli-redesign",
      "_adhoc/billing",
      "vercel-agent/auth-fix",
    ]);
  });

  it("returns an empty list when there are no changes", async () => {
    await createConfigFixture();
    expect(await listCandidates()).toEqual([]);
  });
});

describe("filterCandidates", () => {
  const candidates: Candidate[] = [
    candidate("vercel-agent/auth-fix", "auth-fix", "workspace"),
    candidate("_adhoc/billing", "billing", "workspace"),
    candidate("workforest/cli-redesign", "cli-redesign", "repository"),
  ];

  it("returns all candidates for an empty query", () => {
    expect(filterCandidates(candidates, "  ")).toEqual(candidates);
  });

  it("matches case-insensitive subsequences and preserves order", () => {
    const matches = filterCandidates(candidates, "AUF");
    expect(matches.map((c) => c.selector)).toEqual(["vercel-agent/auth-fix"]);
  });

  it("matches against the selector path too", () => {
    const matches = filterCandidates(candidates, "workforest");
    expect(matches.map((c) => c.selector)).toEqual(["workforest/cli-redesign"]);
  });
});

describe("candidateInScope", () => {
  const repoChange = candidate("front/login", "login", "repository");
  const otherRepoChange = candidate("api/limit", "limit", "repository");
  const templateChange = candidate("agent/auth", "auth", "workspace");
  const adhocChange = candidate("_adhoc/billing", "billing", "workspace");

  it("matches repository changes under a repo scope", () => {
    const scope: Scope = { kind: "repo", name: "front" };
    expect(candidateInScope(repoChange, scope)).toBe(true);
    expect(candidateInScope(otherRepoChange, scope)).toBe(false);
    // A workspace change never belongs to a repo scope, even by name.
    expect(candidateInScope(templateChange, scope)).toBe(false);
  });

  it("matches workspace changes under a template scope", () => {
    const scope: Scope = { kind: "template", name: "agent" };
    expect(candidateInScope(templateChange, scope)).toBe(true);
    expect(candidateInScope(adhocChange, scope)).toBe(false);
    expect(candidateInScope(repoChange, scope)).toBe(false);
  });

  it("matches the adhoc group under an adhoc scope", () => {
    const scope: Scope = { kind: "adhoc", name: "_adhoc" };
    expect(candidateInScope(adhocChange, scope)).toBe(true);
    expect(candidateInScope(templateChange, scope)).toBe(false);
  });
});

describe("cdToEntry", () => {
  it("writes the change directory to the shell handoff file", async () => {
    const dir = await createTempDir("workforest-cd-");
    const cdFile = path.join(dir, "cd-target");
    process.env["WORKFOREST_CD_PATH_FILE"] = cdFile;

    await cdToEntry(candidate("workforest/x", "x", "repository", "/tmp/x"));

    expect((await readFile(cdFile, "utf8")).trim()).toBe(
      path.resolve("/tmp/x"),
    );
  });
});

describe("dirtyHintFor", () => {
  it("reports the dirty file count and null when clean", async () => {
    const repo = await createTempDir("workforest-dirty-");
    await execFileAsync("git", ["init", "--quiet"], { cwd: repo });
    expect(await dirtyHintFor(repo)).toBeNull();

    await writeFile(path.join(repo, "a.txt"), "x\n", "utf8");
    await writeFile(path.join(repo, "b.txt"), "y\n", "utf8");
    expect(await dirtyHintFor(repo)).toBe("2 dirty");
  });

  it("returns null when the path is not a git repository", async () => {
    const dir = await createTempDir("workforest-nogit-");
    expect(await dirtyHintFor(dir)).toBeNull();
  });
});

function candidate(
  selector: string,
  changeName: string,
  kind: Candidate["kind"],
  candidatePath = `/tmp/${changeName}`,
): Candidate {
  return {
    selector,
    changeName,
    kind,
    groupName: selector.split("/")[0] ?? selector,
    statusHint: "ready",
    path: candidatePath,
  };
}

async function createConfigFixture(): Promise<{ baseDir: string }> {
  const configDir = await createTempDir("workforest-changes-config-");
  const baseDir = await createTempDir("workforest-changes-base-");
  process.env["WORKFOREST_CONFIG_DIR"] = configDir;
  await writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ directory: { base: baseDir } }),
    "utf8",
  );
  return { baseDir };
}

async function createInventoryFixture(): Promise<{ baseDir: string }> {
  const { baseDir } = await createConfigFixture();
  const templateWorkspace = path.join(
    baseDir,
    "Workspaces",
    "vercel-agent",
    "auth-fix",
  );
  const adhocWorkspace = path.join(baseDir, "Workspaces", "_adhoc", "billing");
  const repoChange = path.join(baseDir, "Repos", "workforest", "cli-redesign");

  await Promise.all([
    createGitRepo(path.join(templateWorkspace, "agents")),
    createGitRepo(path.join(templateWorkspace, "api")),
    createGitRepo(path.join(adhocWorkspace, "front")),
    createGitRepo(path.join(adhocWorkspace, "api")),
    createGitRepo(repoChange),
  ]);

  await writeWorkspaceMetadata(templateWorkspace, {
    featureName: "auth-fix",
    templateId: "vercel-agent",
    repos: [
      metadataRepo("agents", "git@github.com:vercel/agents.git"),
      metadataRepo("api", "git@github.com:vercel/api.git"),
    ],
  });
  await writeWorkspaceMetadata(adhocWorkspace, {
    featureName: "billing",
    repos: [
      metadataRepo("front", "git@github.com:vercel/front.git"),
      metadataRepo("api", "git@github.com:vercel/api.git"),
    ],
  });
  await writeWorktreeMetadata(path.dirname(repoChange), {
    featureName: "cli-redesign",
    branchName: "tomdale/cli-redesign",
    repos: [
      metadataRepo("workforest", "git@github.com:tomdale/workforest.git"),
    ],
  });

  return { baseDir };
}

function metadataRepo(name: string, remote: string) {
  return { name, remote, defaultBranch: "main", hasLockfile: false };
}

async function createGitRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await execFileAsync("git", ["init", "--quiet"], { cwd: dir });
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
