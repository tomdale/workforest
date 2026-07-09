import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveWorkspaceConfig } from "./config.ts";
import { WORKFOREST_CD_PATH_ENV } from "./shell.ts";

const {
  ensureReviewWorkspaceMock,
  createReviewWorktreeMock,
  listReviewWorktreesMock,
  removeReviewWorktreeMock,
  promptTextMock,
  promptConfirmMock,
  isInteractiveMock,
} = vi.hoisted(() => ({
  ensureReviewWorkspaceMock: vi.fn(),
  createReviewWorktreeMock: vi.fn(),
  listReviewWorktreesMock: vi.fn(),
  removeReviewWorktreeMock: vi.fn(),
  promptTextMock: vi.fn(),
  promptConfirmMock: vi.fn(),
  isInteractiveMock: vi.fn(),
}));

const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const ORIGINAL_CACHE_DIR = process.env["WORKFOREST_CACHE_DIR"];
const ORIGINAL_CD_PATH_FILE = process.env[WORKFOREST_CD_PATH_ENV];
const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_EXIT_CODE = process.exitCode;
const ORIGINAL_CWD = process.cwd();
const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

function reviewWorktreeResult(
  metadata: {
    owner: string;
    repo: string;
    prNumber: number;
    path: string;
    created_at: string;
  },
  reused = false,
): { metadata: typeof metadata; reused: boolean; outcome: "background" } {
  return { metadata, reused, outcome: "background" };
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createCachedMirror(
  cacheDir: string,
  directoryName: string,
  remote: string,
): Promise<void> {
  const mirrorDir = path.join(cacheDir, directoryName);
  await mkdir(mirrorDir, { recursive: true });
  await execFileAsync("git", ["init", "--bare", "--quiet"], {
    cwd: mirrorDir,
  });
  await execFileAsync("git", ["remote", "add", "origin", remote], {
    cwd: mirrorDir,
  });
}

async function importCliWithReviewMock(): Promise<typeof import("./cli.ts")> {
  vi.doMock("./review.ts", async () => {
    const actual =
      await vi.importActual<typeof import("./review.ts")>("./review.ts");
    return {
      ...actual,
      createReviewWorktree: createReviewWorktreeMock,
      ensureReviewWorkspace: ensureReviewWorkspaceMock,
      listReviewWorktrees: listReviewWorktreesMock,
      removeReviewWorktree: removeReviewWorktreeMock,
    };
  });
  vi.doMock("./ui/prompts/index.ts", async () => {
    const actual = await vi.importActual<
      typeof import("./ui/prompts/index.ts")
    >("./ui/prompts/index.ts");
    return {
      ...actual,
      isInteractive: isInteractiveMock,
      promptConfirm: promptConfirmMock,
      promptText: promptTextMock,
    };
  });

  return import("./cli.ts");
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unmock("./review.ts");
  vi.unmock("./ui/prompts/index.ts");
  ensureReviewWorkspaceMock.mockReset();
  createReviewWorktreeMock.mockReset();
  listReviewWorktreesMock.mockReset();
  removeReviewWorktreeMock.mockReset();
  promptTextMock.mockReset();
  promptConfirmMock.mockReset();
  isInteractiveMock.mockReset();

  if (ORIGINAL_CONFIG_DIR === undefined) {
    delete process.env["WORKFOREST_CONFIG_DIR"];
  } else {
    process.env["WORKFOREST_CONFIG_DIR"] = ORIGINAL_CONFIG_DIR;
  }
  if (ORIGINAL_CACHE_DIR === undefined) {
    delete process.env["WORKFOREST_CACHE_DIR"];
  } else {
    process.env["WORKFOREST_CACHE_DIR"] = ORIGINAL_CACHE_DIR;
  }

  if (ORIGINAL_CD_PATH_FILE === undefined) {
    delete process.env[WORKFOREST_CD_PATH_ENV];
  } else {
    process.env[WORKFOREST_CD_PATH_ENV] = ORIGINAL_CD_PATH_FILE;
  }

  process.argv = [...ORIGINAL_ARGV];
  process.exitCode = ORIGINAL_EXIT_CODE;
  process.chdir(ORIGINAL_CWD);

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("wf review", () => {
  it("requires a target", async () => {
    const { executeCli } = await importCliWithReviewMock();

    const result = await executeCli(["review"]);

    expect(result).toMatchObject({
      exitCode: 2,
      render: {
        kind: "text",
        stream: "stderr",
      },
    });
    if (result.render.kind !== "text") return;
    expect(result.render.value).toContain("Expected 1-2 review targets");
    expect(ensureReviewWorkspaceMock).not.toHaveBeenCalled();
    expect(createReviewWorktreeMock).not.toHaveBeenCalled();
  });

  it.each([
    [["review", "open"], "Accepted forms: wf review <owner>/<repo>"],
    [["review", "vercel/omniagent#123", "--bogus"], 'Unknown flag "--bogus"'],
  ])("returns a stack-free usage error for %j", async (argv, expectedMessage) => {
    const { executeCli } = await importCliWithReviewMock();
    process.env["WORKFOREST_CACHE_DIR"] =
      await createTempDir("workforest-cache-");
    process.exitCode = 1;

    const result = await executeCli(argv);

    expect(result).toMatchObject({
      exitCode: 2,
      render: {
        kind: "text",
        stream: "stderr",
      },
    });
    if (result.render.kind !== "text") return;
    expect(result.render.value).toContain(expectedMessage);
    expect(result.render.value).not.toContain("\n    at ");
    expect(process.exitCode).toBe(1);
    expect(ensureReviewWorkspaceMock).not.toHaveBeenCalled();
    expect(createReviewWorktreeMock).not.toHaveBeenCalled();
    expect(listReviewWorktreesMock).not.toHaveBeenCalled();
    expect(removeReviewWorktreeMock).not.toHaveBeenCalled();
  });

  it("infers the owner for a cached repository name", async () => {
    const configDir = await createTempDir("workforest-config-");
    const cacheDir = await createTempDir("workforest-cache-");
    const reviewsRoot = await createTempDir("workforest-reviews-");
    const workspaceDir = path.join(reviewsRoot, "omniagent");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      directory: { reviews: reviewsRoot },
    });
    await createCachedMirror(
      cacheDir,
      "omniagent.git",
      "git@github.com:vercel/omniagent.git",
    );
    ensureReviewWorkspaceMock.mockResolvedValue({
      owner: "vercel",
      repo: "omniagent",
      path: workspaceDir,
      outcome: "background",
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    const { cli } = await importCliWithReviewMock();
    process.argv = ["node", "wf", "review", "omniagent"];
    process.exitCode = undefined;

    await cli();

    expect(ensureReviewWorkspaceMock).toHaveBeenCalledWith({
      reviewsRoot,
      target: { owner: "vercel", repo: "omniagent" },
      onEvent: expect.any(Function),
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("creates review workspace metadata and writes the shell cd target when no PR is specified", async () => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsRoot = await createTempDir("workforest-reviews-");
    const cdDir = await createTempDir("workforest-cd-");
    const workspaceDir = path.join(reviewsRoot, "omniagent");
    const cdPathFile = path.join(cdDir, "target");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    process.env[WORKFOREST_CD_PATH_ENV] = cdPathFile;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      directory: { reviews: reviewsRoot },
    });
    ensureReviewWorkspaceMock.mockResolvedValue({
      owner: "vercel",
      repo: "omniagent",
      path: workspaceDir,
      outcome: "background",
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    const { cli } = await importCliWithReviewMock();
    process.argv = ["node", "wf", "review", "vercel/omniagent"];
    process.exitCode = undefined;

    await cli();

    expect(ensureReviewWorkspaceMock).toHaveBeenCalledWith({
      reviewsRoot,
      target: { owner: "vercel", repo: "omniagent" },
      onEvent: expect.any(Function),
    });
    expect(createReviewWorktreeMock).not.toHaveBeenCalled();
    await mkdir(workspaceDir, { recursive: true });
    await expect(readFile(cdPathFile, "utf8")).resolves.toBe(
      `${path.resolve(workspaceDir)}\n`,
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("returns JSON when opening a repo review workspace", async () => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsRoot = await createTempDir("workforest-reviews-");
    const workspaceDir = path.join(reviewsRoot, "omniagent");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      directory: { reviews: reviewsRoot },
    });
    ensureReviewWorkspaceMock.mockResolvedValue({
      owner: "vercel",
      repo: "omniagent",
      path: workspaceDir,
      outcome: "background",
    });

    const { executeCli } = await importCliWithReviewMock();
    const result = await executeCli(["review", "vercel/omniagent", "--json"]);

    expect(result).toMatchObject({
      exitCode: 0,
      render: {
        kind: "json",
        value: {
          target: { owner: "vercel", repo: "omniagent" },
          path: workspaceDir,
        },
      },
    });
    expect(ensureReviewWorkspaceMock).toHaveBeenCalledWith({
      reviewsRoot,
      target: { owner: "vercel", repo: "omniagent" },
      interactive: false,
    });
    expect(createReviewWorktreeMock).not.toHaveBeenCalled();
  });

  it("creates a review worktree from a split repo and PR target", async () => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsRoot = await createTempDir("workforest-reviews-");
    const cdDir = await createTempDir("workforest-cd-");
    const targetDir = path.join(reviewsRoot, "omniagent", "pr-123");
    const cdPathFile = path.join(cdDir, "target");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    process.env[WORKFOREST_CD_PATH_ENV] = cdPathFile;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      directory: { reviews: reviewsRoot },
    });
    createReviewWorktreeMock.mockResolvedValue(
      reviewWorktreeResult({
        owner: "vercel",
        repo: "omniagent",
        prNumber: 123,
        path: targetDir,
        created_at: new Date().toISOString(),
      }),
    );

    vi.spyOn(console, "log").mockImplementation(() => {});
    const { cli } = await importCliWithReviewMock();
    process.argv = ["node", "wf", "review", "vercel/omniagent", "#123"];
    process.exitCode = undefined;

    await cli();

    expect(createReviewWorktreeMock).toHaveBeenCalledWith({
      reviewsRoot,
      target: { owner: "vercel", repo: "omniagent", prNumber: 123 },
      onEvent: expect.any(Function),
    });
    await mkdir(targetDir, { recursive: true });
    await expect(readFile(cdPathFile, "utf8")).resolves.toBe(
      `${path.resolve(targetDir)}\n`,
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("reports and returns an existing review worktree", async () => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsRoot = await createTempDir("workforest-reviews-");
    const targetDir = path.join(reviewsRoot, "omniagent", "pr-123");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      directory: { reviews: reviewsRoot },
    });
    createReviewWorktreeMock.mockResolvedValue(
      reviewWorktreeResult(
        {
          owner: "vercel",
          repo: "omniagent",
          prNumber: 123,
          path: targetDir,
          created_at: new Date().toISOString(),
        },
        true,
      ),
    );

    const { executeCli } = await importCliWithReviewMock();
    const jsonResult = await executeCli([
      "review",
      "vercel/omniagent#123",
      "--json",
    ]);
    const textResult = await executeCli(["review", "vercel/omniagent#123"]);

    expect(jsonResult).toMatchObject({
      exitCode: 0,
      render: {
        kind: "json",
        value: { path: targetDir, reused: true },
      },
    });
    if (textResult.render.kind !== "text") return;
    expect(textResult.render.value).toContain(
      `Review worktree already exists; switching to: ${targetDir}`,
    );
  });

  it("returns the standard cancellation exit code for review checkout", async () => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsRoot = await createTempDir("workforest-reviews-");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      directory: { reviews: reviewsRoot },
    });
    createReviewWorktreeMock.mockResolvedValue({
      path: path.join(reviewsRoot, "omniagent", "pr-123"),
      reused: false,
      outcome: "cancelled",
    });

    const { executeCli } = await importCliWithReviewMock();
    const result = await executeCli(["review", "vercel/omniagent#123"]);

    expect(result).toEqual({ exitCode: 130, render: { kind: "none" } });
  });

  it("infers the repo for numeric review targets inside a review workspace", async () => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsRoot = await createTempDir("workforest-reviews-");
    const workspaceDir = path.join(reviewsRoot, "omniagent");
    const targetDir = path.join(workspaceDir, "pr-123");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      directory: { reviews: reviewsRoot },
    });
    const { writeWorkspaceMetadata } = await import("./workspace/metadata.ts");
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "omniagent",
      type: "review",
      review: { owner: "vercel", repo: "omniagent" },
      repos: [
        {
          name: "omniagent",
          remote: "git@github.com:vercel/omniagent.git",
          hasLockfile: false,
        },
      ],
    });
    process.chdir(workspaceDir);
    createReviewWorktreeMock.mockResolvedValue(
      reviewWorktreeResult({
        owner: "vercel",
        repo: "omniagent",
        prNumber: 123,
        path: targetDir,
        created_at: new Date().toISOString(),
      }),
    );

    vi.spyOn(console, "log").mockImplementation(() => {});
    const { cli } = await importCliWithReviewMock();
    process.argv = ["node", "wf", "review", "#123"];
    process.exitCode = undefined;

    await cli();

    expect(createReviewWorktreeMock).toHaveBeenCalledWith({
      reviewsRoot,
      target: { owner: "vercel", repo: "omniagent", prNumber: 123 },
      onEvent: expect.any(Function),
    });
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    "omniagent",
    "pr-123",
    "fix-tests",
  ])("infers numeric review targets from %s inside a review workspace", async (childDirName) => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsRoot = await createTempDir("workforest-reviews-");
    const workspaceDir = path.join(reviewsRoot, "omniagent");
    const cwd = path.join(workspaceDir, childDirName);

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await mkdir(cwd, { recursive: true });
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      directory: { reviews: reviewsRoot },
    });
    const { appendTasks, upsertReviewWorktree, writeWorkspaceMetadata } =
      await import("./workspace/metadata.ts");
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "omniagent",
      type: "review",
      review: { owner: "vercel", repo: "omniagent" },
      repos: [
        {
          name: "omniagent",
          remote: "git@github.com:vercel/omniagent.git",
          hasLockfile: false,
        },
      ],
    });
    await upsertReviewWorktree(workspaceDir, {
      pr_number: 123,
      path: "pr-123",
      branch: "pull/123",
      created_at: "2026-05-15T00:00:00.000Z",
    });
    await appendTasks(workspaceDir, [
      {
        slug: "fix-tests",
        parent_repo: "omniagent",
        path: "_tasks/omniagent/fix-tests",
        branch: "tomdale/fix-tests",
        base_branch: "pull/123",
        base_sha: "abc123",
        created_at: "2026-05-15T00:00:00.000Z",
        setup_status: "ready",
      },
    ]);
    process.chdir(cwd);
    createReviewWorktreeMock.mockResolvedValue(
      reviewWorktreeResult({
        owner: "vercel",
        repo: "omniagent",
        prNumber: 456,
        path: path.join(workspaceDir, "pr-456"),
        created_at: new Date().toISOString(),
      }),
    );

    vi.spyOn(console, "log").mockImplementation(() => {});
    const { cli } = await importCliWithReviewMock();
    process.argv = ["node", "wf", "review", "456"];
    process.exitCode = undefined;

    await cli();

    expect(createReviewWorktreeMock).toHaveBeenCalledWith({
      reviewsRoot,
      target: { owner: "vercel", repo: "omniagent", prNumber: 456 },
      onEvent: expect.any(Function),
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("uses an explicitly qualified PR target over the current review workspace", async () => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsRoot = await createTempDir("workforest-reviews-");
    const workspaceDir = path.join(reviewsRoot, "omniagent");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      directory: { reviews: reviewsRoot },
    });
    const { writeWorkspaceMetadata } = await import("./workspace/metadata.ts");
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "omniagent",
      type: "review",
      review: { owner: "vercel", repo: "omniagent" },
      repos: [
        {
          name: "omniagent",
          remote: "git@github.com:vercel/omniagent.git",
          hasLockfile: false,
        },
      ],
    });
    process.chdir(workspaceDir);
    createReviewWorktreeMock.mockResolvedValue(
      reviewWorktreeResult({
        owner: "other",
        repo: "repo",
        prNumber: 456,
        path: path.join(reviewsRoot, "repo", "pr-456"),
        created_at: new Date().toISOString(),
      }),
    );

    vi.spyOn(console, "log").mockImplementation(() => {});
    const { cli } = await importCliWithReviewMock();
    process.argv = [
      "node",
      "wf",
      "review",
      "https://github.com/other/repo/pull/456",
    ];
    process.exitCode = undefined;

    await cli();

    expect(createReviewWorktreeMock).toHaveBeenCalledWith({
      reviewsRoot,
      target: { owner: "other", repo: "repo", prNumber: 456 },
      onEvent: expect.any(Function),
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("uses configured directory.reviews", async () => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsRoot = await createTempDir("workforest-reviews-");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      directory: { reviews: reviewsRoot },
    });
    createReviewWorktreeMock.mockResolvedValue(
      reviewWorktreeResult({
        owner: "vercel",
        repo: "omniagent",
        prNumber: 123,
        path: path.join(reviewsRoot, "omniagent", "pr-123"),
        created_at: new Date().toISOString(),
      }),
    );

    vi.spyOn(console, "log").mockImplementation(() => {});
    const { cli } = await importCliWithReviewMock();
    process.argv = ["node", "wf", "review", "vercel/omniagent#123"];
    process.exitCode = undefined;

    await cli();

    expect(promptTextMock).not.toHaveBeenCalled();
    expect(createReviewWorktreeMock).toHaveBeenCalledWith({
      reviewsRoot,
      target: { owner: "vercel", repo: "omniagent", prNumber: 123 },
      onEvent: expect.any(Function),
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("uses the default review directory when unset", async () => {
    const configDir = await createTempDir("workforest-config-");
    const base = await createTempDir("workforest-code-");
    const reviewsRoot = path.join(base, "Reviews");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      directory: { base },
    });
    createReviewWorktreeMock.mockResolvedValue(
      reviewWorktreeResult({
        owner: "vercel",
        repo: "omniagent",
        prNumber: 123,
        path: path.join(reviewsRoot, "omniagent", "pr-123"),
        created_at: new Date().toISOString(),
      }),
    );

    vi.spyOn(console, "log").mockImplementation(() => {});
    const { cli } = await importCliWithReviewMock();
    process.argv = ["node", "wf", "review", "vercel/omniagent#123"];
    process.exitCode = undefined;

    await cli();

    expect(promptTextMock).not.toHaveBeenCalled();
    expect(createReviewWorktreeMock).toHaveBeenCalledWith({
      reviewsRoot,
      target: { owner: "vercel", repo: "omniagent", prNumber: 123 },
      onEvent: expect.any(Function),
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("renders review operational failures on stderr without a stack", async () => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsRoot = await createTempDir("workforest-reviews-");
    const errors: string[] = [];

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      directory: { reviews: reviewsRoot },
    });
    createReviewWorktreeMock.mockRejectedValue(new Error("checkout failed"));
    vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });

    const { cli } = await importCliWithReviewMock();
    process.argv = ["node", "wf", "review", "vercel/omniagent#123"];
    process.exitCode = undefined;

    await cli();

    expect(errors).toEqual(["checkout failed"]);
    expect(errors.join("\n")).not.toContain("\n    at ");
    expect(process.exitCode).toBe(1);
  });
});
