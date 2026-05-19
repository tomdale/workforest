import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runGitMock, runCommandMock, ensureMirrorRepoGeneratorMock } =
  vi.hoisted(() => ({
    runGitMock: vi.fn(),
    runCommandMock: vi.fn(),
    ensureMirrorRepoGeneratorMock: vi.fn(),
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

  return import("./review.ts");
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unmock("./services/git.ts");
  vi.unmock("./utils/exec.ts");
  vi.unmock("./workspace/repository.ts");
  runGitMock.mockReset();
  runCommandMock.mockReset();
  ensureMirrorRepoGeneratorMock.mockReset();

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
  ])("rejects invalid target %j", async (args) => {
    const { parseReviewTarget } = await import("./review.ts");
    expect(() => parseReviewTarget(args)).toThrow();
  });
});

describe("review worktrees", () => {
  it("creates a detached worktree and checks out the pull request", async () => {
    const reviewsDir = await createTempDir("workforest-reviews-");
    const cacheDir = await createTempDir("workforest-cache-");
    process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
    await mkdir(path.join(cacheDir, "omniagent.git"), { recursive: true });

    ensureMirrorRepoGeneratorMock.mockImplementation(async function* () {});
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
    const result = await createReviewWorktree({
      reviewsDir,
      target: { owner: "vercel", repo: "omniagent", prNumber: 123 },
    });

    const targetDir = path.join(reviewsDir, "omniagent", "pr-123");
    expect(runGitMock).toHaveBeenCalledWith(
      ["worktree", "add", "--detach", targetDir, "origin/main"],
      { cwd: path.join(cacheDir, "omniagent.git") },
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      "gh",
      ["pr", "checkout", "123"],
      expect.objectContaining({ cwd: targetDir }),
    );
    expect(result.path).toBe(targetDir);
    expect(result.branch).toBe("pull/123");

    const metadata = JSON.parse(
      await readFile(
        path.join(
          reviewsDir,
          "omniagent",
          ".workforest-reviews",
          "pr-123.json",
        ),
        "utf8",
      ),
    ) as { prNumber: number; path: string };
    expect(metadata.prNumber).toBe(123);
    expect(metadata.path).toBe(targetDir);
  });

  it("removes the created worktree if gh checkout fails", async () => {
    const reviewsDir = await createTempDir("workforest-reviews-");
    const cacheDir = await createTempDir("workforest-cache-");
    process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
    await mkdir(path.join(cacheDir, "omniagent.git"), { recursive: true });

    ensureMirrorRepoGeneratorMock.mockImplementation(async function* () {});
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
        reviewsDir,
        target: { owner: "vercel", repo: "omniagent", prNumber: 123 },
      }),
    ).rejects.toThrow("checkout failed");

    expect(runGitMock).toHaveBeenCalledWith(
      [
        "worktree",
        "remove",
        "--force",
        path.join(reviewsDir, "omniagent", "pr-123"),
      ],
      { cwd: path.join(cacheDir, "omniagent.git"), timeout: 30_000 },
    );
  });

  it("refuses to remove dirty review worktrees unless forced", async () => {
    const reviewsDir = await createTempDir("workforest-reviews-");
    const cacheDir = await createTempDir("workforest-cache-");
    process.env["WORKFOREST_CACHE_DIR"] = cacheDir;
    const targetDir = path.join(reviewsDir, "omniagent", "pr-123");
    await mkdir(targetDir, { recursive: true });
    await mkdir(path.join(reviewsDir, "omniagent", ".workforest-reviews"), {
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
        reviewsDir,
        target: { owner: "vercel", repo: "omniagent", prNumber: 123 },
      }),
    ).rejects.toThrow("has uncommitted changes");
  });
});
