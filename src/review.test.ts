import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  runGitMock,
  runCommandMock,
  ensureMirrorRepoMock,
  runSingleRepoInitializersMock,
} = vi.hoisted(() => ({
  runGitMock: vi.fn(),
  runCommandMock: vi.fn(),
  ensureMirrorRepoMock: vi.fn(),
  runSingleRepoInitializersMock: vi.fn(),
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
    createDefaultBranchResolver: () => ({
      resolveBareMirrorDefaultBranch: vi.fn(async () => "main"),
    }),
    runGit: runGitMock,
  }));
  vi.doMock("./utils/exec.ts", () => ({
    runCommand: runCommandMock,
  }));
  vi.doMock("./workspace/repository.ts", () => ({
    ensureMirrorRepo: ensureMirrorRepoMock,
  }));
  vi.doMock("./services/initializers/index.ts", () => ({
    runSingleRepoInitializers: runSingleRepoInitializersMock,
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
  ensureMirrorRepoMock.mockReset();
  runSingleRepoInitializersMock.mockReset();

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
    [
      ["git@github.com:vercel/omniagent.git", "123"],
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
    [["vercel/omniagent", "abc"]],
    [["vercel/omniagent", "123", "extra"]],
    [["https://example.com/vercel/omniagent/pull/123"]],
    [["invalid/repo name", "123"]],
  ])("rejects invalid target %j", async (args) => {
    const { parseReviewTarget } = await import("./review.ts");
    expect(() => parseReviewTarget(args)).toThrow();
  });
});

describe("parseReviewRepoTarget", () => {
  it.each([
    ["vercel/omniagent"],
    ["https://github.com/vercel/omniagent.git"],
    ["git@github.com:vercel/omniagent.git"],
    ["ssh://git@github.com/vercel/omniagent.git"],
  ])("parses repository target %s", async (input) => {
    const { parseReviewRepoTarget } = await import("./review.ts");
    expect(parseReviewRepoTarget([input])).toEqual({
      owner: "vercel",
      repo: "omniagent",
    });
  });

  it.each([
    [[]],
    [["vercel/omniagent", "123"]],
    [["https://example.com/vercel/omniagent.git"]],
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
  it("creates review workspace metadata when no pull request is specified", async () => {
    const reviewsRoot = await createTempDir("workforest-reviews-");
    const cacheDir = await createTempDir("workforest-cache-");
    process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
    await mkdir(path.join(cacheDir, "omniagent.git"), { recursive: true });

    ensureMirrorRepoMock.mockImplementation(async function* () {});
    runSingleRepoInitializersMock.mockImplementation(async function* () {
      yield { phase: "complete" };
    });
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
    expect(runGitMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(["worktree", "add"]),
      expect.anything(),
    );
    expect(runSingleRepoInitializersMock).not.toHaveBeenCalled();
    expect(result.path).toBe(workspaceDir);

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

    ensureMirrorRepoMock.mockImplementation(async function* () {});
    runSingleRepoInitializersMock.mockImplementation(async function* () {
      yield { phase: "complete" };
    });
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
      { cwd: path.join(cacheDir, "omniagent.git"), timeout: 120_000 },
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "gh",
      ["pr", "checkout", "123"],
      expect.objectContaining({ cwd: targetDir }),
    );
    // The setup now renders through the shared pipeline seam; gh's raw stdout is
    // no longer streamed as separate service-output events (progress is a grid
    // pane / inline "Checking out PR #123" line, and gh failures surface via the
    // thrown error). The command must still never write directly to the tty.
    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
    expect(runSingleRepoInitializersMock).toHaveBeenCalledWith({
      context: {
        repo: {
          name: "omniagent",
          remote: "git@github.com:vercel/omniagent.git",
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

    ensureMirrorRepoMock.mockImplementation(async function* () {});
    runSingleRepoInitializersMock.mockImplementation(async function* () {
      yield { phase: "complete" };
    });
    runGitMock.mockImplementation(async (args: string[]) => {
      if (args[0] === "symbolic-ref")
        return { stdout: "refs/heads/main\n", stderr: "" };
      if (args[0] === "for-each-ref")
        return { stdout: "refs/remotes/origin/main\n", stderr: "" };
      if (args[0] === "worktree" && args[1] === "add") {
        // Mirror real `git worktree add`: materialize the checkout with a valid
        // gitlink so the failure-cleanup removes it (a broken link would prune).
        const dir = args[3] ?? "";
        await mkdir(dir, { recursive: true });
        await writeFile(
          path.join(dir, ".git"),
          `gitdir: ${path.join(cacheDir, "omniagent.git")}\n`,
        );
        return { stdout: "", stderr: "" };
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

    ensureMirrorRepoMock.mockImplementation(async function* () {});
    runSingleRepoInitializersMock.mockImplementation(async function* () {
      yield { phase: "complete" };
    });
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
