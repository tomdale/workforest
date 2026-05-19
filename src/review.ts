import { promises as fs } from "node:fs";
import path from "node:path";
import { getCacheDir } from "./config.ts";
import { log } from "./logger.ts";
import { runGit } from "./services/git.ts";
import type { RepoConfig } from "./types.ts";
import { runCommand } from "./utils/exec.ts";
import { ensureDir, pathExists } from "./utils/fs.ts";
import { ensureMirrorRepoGenerator } from "./workspace/repository.ts";

const REVIEW_METADATA_DIR = ".workforest-reviews";

export type ReviewTarget = {
  owner: string;
  repo: string;
  prNumber: number;
};

export type ReviewMetadata = ReviewTarget & {
  path: string;
  branch?: string;
  created_at: string;
};

export type ReviewListEntry = ReviewMetadata & {
  state: "ready" | "stale";
};

export type CreateReviewWorktreeOptions = {
  target: ReviewTarget;
  reviewsDir: string;
};

export type RemoveReviewWorktreeOptions = {
  target: ReviewTarget;
  reviewsDir: string;
  dryRun?: boolean;
  force?: boolean;
};

export type RemoveReviewWorktreeResult = {
  path: string;
  branch?: string;
  dryRun: boolean;
};

export function parseReviewTarget(args: readonly string[]): ReviewTarget {
  if (args.length === 1) {
    return parseSingleTarget(args[0] ?? "");
  }

  if (args.length === 2) {
    const repo = parseRepoSlug(args[0] ?? "");
    const prNumber = parsePrNumber(args[1] ?? "");
    return { ...repo, prNumber };
  }

  throw new Error("Expected a GitHub PR URL or <owner>/<repo> <pr-number>.");
}

export async function createReviewWorktree({
  target,
  reviewsDir,
}: CreateReviewWorktreeOptions): Promise<ReviewMetadata> {
  const repo = targetToRepoConfig(target);
  const cacheDir = getCacheDir();
  const mirrorDir = path.join(cacheDir, `${repo.name}.git`);
  const repoReviewsDir = getRepoReviewsDir(reviewsDir, target.repo);
  const targetDir = getReviewWorktreePath(reviewsDir, target);

  if (await pathExists(targetDir)) {
    throw new Error(`Review worktree already exists: ${targetDir}`);
  }

  await ensureDir(repoReviewsDir);

  for await (const state of ensureMirrorRepoGenerator(repo, mirrorDir)) {
    if (state.status === "log") {
      log[state.level](state.message);
    }
  }

  const defaultBranch = await detectDefaultBranch(
    mirrorDir,
    repo.defaultBranch,
  );
  await runGit(
    ["worktree", "add", "--detach", targetDir, `origin/${defaultBranch}`],
    { cwd: mirrorDir },
  );

  try {
    await runCommand("gh", ["pr", "checkout", String(target.prNumber)], {
      cwd: targetDir,
      onStdout: (chunk) => process.stdout.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk),
    });
  } catch (error) {
    await cleanupFailedReviewWorktree(mirrorDir, targetDir);
    throw error;
  }

  const branch = await getCurrentBranch(targetDir);
  const metadata: ReviewMetadata = {
    ...target,
    path: targetDir,
    ...(branch ? { branch } : {}),
    created_at: new Date().toISOString(),
  };
  await writeReviewMetadata(reviewsDir, metadata);

  return metadata;
}

export async function listReviewWorktrees(
  reviewsDir: string,
  repo?: string,
): Promise<ReviewListEntry[]> {
  const resolvedReviewsDir = path.resolve(reviewsDir);
  if (!(await pathExists(resolvedReviewsDir))) {
    return [];
  }

  const repoDirs = repo
    ? [repo]
    : (await fs.readdir(resolvedReviewsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

  const entries: ReviewListEntry[] = [];
  for (const repoName of repoDirs) {
    const metadataDir = path.join(
      resolvedReviewsDir,
      repoName,
      REVIEW_METADATA_DIR,
    );
    if (!(await pathExists(metadataDir))) {
      continue;
    }

    const files = await fs.readdir(metadataDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const metadataPath = path.join(metadataDir, file);
      const metadata = JSON.parse(
        await fs.readFile(metadataPath, "utf8"),
      ) as ReviewMetadata;
      entries.push({
        ...metadata,
        state: (await pathExists(metadata.path)) ? "ready" : "stale",
      });
    }
  }

  entries.sort((a, b) =>
    a.repo === b.repo ? a.prNumber - b.prNumber : a.repo.localeCompare(b.repo),
  );
  return entries;
}

export async function removeReviewWorktree({
  target,
  reviewsDir,
  dryRun = false,
  force = false,
}: RemoveReviewWorktreeOptions): Promise<RemoveReviewWorktreeResult> {
  const targetDir = getReviewWorktreePath(reviewsDir, target);
  const metadata = await readReviewMetadata(reviewsDir, target);
  const branch =
    metadata?.branch ?? (await getCurrentBranchIfExists(targetDir));
  const exists = await pathExists(targetDir);
  const repo = targetToRepoConfig(target);
  const mirrorDir = path.join(getCacheDir(), `${repo.name}.git`);

  if (!exists && !metadata) {
    throw new Error(
      `No review worktree found for ${target.repo}#${target.prNumber}.`,
    );
  }

  if (dryRun) {
    return {
      path: targetDir,
      ...(branch ? { branch } : {}),
      dryRun: true,
    };
  }

  if (exists) {
    if (!force && (await isGitDirty(targetDir))) {
      throw new Error(
        `Review worktree "${target.repo}#${target.prNumber}" has uncommitted changes. Commit, discard, or pass --force.`,
      );
    }

    const removeArgs = ["worktree", "remove"];
    if (force) removeArgs.push("--force");
    removeArgs.push(targetDir);
    await runGit(removeArgs, { cwd: mirrorDir, timeout: 30_000 });
  }

  if (branch) {
    await deleteBranchIfPossible(mirrorDir, branch, force);
  }

  await deleteReviewMetadata(reviewsDir, target);

  return {
    path: targetDir,
    ...(branch ? { branch } : {}),
    dryRun: false,
  };
}

function parseSingleTarget(input: string): ReviewTarget {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Missing GitHub PR target.");
  }

  const normalized = trimmed.startsWith("github.com/")
    ? `https://${trimmed}`
    : trimmed;

  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    let url: URL;
    try {
      url = new URL(normalized);
    } catch {
      throw new Error(`Invalid GitHub PR URL: ${input}`);
    }

    if (url.hostname.toLowerCase() !== "github.com") {
      throw new Error(`Invalid GitHub PR URL: ${input}`);
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 4 || parts[2] !== "pull") {
      throw new Error(`Invalid GitHub PR URL: ${input}`);
    }

    return {
      owner: validateRepoPart(parts[0] ?? "", "owner"),
      repo: validateRepoPart(parts[1] ?? "", "repo"),
      prNumber: parsePrNumber(parts[3] ?? ""),
    };
  }

  const compact = trimmed.match(/^([^/\s#]+)\/([^/\s#]+)#(.+)$/);
  if (compact) {
    return {
      owner: validateRepoPart(compact[1] ?? "", "owner"),
      repo: validateRepoPart(compact[2] ?? "", "repo"),
      prNumber: parsePrNumber(compact[3] ?? ""),
    };
  }

  throw new Error("Expected a GitHub PR URL or <owner>/<repo> <pr-number>.");
}

function parseRepoSlug(input: string): Pick<ReviewTarget, "owner" | "repo"> {
  const parts = input.trim().split("/");
  if (parts.length !== 2) {
    throw new Error(`Invalid repository "${input}". Expected <owner>/<repo>.`);
  }

  return {
    owner: validateRepoPart(parts[0] ?? "", "owner"),
    repo: validateRepoPart(parts[1] ?? "", "repo"),
  };
}

function validateRepoPart(value: string, label: "owner" | "repo"): string {
  const trimmed = value.trim().replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    throw new Error(`Invalid GitHub ${label}: ${value}`);
  }
  return trimmed;
}

function parsePrNumber(input: string): number {
  const normalized = input.trim().replace(/^#/, "");
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new Error(`Invalid pull request number: ${input}`);
  }
  return Number(normalized);
}

function targetToRepoConfig(target: ReviewTarget): RepoConfig {
  return {
    name: target.repo,
    remote: `git@github.com:${target.owner}/${target.repo}.git`,
    defaultBranch: "main",
  };
}

async function detectDefaultBranch(
  mirrorDir: string,
  fallback: string,
): Promise<string> {
  try {
    const { stdout } = await runGit(["symbolic-ref", "HEAD"], {
      cwd: mirrorDir,
    });
    const branch = stdout.trim().replace("refs/heads/", "");
    const { stdout: refOutput } = await runGit(
      ["for-each-ref", `refs/remotes/origin/${branch}`],
      { cwd: mirrorDir },
    );
    if (refOutput.trim()) return branch;
  } catch {
    // Use the configured default branch when mirror introspection fails.
  }
  return fallback;
}

async function cleanupFailedReviewWorktree(
  mirrorDir: string,
  targetDir: string,
): Promise<void> {
  try {
    await runGit(["worktree", "remove", "--force", targetDir], {
      cwd: mirrorDir,
      timeout: 30_000,
    });
  } catch {
    // Preserve the original gh failure.
  }
}

async function getCurrentBranch(repoDir: string): Promise<string | undefined> {
  const { stdout } = await runGit(["branch", "--show-current"], {
    cwd: repoDir,
  });
  return stdout.trim() || undefined;
}

async function getCurrentBranchIfExists(
  repoDir: string,
): Promise<string | undefined> {
  if (!(await pathExists(repoDir))) return undefined;
  try {
    return await getCurrentBranch(repoDir);
  } catch {
    return undefined;
  }
}

async function isGitDirty(repoDir: string): Promise<boolean> {
  const { stdout } = await runGit(["status", "--porcelain"], { cwd: repoDir });
  return stdout.trim().length > 0;
}

async function deleteBranchIfPossible(
  repoDir: string,
  branch: string,
  force: boolean,
): Promise<void> {
  try {
    await runGit(["branch", force ? "-D" : "-d", branch], { cwd: repoDir });
  } catch {
    // The local branch may already be gone, or git may keep an unmerged branch.
  }
}

function getRepoReviewsDir(reviewsDir: string, repo: string): string {
  return path.join(path.resolve(reviewsDir), repo);
}

function getReviewWorktreePath(
  reviewsDir: string,
  target: ReviewTarget,
): string {
  return path.join(
    getRepoReviewsDir(reviewsDir, target.repo),
    `pr-${target.prNumber}`,
  );
}

function getReviewMetadataPath(
  reviewsDir: string,
  target: ReviewTarget,
): string {
  return path.join(
    getRepoReviewsDir(reviewsDir, target.repo),
    REVIEW_METADATA_DIR,
    `pr-${target.prNumber}.json`,
  );
}

async function writeReviewMetadata(
  reviewsDir: string,
  metadata: ReviewMetadata,
): Promise<void> {
  const metadataPath = getReviewMetadataPath(reviewsDir, metadata);
  await ensureDir(path.dirname(metadataPath));
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

async function readReviewMetadata(
  reviewsDir: string,
  target: ReviewTarget,
): Promise<ReviewMetadata | null> {
  const metadataPath = getReviewMetadataPath(reviewsDir, target);
  if (!(await pathExists(metadataPath))) return null;
  return JSON.parse(await fs.readFile(metadataPath, "utf8")) as ReviewMetadata;
}

async function deleteReviewMetadata(
  reviewsDir: string,
  target: ReviewTarget,
): Promise<void> {
  await fs.rm(getReviewMetadataPath(reviewsDir, target), { force: true });
}
