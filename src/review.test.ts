import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  runGitMock,
  runCommandMock,
  ensureMirrorRepoGeneratorMock,
  runSingleRepoInitializersGeneratorMock,
} = vi.hoisted(() => ({
  runGitMock: vi.fn(),
  runCommandMock: vi.fn(),
  ensureMirrorRepoGeneratorMock: vi.fn(),
  runSingleRepoInitializersGeneratorMock: vi.fn(),
}));

const ORIGINAL_CACHE_DIR = process.env["WORKFOREST_CACHE_DIR"];
const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function importReviewWithMocks(): Promise<typeof import("./review.ts")> {
  vi.doMock("./services/git.ts", () => ({
    runGit: runGitMock,
  }));
  vi.doMock("./utils/exec.ts", () => ({
    runCommand: runCommandMock,
  }));
  vi.doMock("./workspace/repository.ts", () => ({
    ensureMirrorRepoGenerator: ensureMirrorRepoGeneratorMock,
  }));
  vi.doMock("./services/initializers/index.ts", () => ({
    runSingleRepoInitializersGenerator: runSingleRepoInitializersGeneratorMock,
  }));

  return import("./review.ts");
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unmock("./services/git.ts");
  vi.unmock("./utils/exec.ts");
  vi.unmock("./workspace/repository.ts");
  vi.unmock("./services/initializers/index.ts");
  runGitMock.mockReset();
  runCommandMock.mockReset();
  ensureMirrorRepoGeneratorMock.mockReset();
  runSingleRepoInitializersGeneratorMock.mockReset();

  if (ORIGINAL_CACHE_DIR === undefined) {
    delete process.env["WORKFOREST_CACHE_DIR"];
  } else {
    process.env["WORKFOREST_CACHE_DIR"] = ORIGINAL_CACHE_DIR;
  }

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("parseReviewTarget", () => {
  it.each([
    [
      ["vercel/omniagent", "123"],
      { owner: "vercel", repo: "omniagent", prNumber: 123 },
    ],
    [
      ["vercel/omniagent", "#123"],
      { owner: "vercel", repo: "omniagent", prNumber: 123 },
    ],
    [
      ["vercel/omniagent#123"],
      { owner: "vercel", repo: "omniagent", prNumber: 123 },
    ],
    [
      ["https://github.com/vercel/omniagent/pull/123"],
      { owner: "vercel", repo: "omniagent", prNumber: 123 },
    ],
    [
      ["github.com/vercel/omniagent/pull/123"],
      { owner: "vercel", repo: "omniagent", prNumber: 123 },
    ],
  ])("parses %j", async (args, expected) => {
    const { parseReviewTarget } = await import("./review.ts");
    expect(parseReviewTarget(args)).toEqual(expected);
  });

  it.each([
    [[]],
    [["vercel/omniagent"]],
    [["vercel/omniagent", "0"]],
    [["vercel/omniagent", "-1"]],
    [["vercel/omniagent", "abc"]],
    [["vercel/omniagent", "123", "extra"]],
    [["https://example.com/vercel/omniagent/pull/123"]],
    [["https://github.com/vercel/omniagent/issues/123"]],
    [["vercel/not ok", "123"]],
    [["./omniagent", "123"]],
    [["../omniagent", "123"]],
    [["vercel/.", "123"]],
    [["vercel/..", "123"]],
    [["vercel\\omniagent", "123"]],
  ])("rejects invalid target %j", async (args) => {
    const { parseReviewTarget } = await import("./review.ts");
    expect(() => parseReviewTarget(args)).toThrow();
  });
});

describe("parseReviewRepoTarget", () => {
  it("parses a repository slug", async () => {
    const { parseReviewRepoTarget } = await import("./review.ts");
    expect(parseReviewRepoTarget(["vercel/omniagent"])).toEqual({
      owner: "vercel",
      repo: "omniagent",
    });
  });

  it.each([
    [[]],
    [["vercel/omniagent", "123"]],
    [["vercel/omniagent#123"]],
  ])("rejects invalid repo target %j", async (args) => {
    const { parseReviewRepoTarget } = await import("./review.ts");
    expect(() => parseReviewRepoTarget(args)).toThrow();
  });
});

describe("resolveReviewTarget", () => {
  it.each([
    [["123"]],
    [["#123"]],
  ])("infers the repo for numeric target %j", async (args) => {
    const { resolveReviewTarget } = await import("./review.ts");
    expect(
      resolveReviewTarget(args, { owner: "vercel", repo: "omniagent" }),
    ).toEqual({ owner: "vercel", repo: "omniagent", prNumber: 123 });
  });

  it("rejects numeric-only targets without a review workspace context", async () => {
    const { resolveReviewTarget } = await import("./review.ts");
    expect(() => resolveReviewTarget(["123"])).toThrow();
  });
});

describe("review worktrees", () => {
  it("creates a repo review workspace when no pull request is specified", async () => {
    const reviewsRoot = await createTempDir("workforest-reviews-");
    const cacheDir = await createTempDir("workforest-cache-");
    process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
    await mkdir(path.join(cacheDir, "omniagent.git"), { recursive: true });

    ensureMirrorRepoGeneratorMock.mockImplementation(async function* () {});
    runSingleRepoInitializersGeneratorMock.mockImplementation(
      async function* () {
        yield { phase: "complete" };
      },
    );
    runGitMock.mockImplementation(async (args: string[]) => {
      if (args[0] === "symbolic-ref")
        return { stdout: "refs/heads/main\n", stderr: "" };
      if (args[0] === "for-each-ref")
        return { stdout: "refs/remotes/origin/main\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });

    const { ensureReviewWorkspace } = await importReviewWithMocks();
    const result = await ensureReviewWorkspace({
      reviewsRoot,
      target: { owner: "vercel", repo: "omniagent" },
    });

    const workspaceDir = path.join(reviewsRoot, "omniagent");
    const repoDir = path.join(workspaceDir, "omniagent");
    expect(runGitMock).toHaveBeenCalledWith(
      ["worktree", "add", "--detach", repoDir, "origin/main"],
      { cwd: path.join(cacheDir, "omniagent.git") },
    );
    expect(runSingleRepoInitializersGeneratorMock).toHaveBeenCalledWith({
      context: {
        repo: {
          name: "omniagent",
          remote: "git@github.com:vercel/omniagent.git",
          defaultBranch: "main",
        },
        repoDir,
        workspaceDir,
      },
    });
    expect(result.path).toBe(workspaceDir);
    expect(result.repoDir).toBe(repoDir);

    const metadata = JSON.parse(
      await readFile(
        path.join(workspaceDir, ".workforest", "workspace.json"),
        "utf8",
      ),
    ) as {
      workspace: { type?: string; review?: { owner: string; repo: string } };
    };
    expect(metadata.workspace).toMatchObject({
      type: "review",
      review: { owner: "vercel", repo: "omniagent" },
    });
  });

  it("creates a detached worktree and checks out the pull request", async () => {
    const reviewsRoot = await createTempDir("workforest-reviews-");
    const cacheDir = await createTempDir("workforest-cache-");
    process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
    await mkdir(path.join(cacheDir, "omniagent.git"), { recursive: true });

    ensureMirrorRepoGeneratorMock.mockImplementation(async function* () {});
    runSingleRepoInitializersGeneratorMock.mockImplementation(
      async function* () {
        yield { phase: "complete" };
      },
    );
    runGitMock.mockImplementation(async (args: string[]) => {
      if (args[0] === "symbolic-ref")
        return { stdout: "refs/heads/main\n", stderr: "" };
      if (args[0] === "for-each-ref")
        return { stdout: "refs/remotes/origin/main\n", stderr: "" };
      if (args[0] === "branch") return { stdout: "pull/123\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    runCommandMock.mockResolvedValue({ stdout: "", stderr: "" });

    const { createReviewWorktree } = await importReviewWithMocks();
    const events: import("./services/events.ts").ServiceEvent[] = [];
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const result = await createReviewWorktree({
      reviewsRoot,
      target: { owner: "vercel", repo: "omniagent", prNumber: 123 },
      onEvent: (event) => events.push(event),
    });

    const targetDir = path.join(reviewsRoot, "omniagent", "pr-123");
    expect(runGitMock).toHaveBeenCalledWith(
      ["worktree", "add", "--detach", targetDir, "origin/main"],
      { cwd: path.join(cacheDir, "omniagent.git") },
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "gh",
      ["pr", "checkout", "123"],
      expect.objectContaining({ cwd: targetDir }),
    );
    const checkoutOptions = runCommandMock.mock.calls[0]?.[2];
    checkoutOptions?.onStdout?.("checkout output\n");
    checkoutOptions?.onStderr?.("checkout warning\n");
    expect(events).toContainEqual({
      type: "output",
      stream: "stdout",
      data: "checkout output\n",
    });
    expect(events).toContainEqual({
      type: "output",
      stream: "stderr",
      data: "checkout warning\n",
    });
    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
    expect(runSingleRepoInitializersGeneratorMock).toHaveBeenCalledWith({
      context: {
        repo: {
          name: "omniagent",
          remote: "git@github.com:vercel/omniagent.git",
          defaultBranch: "main",
        },
        repoDir: targetDir,
        workspaceDir: path.join(reviewsRoot, "omniagent"),
      },
    });
    expect(result.path).toBe(targetDir);
    expect(result.branch).toBe("pull/123");

    const workspaceMetadata = JSON.parse(
      await readFile(
        path.join(reviewsRoot, "omniagent", ".workforest", "workspace.json"),
        "utf8",
      ),
    ) as {
      workspace: { type: string; review: { owner: string; repo: string } };
      review_worktrees: { pr_number: number; path: string }[];
    };
    expect(workspaceMetadata.workspace).toMatchObject({
      type: "review",
      review: { owner: "vercel", repo: "omniagent" },
    });
    expect(workspaceMetadata.review_worktrees).toMatchObject([
      { pr_number: 123, path: "pr-123" },
    ]);
    await expect(
      readFile(
        path.join(
          reviewsRoot,
          "omniagent",
          ".workforest-reviews",
          "pr-123.json",
        ),
        "utf8",
      ),
    ).rejects.toThrow();
  });

  it("removes the created worktree if gh checkout fails", async () => {
    const reviewsRoot = await createTempDir("workforest-reviews-");
    const cacheDir = await createTempDir("workforest-cache-");
    process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
    await mkdir(path.join(cacheDir, "omniagent.git"), { recursive: true });

    ensureMirrorRepoGeneratorMock.mockImplementation(async function* () {});
    runSingleRepoInitializersGeneratorMock.mockImplementation(
      async function* () {
        yield { phase: "complete" };
      },
    );
    runGitMock.mockImplementation(async (args: string[]) => {
      if (args[0] === "symbolic-ref")
        return { stdout: "refs/heads/main\n", stderr: "" };
      if (args[0] === "for-each-ref")
        return { stdout: "refs/remotes/origin/main\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    runCommandMock.mockRejectedValue(new Error("checkout failed"));

    const { createReviewWorktree } = await importReviewWithMocks();
    await expect(
      createReviewWorktree({
        reviewsRoot,
        target: { owner: "vercel", repo: "omniagent", prNumber: 123 },
      }),
    ).rejects.toThrow("checkout failed");

    expect(runGitMock).toHaveBeenCalledWith(
      [
        "worktree",
        "remove",
        "--force",
        path.join(reviewsRoot, "omniagent", "pr-123"),
      ],
      { cwd: path.join(cacheDir, "omniagent.git"), timeout: 30_000 },
    );
  });

  it("preserves the checkout failure when cleanup also fails", async () => {
    const reviewsRoot = await createTempDir("workforest-reviews-");
    const cacheDir = await createTempDir("workforest-cache-");
    process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
    await mkdir(path.join(cacheDir, "omniagent.git"), { recursive: true });

    ensureMirrorRepoGeneratorMock.mockImplementation(async function* () {});
    runSingleRepoInitializersGeneratorMock.mockImplementation(
      async function* () {
        yield { phase: "complete" };
      },
    );
    runGitMock.mockImplementation(async (args: string[]) => {
      if (args[0] === "symbolic-ref") {
        return { stdout: "refs/heads/main\n", stderr: "" };
      }
      if (args[0] === "for-each-ref") {
        return { stdout: "refs/remotes/origin/main\n", stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        throw new Error("cleanup failed");
      }
      return { stdout: "", stderr: "" };
    });
    runCommandMock.mockRejectedValue(new Error("checkout failed"));

    const { createReviewWorktree } = await importReviewWithMocks();
    await expect(
      createReviewWorktree({
        reviewsRoot,
        target: { owner: "vercel", repo: "omniagent", prNumber: 123 },
      }),
    ).rejects.toThrow("checkout failed");
  });

  it("refuses to remove dirty review worktrees unless forced", async () => {
    const reviewsRoot = await createTempDir("workforest-reviews-");
    const cacheDir = await createTempDir("workforest-cache-");
    process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
    const targetDir = path.join(reviewsRoot, "omniagent", "pr-123");
    await mkdir(targetDir, { recursive: true });
    await mkdir(path.join(reviewsRoot, "omniagent", ".workforest-reviews"), {
      recursive: true,
    });

    runGitMock.mockImplementation(async (args: string[]) => {
      if (args[0] === "branch" && args[1] === "--show-current") {
        return { stdout: "pull/123\n", stderr: "" };
      }
      if (args[0] === "status") return { stdout: " M file.ts\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });

    const { removeReviewWorktree } = await importReviewWithMocks();
    await expect(
      removeReviewWorktree({
        reviewsRoot,
        target: { owner: "vercel", repo: "omniagent", prNumber: 123 },
      }),
    ).rejects.toThrow("has uncommitted changes");
  });
});
