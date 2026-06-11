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
  it.each([
    [["review"], "Expected 1-2 review targets"],
    [
      ["review", "vercel/omniagent", "123", "extra"],
      "Expected 1-2 review targets",
    ],
    [["review", "vercel/omniagent", "--force"], 'Unknown flag "--force"'],
    [["review", "list", "--force"], 'Unknown flag "--force"'],
    [
      ["review", "delete", "vercel/omniagent#123", "--bogus"],
      'Unknown flag "--bogus"',
    ],
    [
      ["review", "delete", "vercel/omniagent", "123", "extra"],
      "Expected 1-2 review targets",
    ],
  ])("returns a stack-free usage error for %j", async (argv, expectedMessage) => {
    const { executeCli } = await importCliWithReviewMock();
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
    const reviewsDir = await createTempDir("workforest-reviews-");
    const workspaceDir = path.join(reviewsDir, "omniagent");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      reviewsDir,
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
      repoDir: path.join(workspaceDir, "omniagent"),
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    const { cli } = await importCliWithReviewMock();
    process.argv = ["node", "wf", "review", "omniagent"];
    process.exitCode = undefined;

    await cli();

    expect(ensureReviewWorkspaceMock).toHaveBeenCalledWith({
      reviewsDir,
      target: { owner: "vercel", repo: "omniagent" },
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("creates a repo review workspace and writes the shell cd target when no PR is specified", async () => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsDir = await createTempDir("workforest-reviews-");
    const cdDir = await createTempDir("workforest-cd-");
    const workspaceDir = path.join(reviewsDir, "omniagent");
    const repoDir = path.join(workspaceDir, "omniagent");
    const cdPathFile = path.join(cdDir, "target");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    process.env[WORKFOREST_CD_PATH_ENV] = cdPathFile;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      reviewsDir,
    });
    ensureReviewWorkspaceMock.mockResolvedValue({
      owner: "vercel",
      repo: "omniagent",
      path: workspaceDir,
      repoDir,
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    const { cli } = await importCliWithReviewMock();
    process.argv = ["node", "wf", "review", "vercel/omniagent"];
    process.exitCode = undefined;

    await cli();

    expect(ensureReviewWorkspaceMock).toHaveBeenCalledWith({
      reviewsDir,
      target: { owner: "vercel", repo: "omniagent" },
    });
    expect(createReviewWorktreeMock).not.toHaveBeenCalled();
    await mkdir(workspaceDir, { recursive: true });
    await expect(readFile(cdPathFile, "utf8")).resolves.toBe(
      `${path.resolve(workspaceDir)}\n`,
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("creates a review worktree and writes the shell cd target", async () => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsDir = await createTempDir("workforest-reviews-");
    const cdDir = await createTempDir("workforest-cd-");
    const targetDir = path.join(reviewsDir, "omniagent", "pr-123");
    const cdPathFile = path.join(cdDir, "target");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    process.env[WORKFOREST_CD_PATH_ENV] = cdPathFile;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      reviewsDir,
    });
    createReviewWorktreeMock.mockResolvedValue({
      owner: "vercel",
      repo: "omniagent",
      prNumber: 123,
      path: targetDir,
      created_at: new Date().toISOString(),
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    const { cli } = await importCliWithReviewMock();
    process.argv = ["node", "wf", "review", "vercel/omniagent", "#123"];
    process.exitCode = undefined;

    await cli();

    expect(createReviewWorktreeMock).toHaveBeenCalledWith({
      reviewsDir,
      target: { owner: "vercel", repo: "omniagent", prNumber: 123 },
    });
    await mkdir(targetDir, { recursive: true });
    await expect(readFile(cdPathFile, "utf8")).resolves.toBe(
      `${path.resolve(targetDir)}\n`,
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("infers the repo for numeric review targets inside a review workspace", async () => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsDir = await createTempDir("workforest-reviews-");
    const workspaceDir = path.join(reviewsDir, "omniagent");
    const targetDir = path.join(workspaceDir, "pr-123");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      reviewsDir,
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
          defaultBranch: "main",
          hasLockfile: false,
        },
      ],
    });
    process.chdir(workspaceDir);
    createReviewWorktreeMock.mockResolvedValue({
      owner: "vercel",
      repo: "omniagent",
      prNumber: 123,
      path: targetDir,
      created_at: new Date().toISOString(),
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    const { cli } = await importCliWithReviewMock();
    process.argv = ["node", "wf", "review", "#123"];
    process.exitCode = undefined;

    await cli();

    expect(createReviewWorktreeMock).toHaveBeenCalledWith({
      reviewsDir,
      target: { owner: "vercel", repo: "omniagent", prNumber: 123 },
    });
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    "omniagent",
    "pr-123",
    "fix-tests",
  ])("infers numeric review targets from %s inside a review workspace", async (childDirName) => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsDir = await createTempDir("workforest-reviews-");
    const workspaceDir = path.join(reviewsDir, "omniagent");
    const cwd = path.join(workspaceDir, childDirName);

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await mkdir(cwd, { recursive: true });
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      reviewsDir,
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
          defaultBranch: "main",
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
        path: "fix-tests",
        branch: "tomdale/fix-tests",
        base_branch: "pull/123",
        base_sha: "abc123",
        created_at: "2026-05-15T00:00:00.000Z",
        setup_status: "ready",
      },
    ]);
    process.chdir(cwd);
    createReviewWorktreeMock.mockResolvedValue({
      owner: "vercel",
      repo: "omniagent",
      prNumber: 456,
      path: path.join(workspaceDir, "pr-456"),
      created_at: new Date().toISOString(),
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    const { cli } = await importCliWithReviewMock();
    process.argv = ["node", "wf", "review", "456"];
    process.exitCode = undefined;

    await cli();

    expect(createReviewWorktreeMock).toHaveBeenCalledWith({
      reviewsDir,
      target: { owner: "vercel", repo: "omniagent", prNumber: 456 },
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("uses an explicitly qualified PR target over the current review workspace", async () => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsDir = await createTempDir("workforest-reviews-");
    const workspaceDir = path.join(reviewsDir, "omniagent");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      reviewsDir,
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
          defaultBranch: "main",
          hasLockfile: false,
        },
      ],
    });
    process.chdir(workspaceDir);
    createReviewWorktreeMock.mockResolvedValue({
      owner: "other",
      repo: "repo",
      prNumber: 456,
      path: path.join(reviewsDir, "repo", "pr-456"),
      created_at: new Date().toISOString(),
    });

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
      reviewsDir,
      target: { owner: "other", repo: "repo", prNumber: 456 },
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("prompts for reviewsDir on first use and saves it", async () => {
    const configDir = await createTempDir("workforest-config-");
    const workspaceRoot = path.join(
      await createTempDir("workforest-code-"),
      "workspaces",
    );
    const reviewsDir = path.join(path.dirname(workspaceRoot), "reviews");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      defaultDir: workspaceRoot,
    });
    isInteractiveMock.mockReturnValue(true);
    promptTextMock.mockResolvedValue(reviewsDir);
    createReviewWorktreeMock.mockResolvedValue({
      owner: "vercel",
      repo: "omniagent",
      prNumber: 123,
      path: path.join(reviewsDir, "omniagent", "pr-123"),
      created_at: new Date().toISOString(),
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    const { cli } = await importCliWithReviewMock();
    process.argv = ["node", "wf", "review", "vercel/omniagent#123"];
    process.exitCode = undefined;

    await cli();

    expect(promptTextMock).toHaveBeenCalledWith(
      "Reviews directory",
      expect.objectContaining({ defaultValue: reviewsDir }),
    );
    const saved = JSON.parse(
      await readFile(path.join(configDir, "config.json"), "utf8"),
    ) as { reviewsDir?: string };
    expect(saved.reviewsDir).toBe(reviewsDir);
    expect(process.exitCode).toBeUndefined();
  });

  it("fails non-interactively when reviewsDir is missing", async () => {
    const configDir = await createTempDir("workforest-config-");
    const errors: string[] = [];

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {});
    isInteractiveMock.mockReturnValue(false);
    vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });

    const { cli } = await importCliWithReviewMock();
    process.argv = ["node", "wf", "review", "vercel/omniagent#123"];
    process.exitCode = undefined;

    await cli();

    expect(createReviewWorktreeMock).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("No reviewsDir configured");
    expect(process.exitCode).toBe(1);
  });

  it("routes list and delete subcommands", async () => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsDir = await createTempDir("workforest-reviews-");
    const logs: string[] = [];

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      reviewsDir,
    });
    listReviewWorktreesMock.mockResolvedValue([
      {
        owner: "vercel",
        repo: "omniagent",
        prNumber: 123,
        path: path.join(reviewsDir, "omniagent", "pr-123"),
        created_at: new Date().toISOString(),
        state: "ready",
      },
    ]);
    removeReviewWorktreeMock.mockResolvedValue({
      path: path.join(reviewsDir, "omniagent", "pr-123"),
      dryRun: true,
    });
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    const { cli } = await importCliWithReviewMock();
    process.argv = ["node", "wf", "review", "list", "omniagent"];
    process.exitCode = undefined;
    await cli();

    expect(listReviewWorktreesMock).toHaveBeenCalledWith(
      reviewsDir,
      "omniagent",
    );
    expect(logs.join("\n")).toContain("vercel/omniagent#123");

    process.argv = [
      "node",
      "wf",
      "review",
      "delete",
      "vercel/omniagent#123",
      "-n",
    ];
    process.exitCode = undefined;
    await cli();

    expect(removeReviewWorktreeMock).toHaveBeenCalledWith({
      reviewsDir,
      target: { owner: "vercel", repo: "omniagent", prNumber: 123 },
      dryRun: true,
      force: false,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    "list",
    "ls",
  ])("routes the review %s listing form through the same handler", async (subcommand) => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsDir = await createTempDir("workforest-reviews-");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      reviewsDir,
    });
    listReviewWorktreesMock.mockResolvedValue([]);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { cli } = await importCliWithReviewMock();
    process.argv = ["node", "wf", "review", subcommand, "omniagent"];
    process.exitCode = undefined;

    await cli();

    expect(listReviewWorktreesMock).toHaveBeenCalledWith(
      reviewsDir,
      "omniagent",
    );
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    "delete",
    "rm",
    "remove",
  ])("routes the review %s deletion form through the same handler", async (subcommand) => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsDir = await createTempDir("workforest-reviews-");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      reviewsDir,
    });
    removeReviewWorktreeMock.mockResolvedValue({
      path: path.join(reviewsDir, "omniagent", "pr-123"),
      dryRun: true,
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { cli } = await importCliWithReviewMock();
    process.argv = [
      "node",
      "wf",
      "review",
      subcommand,
      "vercel/omniagent#123",
      "--dry-run",
    ];
    process.exitCode = undefined;

    await cli();

    expect(removeReviewWorktreeMock).toHaveBeenCalledWith({
      reviewsDir,
      target: { owner: "vercel", repo: "omniagent", prNumber: 123 },
      dryRun: true,
      force: false,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("renders review operational failures on stderr without a stack", async () => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsDir = await createTempDir("workforest-reviews-");
    const errors: string[] = [];

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      reviewsDir,
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

  it("infers the repo for numeric review deletion inside a review workspace", async () => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsDir = await createTempDir("workforest-reviews-");
    const workspaceDir = path.join(reviewsDir, "omniagent");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      reviewsDir,
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
          defaultBranch: "main",
          hasLockfile: false,
        },
      ],
    });
    process.chdir(workspaceDir);
    removeReviewWorktreeMock.mockResolvedValue({
      path: path.join(workspaceDir, "pr-123"),
      dryRun: true,
    });

    const { cli } = await importCliWithReviewMock();
    process.argv = ["node", "wf", "review", "rm", "#123", "-n"];
    process.exitCode = undefined;
    await cli();

    expect(removeReviewWorktreeMock).toHaveBeenCalledWith({
      reviewsDir,
      target: { owner: "vercel", repo: "omniagent", prNumber: 123 },
      dryRun: true,
      force: false,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("prompts before deleting an explicit review worktree", async () => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsDir = await createTempDir("workforest-reviews-");
    const targetDir = path.join(reviewsDir, "omniagent", "pr-123");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      reviewsDir,
    });
    isInteractiveMock.mockReturnValue(true);
    promptConfirmMock.mockResolvedValue(true);
    removeReviewWorktreeMock.mockResolvedValue({
      path: targetDir,
      dryRun: false,
    });

    const { cli } = await importCliWithReviewMock();
    process.argv = ["node", "wf", "review", "delete", "vercel/omniagent#123"];
    process.exitCode = undefined;
    await cli();

    expect(promptConfirmMock).toHaveBeenCalledWith(
      `Delete review worktree "vercel/omniagent#123" at ${targetDir}?`,
      false,
    );
    expect(removeReviewWorktreeMock).toHaveBeenCalledWith({
      reviewsDir,
      target: { owner: "vercel", repo: "omniagent", prNumber: 123 },
      dryRun: false,
      force: false,
    });
  });

  it("does not delete an explicit review worktree when confirmation is declined", async () => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsDir = await createTempDir("workforest-reviews-");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      reviewsDir,
    });
    isInteractiveMock.mockReturnValue(true);
    promptConfirmMock.mockResolvedValue(false);

    const { cli } = await importCliWithReviewMock();
    process.argv = ["node", "wf", "review", "delete", "vercel/omniagent#123"];
    process.exitCode = undefined;
    await cli();

    expect(removeReviewWorktreeMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("requires --force for explicit review deletion in non-interactive mode", async () => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsDir = await createTempDir("workforest-reviews-");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      reviewsDir,
    });
    isInteractiveMock.mockReturnValue(false);

    const { cli } = await importCliWithReviewMock();
    process.argv = ["node", "wf", "review", "delete", "vercel/omniagent#123"];
    process.exitCode = undefined;
    await cli();

    expect(removeReviewWorktreeMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("skips review deletion prompts with --force", async () => {
    const configDir = await createTempDir("workforest-config-");
    const reviewsDir = await createTempDir("workforest-reviews-");
    const targetDir = path.join(reviewsDir, "omniagent", "pr-123");

    process.env["WORKFOREST_CONFIG_DIR"] = configDir;
    await saveWorkspaceConfig(path.join(configDir, "config.json"), {
      reviewsDir,
    });
    removeReviewWorktreeMock.mockResolvedValue({
      path: targetDir,
      dryRun: false,
    });

    const { cli } = await importCliWithReviewMock();
    process.argv = [
      "node",
      "wf",
      "review",
      "delete",
      "vercel/omniagent#123",
      "--force",
    ];
    process.exitCode = undefined;
    await cli();

    expect(promptConfirmMock).not.toHaveBeenCalled();
    expect(removeReviewWorktreeMock).toHaveBeenCalledWith({
      reviewsDir,
      target: { owner: "vercel", repo: "omniagent", prNumber: 123 },
      dryRun: false,
      force: true,
    });
  });
});
