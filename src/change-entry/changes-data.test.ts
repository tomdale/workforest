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
  writeRepositoryChangeMetadata,
  writeWorkspaceMetadata,
} from "../workspace/metadata.ts";
import {
  type ChangeCandidate,
  cdToChange,
  dirtyHintFor,
  filterChangeCandidates,
  listChangeCandidates,
} from "./changes-data.ts";

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

describe("listChangeCandidates", () => {
  it("flattens workspaces and repositories sorted by most-recently modified", async () => {
    const { baseDir } = await createInventoryFixture();

    // Pin each change directory's mtime well past its children so the aggregate
    // newest-mtime is deterministic, then assert descending order.
    const future = Date.now() / 1000 + 86_400;
    await utimes(
      path.join(baseDir, "Workspaces", "vercel-agent", "auth-fix"),
      future + 10,
      future + 10,
    );
    await utimes(
      path.join(baseDir, "Workspaces", "_adhoc", "billing"),
      future + 20,
      future + 20,
    );
    await utimes(
      path.join(baseDir, "Repos", "workforest", "cli-redesign"),
      future + 30,
      future + 30,
    );

    const candidates = await listChangeCandidates();
    const bySelector = new Map(candidates.map((c) => [c.selector, c]));

    expect(bySelector.get("vercel-agent/auth-fix")).toMatchObject({
      kind: "workspace",
      changeName: "auth-fix",
      statusHint: "ready · agents, api",
      path: path.join(baseDir, "Workspaces", "vercel-agent", "auth-fix"),
    });
    expect(bySelector.get("_adhoc/billing")).toMatchObject({
      kind: "workspace",
      statusHint: "ready · front, api",
    });
    expect(bySelector.get("workforest/cli-redesign")).toMatchObject({
      kind: "repository",
      changeName: "cli-redesign",
      statusHint: "ready · workforest",
    });

    expect(candidates.map((c) => c.selector)).toEqual([
      "workforest/cli-redesign",
      "_adhoc/billing",
      "vercel-agent/auth-fix",
    ]);
  });

  it("returns an empty list when there are no changes", async () => {
    await createConfigFixture();
    expect(await listChangeCandidates()).toEqual([]);
  });
});

describe("filterChangeCandidates", () => {
  const candidates: ChangeCandidate[] = [
    candidate("vercel-agent/auth-fix", "auth-fix", "workspace"),
    candidate("_adhoc/billing", "billing", "workspace"),
    candidate("workforest/cli-redesign", "cli-redesign", "repository"),
  ];

  it("returns all candidates for an empty query", () => {
    expect(filterChangeCandidates(candidates, "  ")).toEqual(candidates);
  });

  it("matches case-insensitive subsequences and preserves order", () => {
    const matches = filterChangeCandidates(candidates, "AUF");
    expect(matches.map((c) => c.selector)).toEqual(["vercel-agent/auth-fix"]);
  });

  it("matches against the selector path too", () => {
    const matches = filterChangeCandidates(candidates, "workforest");
    expect(matches.map((c) => c.selector)).toEqual(["workforest/cli-redesign"]);
  });
});

describe("cdToChange", () => {
  it("writes the change directory to the shell handoff file", async () => {
    const dir = await createTempDir("workforest-cd-");
    const cdFile = path.join(dir, "cd-target");
    process.env["WORKFOREST_CD_PATH_FILE"] = cdFile;

    await cdToChange(candidate("workforest/x", "x", "repository", "/tmp/x"));

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
  kind: ChangeCandidate["kind"],
  candidatePath = `/tmp/${changeName}`,
): ChangeCandidate {
  return {
    selector,
    changeName,
    kind,
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
  await writeRepositoryChangeMetadata(path.dirname(repoChange), {
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
