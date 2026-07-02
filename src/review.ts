import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "@wf-plugin/core";
import { getCacheDir } from "./config.ts";
import { resolveMirrorDir } from "./repositories.ts";
import { validateRepositoryComponent } from "./repository-components.ts";
import { emitServiceEvent, type ServiceEventSink } from "./services/events.ts";
import { createDefaultBranchResolver, runGit } from "./services/git.ts";
import { runSingleRepoInitializersGenerator } from "./services/initializers/index.ts";
import type { RepositorySource } from "./types.ts";
import { runCommand } from "./utils/exec.ts";
import { ensureDir } from "./utils/fs.ts";
import { resolveContainedPath } from "./utils/path-safety.ts";
import {
  readWorkspaceMetadata,
  removeReviewWorktreeMetadata,
  saveWorkspaceMetadata,
  upsertReviewWorktree,
  writeWorkspaceMetadata,
} from "./workspace/metadata.ts";
import { ensureMirrorRepoGenerator } from "./workspace/repository.ts";

export type ReviewTarget = {
  owner: string;
  repo: string;
  prNumber: number;
};

export type ReviewRepoTarget = Pick<ReviewTarget, "owner" | "repo">;

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
  reviewsRoot: string;
  onEvent?: ServiceEventSink;
};

export type EnsureReviewWorkspaceOptions = {
  target: ReviewRepoTarget;
  reviewsRoot: string;
  onEvent?: ServiceEventSink;
};

export type ReviewWorkspace = ReviewRepoTarget & {
  path: string;
  repoDir: string;
};

export type ReviewTargetContext = {
  owner: string;
  repo: string;
};

export type RemoveReviewWorktreeOptions = {
  target: ReviewTarget;
  reviewsRoot: string;
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

export function resolveReviewTarget(
  args: readonly string[],
  context?: ReviewTargetContext,
): ReviewTarget {
  try {
    return parseReviewTarget(args);
  } catch (error) {
    if (args.length === 1 && context) {
      return {
        ...context,
        prNumber: parsePrNumber(args[0] ?? ""),
      };
    }

    throw error;
  }
}

export function parseReviewRepoTarget(
  args: readonly string[],
): ReviewRepoTarget {
  if (args.length !== 1) {
    throw new Error("Expected <owner>/<repo>.");
  }

  return parseRepoSlug(args[0] ?? "");
}

export async function createReviewWorktree({
  target,
  reviewsRoot,
  onEvent,
}: CreateReviewWorktreeOptions): Promise<ReviewMetadata> {
  validateReviewTarget(target);
  const repo = targetToRepoConfig(target);
  const cacheDir = getCacheDir();
  const mirrorDir = await resolveMirrorDir(repo, cacheDir);
  const workspace = await ensureReviewWorkspace({
    target: { owner: target.owner, repo: target.repo },
    reviewsRoot,
    ...(onEvent ? { onEvent } : {}),
  });
  const repoReviewsDir = workspace.path;
  const targetDir = getReviewWorktreePath(reviewsRoot, target);

  if (await pathExists(targetDir)) {
    throw new Error(`Review worktree already exists: ${targetDir}`);
  }

  const defaultBranch =
    await createDefaultBranchResolver().resolveBareMirrorDefaultBranch(
      mirrorDir,
    );
  await runGit(
    ["worktree", "add", "--detach", targetDir, `origin/${defaultBranch}`],
    {
      cwd: mirrorDir,
    },
  );

  try {
    await runCommand("gh", ["pr", "checkout", String(target.prNumber)], {
      cwd: targetDir,
      onStdout: (data) =>
        emitServiceEvent(onEvent, { type: "output", stream: "stdout", data }),
      onStderr: (data) =>
        emitServiceEvent(onEvent, { type: "output", stream: "stderr", data }),
    });
  } catch (error) {
    await cleanupFailedReviewWorktree(mirrorDir, targetDir);
    throw error;
  }

  await runReviewInitializers({
    repo,
    repoDir: targetDir,
    workspaceDir: repoReviewsDir,
    ...(onEvent ? { onEvent } : {}),
  });

  const branch = await getCurrentBranch(targetDir);
  const metadata: ReviewMetadata = {
    ...target,
    path: targetDir,
    ...(branch ? { branch } : {}),
    created_at: new Date().toISOString(),
  };
  await upsertReviewWorktree(repoReviewsDir, {
    pr_number: target.prNumber,
    path: path.relative(repoReviewsDir, targetDir),
    ...(branch ? { branch } : {}),
    created_at: metadata.created_at,
  });

  return metadata;
}

export async function ensureReviewWorkspace({
  target,
  reviewsRoot,
  onEvent,
}: EnsureReviewWorkspaceOptions): Promise<ReviewWorkspace> {
  validateReviewRepoTarget(target);
  const repo = targetToRepoConfig(target);
  const cacheDir = getCacheDir();
  const mirrorDir = await resolveMirrorDir(repo, cacheDir);
  const workspaceDir = getRepoReviewsDir(reviewsRoot, target.repo);
  const repoDir = resolveContainedPath(workspaceDir, target.repo);

  await ensureDir(workspaceDir);

  for await (const state of ensureMirrorRepoGenerator(repo, mirrorDir)) {
    if (state.status === "log") {
      emitServiceEvent(onEvent, {
        type: "message",
        level: state.level === "warn" ? "warning" : state.level,
        message: state.message,
      });
    }
  }

  if (!(await pathExists(repoDir))) {
    const defaultBranch =
      await createDefaultBranchResolver().resolveBareMirrorDefaultBranch(
        mirrorDir,
      );
    await runGit(
      ["worktree", "add", "--detach", repoDir, `origin/${defaultBranch}`],
      { cwd: mirrorDir },
    );

    await runReviewInitializers({
      repo,
      repoDir,
      workspaceDir,
      ...(onEvent ? { onEvent } : {}),
    });
  }

  const existingMetadata = await readWorkspaceMetadata(workspaceDir);
  const repoMetadata = {
    name: repo.name,
    remote: repo.remote,
    hasLockfile: false,
  };
  if (!existingMetadata) {
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: target.repo,
      type: "review",
      review: target,
      repos: [repoMetadata],
    });
  } else if (
    existingMetadata.workspace.type !== "review" ||
    existingMetadata.workspace.review?.owner !== target.owner ||
    existingMetadata.workspace.review?.repo !== target.repo ||
    existingMetadata.repos.length !== 1 ||
    existingMetadata.repos[0]?.name !== repo.name
  ) {
    await saveWorkspaceMetadata(workspaceDir, {
      ...existingMetadata,
      workspace: {
        ...existingMetadata.workspace,
        type: "review",
        review: target,
      },
      repos: [
        {
          name: repo.name,
          remote: repo.remote,
          has_lockfile: false,
        },
      ],
    });
  }

  return {
    ...target,
    path: workspaceDir,
    repoDir,
  };
}

async function runReviewInitializers({
  repo,
  repoDir,
  workspaceDir,
  onEvent,
}: {
  repo: RepositorySource;
  repoDir: string;
  workspaceDir: string;
  onEvent?: ServiceEventSink;
}): Promise<void> {
  for await (const state of runSingleRepoInitializersGenerator({
    context: { repo, repoDir, workspaceDir },
  })) {
    switch (state.phase) {
      case "detecting":
        emitServiceEvent(onEvent, {
          type: "message",
          level: "info",
          message: "Detecting repo setup",
        });
        break;
      case "running":
        if (state.state.status === "log") {
          emitServiceEvent(onEvent, {
            type: "message",
            level: state.state.level === "warn" ? "warning" : state.state.level,
            message: state.state.message,
          });
        } else if (state.state.status === "running" && state.state.message) {
          emitServiceEvent(onEvent, {
            type: "message",
            level: "info",
            message: `${state.initializerName}: ${state.state.message}`,
          });
        } else if (state.state.status === "output") {
          emitServiceEvent(onEvent, {
            type: "output",
            stream: "stdout",
            data: state.state.data,
          });
        } else if (state.state.status === "skipped") {
          emitServiceEvent(onEvent, {
            type: "message",
            level: "info",
            message: `${state.initializerName}: ${state.state.reason}`,
          });
        } else if (state.state.status === "failed") {
          throw state.state.error;
        }
        break;
      case "skipped":
        emitServiceEvent(onEvent, {
          type: "message",
          level: "info",
          message: `${state.initializerId}: ${state.reason}`,
        });
        break;
      case "complete":
        break;
    }
  }
}

export async function listReviewWorktrees(
  reviewsRoot: string,
  repo?: string,
): Promise<ReviewListEntry[]> {
  const resolvedReviewsDir = path.resolve(reviewsRoot);
  if (!(await pathExists(resolvedReviewsDir))) {
    return [];
  }

  const repoDirs = repo
    ? [validateRepositoryComponent(repo, "Repository name")]
    : (await fs.readdir(resolvedReviewsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

  const entries: ReviewListEntry[] = [];
  for (const repoName of repoDirs) {
    const workspaceDir = resolveContainedPath(resolvedReviewsDir, repoName);
    const metadata = await readWorkspaceMetadata(workspaceDir);
    if (!metadata?.workspace.review) {
      continue;
    }

    for (const worktree of metadata.review_worktrees ?? []) {
      const absolutePath = resolveContainedPath(workspaceDir, worktree.path);
      entries.push({
        owner: metadata.workspace.review.owner,
        repo: metadata.workspace.review.repo,
        prNumber: worktree.pr_number,
        path: absolutePath,
        ...(worktree.branch ? { branch: worktree.branch } : {}),
        created_at: worktree.created_at,
        state: (await pathExists(absolutePath)) ? "ready" : "stale",
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
  reviewsRoot,
  dryRun = false,
  force = false,
}: RemoveReviewWorktreeOptions): Promise<RemoveReviewWorktreeResult> {
  validateReviewTarget(target);
  const targetDir = getReviewWorktreePath(reviewsRoot, target);
  const workspaceDir = getRepoReviewsDir(reviewsRoot, target.repo);
  const metadata = await readReviewWorktreeMetadata(workspaceDir, target);
  const branch =
    metadata?.branch ?? (await getCurrentBranchIfExists(targetDir));
  const exists = await pathExists(targetDir);
  const repo = targetToRepoConfig(target);
  const mirrorDir = await resolveMirrorDir(repo, getCacheDir());

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

  if (await readWorkspaceMetadata(workspaceDir)) {
    await removeReviewWorktreeMetadata(workspaceDir, target.prNumber);
  }

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
  return validateRepositoryComponent(
    value.trim().replace(/\.git$/i, ""),
    label === "owner" ? "GitHub owner" : "GitHub repository",
  );
}

function parsePrNumber(input: string): number {
  const normalized = input.trim().replace(/^#/, "");
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new Error(`Invalid pull request number: ${input}`);
  }
  return Number(normalized);
}

function targetToRepoConfig(target: ReviewRepoTarget): RepositorySource {
  return {
    name: target.repo,
    remote: `git@github.com:${target.owner}/${target.repo}.git`,
  };
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

function getRepoReviewsDir(reviewsRoot: string, repo: string): string {
  return resolveContainedPath(
    path.resolve(reviewsRoot),
    validateRepositoryComponent(repo, "Repository name"),
  );
}

function getReviewWorktreePath(
  reviewsRoot: string,
  target: ReviewTarget,
): string {
  return resolveContainedPath(
    getRepoReviewsDir(reviewsRoot, target.repo),
    `pr-${target.prNumber}`,
  );
}

async function readReviewWorktreeMetadata(
  workspaceDir: string,
  target: ReviewTarget,
): Promise<ReviewMetadata | null> {
  const metadata = await readWorkspaceMetadata(workspaceDir);
  if (!metadata?.workspace.review) return null;

  const worktree = (metadata.review_worktrees ?? []).find(
    (entry) => entry.pr_number === target.prNumber,
  );
  if (!worktree) return null;

  return {
    owner: metadata.workspace.review.owner,
    repo: metadata.workspace.review.repo,
    prNumber: worktree.pr_number,
    path: resolveContainedPath(workspaceDir, worktree.path),
    ...(worktree.branch ? { branch: worktree.branch } : {}),
    created_at: worktree.created_at,
  };
}

function validateReviewRepoTarget(target: ReviewRepoTarget): void {
  validateRepositoryComponent(target.owner, "GitHub owner");
  validateRepositoryComponent(target.repo, "GitHub repository");
}

function validateReviewTarget(target: ReviewTarget): void {
  validateReviewRepoTarget(target);
  if (!Number.isSafeInteger(target.prNumber) || target.prNumber < 1) {
    throw new Error(`Invalid pull request number: ${target.prNumber}`);
  }
}
