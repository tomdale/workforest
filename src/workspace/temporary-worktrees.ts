import { promises as fs } from "node:fs";
import path from "node:path";
import { log } from "../logger.ts";
import { runGit } from "../services/git.ts";
import {
  runSingleRepoInitializersGenerator,
  type SingleRepoInitializerState,
} from "../services/initializers/index.ts";
import type {
  RepoConfig,
  TemporaryWorktreeMetadata,
  WorkspaceMetadata,
  WorkspaceRepoMetadata,
} from "../types.ts";
import { pathExists } from "../utils/fs.ts";
import { isSlug } from "../utils/slug.ts";
import { runParallel } from "../utils/task-generator.ts";
import {
  appendTemporaryWorktrees,
  readWorkspaceMetadata,
  removeTemporaryWorktrees as removeTemporaryWorktreeMetadata,
} from "./metadata.ts";
import {
  appendRepoSetupLog,
  removeRepoSetupLog,
  startRepoSetupLog,
} from "./setup-logs.ts";

export type TemporaryWorktreeCreateResult = {
  slug: string;
  parentRepo: string;
  path: string;
  branch: string;
  setupStatus: "ready" | "failed";
  setupLog?: string;
};

export type TemporaryWorktreeFailure = {
  slug: string;
  error: Error;
};

export type CreateTemporaryWorktreesOptions = {
  workspaceDir: string;
  parentRepo: WorkspaceRepoMetadata;
  slugs: readonly string[];
  force?: boolean;
  dryRun?: boolean;
  disabledInitializers?: boolean | string[];
};

export type CreateTemporaryWorktreesResult = {
  created: TemporaryWorktreeCreateResult[];
  failures: TemporaryWorktreeFailure[];
};

export type TemporaryWorktreeListEntry = TemporaryWorktreeMetadata & {
  absolutePath: string;
  state: "ready" | "failed" | "stale";
  merged: boolean | null;
};

export type RemoveTemporaryWorktreesOptions = {
  workspaceDir: string;
  slugs: readonly string[];
  parentRepoName?: string;
  force?: boolean;
  dryRun?: boolean;
};

export type RemoveTemporaryWorktreesResult = {
  removed: TemporaryWorktreeMetadata[];
};

type CreateTaskState =
  | { phase: "complete"; result: TemporaryWorktreeCreateResult }
  | { phase: "failed"; slug: string; error: Error };

export function workspaceRepoToRepoConfig(
  repo: WorkspaceRepoMetadata,
): RepoConfig {
  return {
    name: repo.name,
    remote: repo.remote,
    defaultBranch: repo.default_branch,
  };
}

export async function createTemporaryWorktrees({
  workspaceDir,
  parentRepo,
  slugs,
  force = false,
  dryRun = false,
  disabledInitializers,
}: CreateTemporaryWorktreesOptions): Promise<CreateTemporaryWorktreesResult> {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const repoDir = path.join(resolvedWorkspaceDir, parentRepo.name);
  const metadata = await requireWorkspaceMetadata(resolvedWorkspaceDir);

  validateRequestedSlugs(slugs);

  const baseBranch = await getCurrentBranch(repoDir);
  const baseSha = await getCurrentSha(repoDir);

  if (!dryRun && !force && (await isGitDirty(repoDir))) {
    throw new Error(
      `Primary repo "${parentRepo.name}" has uncommitted changes. Commit or stash them before creating subagent worktrees, or pass --force.`,
    );
  }

  const planned = await planTemporaryWorktrees({
    workspaceDir: resolvedWorkspaceDir,
    metadata,
    parentRepo,
    slugs,
    baseBranch,
    baseSha,
  });

  if (dryRun) {
    return {
      created: planned.map((entry) => ({
        slug: entry.slug,
        parentRepo: entry.parent_repo,
        path: path.join(resolvedWorkspaceDir, entry.path),
        branch: entry.branch,
        setupStatus: entry.setup_status,
      })),
      failures: [],
    };
  }

  const repoConfig = workspaceRepoToRepoConfig(parentRepo);
  const tasks = new Map(
    planned.map((entry) => [
      entry.slug,
      createAndSetupTemporaryWorktree({
        workspaceDir: resolvedWorkspaceDir,
        parentRepoDir: repoDir,
        repo: repoConfig,
        entry,
        ...(disabledInitializers !== undefined ? { disabledInitializers } : {}),
      }),
    ]),
  );

  const created: TemporaryWorktreeCreateResult[] = [];
  const failures: TemporaryWorktreeFailure[] = [];

  for await (const { id, state } of runParallel(tasks)) {
    if (state.phase === "complete") {
      created.push(state.result);
      continue;
    }

    failures.push({ slug: id, error: state.error });
  }

  if (created.length > 0) {
    await appendTemporaryWorktrees(
      resolvedWorkspaceDir,
      created.map((result) => ({
        slug: result.slug,
        parent_repo: result.parentRepo,
        path: path.relative(resolvedWorkspaceDir, result.path),
        branch: result.branch,
        base_branch: baseBranch,
        base_sha: baseSha,
        created_at: new Date().toISOString(),
        setup_status: result.setupStatus,
        ...(result.setupLog ? { setup_log: result.setupLog } : {}),
      })),
    );
  }

  return { created, failures };
}

export async function listTemporaryWorktrees(
  workspaceDir: string,
  parentRepoName?: string,
): Promise<TemporaryWorktreeListEntry[]> {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const metadata = await requireWorkspaceMetadata(resolvedWorkspaceDir);
  const entries = (metadata.temporary_worktrees ?? []).filter((entry) =>
    parentRepoName ? entry.parent_repo === parentRepoName : true,
  );

  const listed: TemporaryWorktreeListEntry[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(resolvedWorkspaceDir, entry.path);
    const exists = await pathExists(absolutePath);
    const merged = exists
      ? await isTemporaryBranchMerged(resolvedWorkspaceDir, entry)
      : null;

    listed.push({
      ...entry,
      absolutePath,
      state: exists ? entry.setup_status : "stale",
      merged,
    });
  }

  return listed;
}

export async function removeTemporaryWorktrees({
  workspaceDir,
  slugs,
  parentRepoName,
  force = false,
  dryRun = false,
}: RemoveTemporaryWorktreesOptions): Promise<RemoveTemporaryWorktreesResult> {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const metadata = await requireWorkspaceMetadata(resolvedWorkspaceDir);
  validateRequestedSlugs(slugs);

  const targets = resolveRemovalTargets(
    metadata.temporary_worktrees ?? [],
    slugs,
    parentRepoName,
  );

  if (dryRun) {
    return { removed: targets };
  }

  const removed: TemporaryWorktreeMetadata[] = [];

  for (const entry of targets) {
    const absolutePath = path.join(resolvedWorkspaceDir, entry.path);
    const parentRepoDir = path.join(resolvedWorkspaceDir, entry.parent_repo);
    const exists = await pathExists(absolutePath);

    if (!exists) {
      await pruneStaleWorktree(parentRepoDir);
      await deleteBranchIfPossible(parentRepoDir, entry.branch, false);
      removed.push(entry);
      continue;
    }

    if (!force && (await isGitDirty(absolutePath))) {
      throw new Error(
        `Temporary worktree "${entry.slug}" has uncommitted changes. Commit, discard, or pass --force.`,
      );
    }

    if (
      !force &&
      !(await isTemporaryBranchMerged(resolvedWorkspaceDir, entry))
    ) {
      throw new Error(
        `Temporary branch "${entry.branch}" is not merged into ${entry.parent_repo}. Merge it first or pass --force.`,
      );
    }

    const removeArgs = ["worktree", "remove"];
    if (force) removeArgs.push("--force");
    removeArgs.push(absolutePath);
    await runGit(removeArgs, { cwd: parentRepoDir, timeout: 30_000 });
    await deleteBranchIfPossible(parentRepoDir, entry.branch, force);

    if (entry.setup_log) {
      await fs.rm(path.join(resolvedWorkspaceDir, entry.setup_log), {
        force: true,
      });
    }

    removed.push(entry);
  }

  if (removed.length > 0) {
    await removeTemporaryWorktreeMetadata(resolvedWorkspaceDir, removed);
  }

  return { removed };
}

async function* createAndSetupTemporaryWorktree({
  workspaceDir,
  parentRepoDir,
  repo,
  entry,
  disabledInitializers,
}: {
  workspaceDir: string;
  parentRepoDir: string;
  repo: RepoConfig;
  entry: TemporaryWorktreeMetadata;
  disabledInitializers?: boolean | string[];
}): AsyncGenerator<CreateTaskState> {
  const targetDir = path.join(workspaceDir, entry.path);

  try {
    log.info(
      `${entry.slug}: creating ${path.basename(targetDir)} on ${entry.branch}`,
    );
    await runGit(["worktree", "add", "-b", entry.branch, targetDir, "HEAD"], {
      cwd: parentRepoDir,
    });

    const result = await runTemporaryWorktreeInitializers({
      workspaceDir,
      repo,
      slug: entry.slug,
      targetDir,
      ...(disabledInitializers !== undefined ? { disabledInitializers } : {}),
    });

    yield {
      phase: "complete",
      result: {
        slug: entry.slug,
        parentRepo: entry.parent_repo,
        path: targetDir,
        branch: entry.branch,
        setupStatus: result.status,
        ...(result.logPath
          ? { setupLog: path.relative(workspaceDir, result.logPath) }
          : {}),
      },
    };
  } catch (error) {
    yield {
      phase: "failed",
      slug: entry.slug,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

async function runTemporaryWorktreeInitializers({
  workspaceDir,
  repo,
  slug,
  targetDir,
  disabledInitializers,
}: {
  workspaceDir: string;
  repo: RepoConfig;
  slug: string;
  targetDir: string;
  disabledInitializers?: boolean | string[];
}): Promise<{ status: "ready" | "failed"; logPath?: string }> {
  const logPath = await startRepoSetupLog({
    workspaceDir,
    repoName: `${repo.name}-${slug}`,
    repoDir: targetDir,
  });
  let failed = false;

  for await (const state of runSingleRepoInitializersGenerator({
    context: {
      repoDir: targetDir,
      workspaceDir,
      repo,
    },
    ...(disabledInitializers !== undefined ? { disabledInitializers } : {}),
  })) {
    await appendRepoSetupLog(logPath, formatInitializerState(state));

    if (state.phase === "running") {
      const task = state.state;
      if (task.status === "running" && task.message) {
        log.info(
          `${repo.name}-${slug}: ${state.initializerName} - ${task.message}`,
        );
      } else if (task.status === "completed") {
        log.success(`${repo.name}-${slug}: ${state.initializerName} complete`);
      } else if (task.status === "failed") {
        failed = true;
        log.error(`${repo.name}-${slug}: ${state.initializerName} failed`);
      }
    }
  }

  if (!failed) {
    await removeRepoSetupLog(logPath);
    return { status: "ready" };
  }

  return { status: "failed", logPath };
}

function formatInitializerState(state: SingleRepoInitializerState): string {
  switch (state.phase) {
    case "detecting":
      return "[initializer:detection] detecting\n";
    case "skipped":
      return `[initializer:${state.initializerId}] skipped: ${state.reason}\n`;
    case "complete":
      return "[complete] initializers complete\n";
    case "running":
      switch (state.state.status) {
        case "output":
          return state.state.data;
        case "running":
          return state.state.message
            ? `[initializer:${state.initializerId}] ${state.state.message}\n`
            : "";
        case "retrying":
          return `[initializer:${state.initializerId}] retry ${state.state.attempt}: ${state.state.reason}\n`;
        case "completed":
          return `[initializer:${state.initializerId}] completed\n`;
        case "failed":
          return [
            `[initializer:${state.initializerId}] failed: ${state.state.error.message}`,
            state.state.error.stack ? `${state.state.error.stack}\n` : "",
          ].join("\n");
        case "skipped":
          return `[initializer:${state.initializerId}] skipped: ${state.state.reason}\n`;
        case "pending":
          return `[initializer:${state.initializerId}] pending\n`;
        case "log":
          return `[initializer:${state.initializerId}] ${state.state.message}\n`;
      }
  }
}

async function planTemporaryWorktrees({
  workspaceDir,
  metadata,
  parentRepo,
  slugs,
  baseBranch,
  baseSha,
}: {
  workspaceDir: string;
  metadata: WorkspaceMetadata;
  parentRepo: WorkspaceRepoMetadata;
  slugs: readonly string[];
  baseBranch: string;
  baseSha: string;
}): Promise<TemporaryWorktreeMetadata[]> {
  const existingEntries = metadata.temporary_worktrees ?? [];
  const parentRepoDir = path.join(workspaceDir, parentRepo.name);
  const planned: TemporaryWorktreeMetadata[] = [];

  for (const slug of slugs) {
    const relativePath = `${parentRepo.name}-${slug}`;
    const targetDir = path.join(workspaceDir, relativePath);
    const branch = buildTemporaryBranchName(baseBranch, slug);

    if (
      existingEntries.some(
        (entry) => entry.parent_repo === parentRepo.name && entry.slug === slug,
      )
    ) {
      throw new Error(
        `Temporary worktree "${slug}" is already tracked for ${parentRepo.name}.`,
      );
    }

    if (await pathExists(targetDir)) {
      throw new Error(`Target directory already exists: ${targetDir}`);
    }

    if (await branchExists(parentRepoDir, branch)) {
      throw new Error(`Branch already exists: ${branch}`);
    }

    planned.push({
      slug,
      parent_repo: parentRepo.name,
      path: relativePath,
      branch,
      base_branch: baseBranch,
      base_sha: baseSha,
      created_at: new Date().toISOString(),
      setup_status: "ready",
    });
  }

  return planned;
}

function buildTemporaryBranchName(baseBranch: string, slug: string): string {
  const lastSlash = baseBranch.lastIndexOf("/");
  if (lastSlash === -1) {
    return slug;
  }

  return `${baseBranch.slice(0, lastSlash + 1)}${slug}`;
}

function validateRequestedSlugs(slugs: readonly string[]): void {
  if (slugs.length === 0) {
    throw new Error("At least one worktree slug is required.");
  }

  const seen = new Set<string>();
  for (const slug of slugs) {
    if (!isSlug(slug)) {
      throw new Error(
        `Invalid slug "${slug}". Slugs must be lowercase words separated by hyphens.`,
      );
    }

    if (seen.has(slug)) {
      throw new Error(`Duplicate worktree slug: ${slug}`);
    }
    seen.add(slug);
  }
}

function resolveRemovalTargets(
  entries: readonly TemporaryWorktreeMetadata[],
  slugs: readonly string[],
  parentRepoName: string | undefined,
): TemporaryWorktreeMetadata[] {
  const targets: TemporaryWorktreeMetadata[] = [];

  for (const slug of slugs) {
    const matches = entries.filter(
      (entry) =>
        entry.slug === slug &&
        (parentRepoName ? entry.parent_repo === parentRepoName : true),
    );

    if (matches.length === 0) {
      throw new Error(
        parentRepoName
          ? `No temporary worktree "${slug}" tracked for ${parentRepoName}.`
          : `No temporary worktree "${slug}" is tracked.`,
      );
    }

    if (matches.length > 1) {
      throw new Error(
        `Temporary worktree slug "${slug}" is ambiguous. Pass --repo <repoName>.`,
      );
    }

    const match = matches[0];
    if (match) targets.push(match);
  }

  return targets;
}

async function requireWorkspaceMetadata(
  workspaceDir: string,
): Promise<WorkspaceMetadata> {
  const metadata = await readWorkspaceMetadata(workspaceDir);
  if (!metadata) {
    throw new Error(`Could not read workspace metadata from ${workspaceDir}`);
  }
  return metadata;
}

async function getCurrentBranch(repoDir: string): Promise<string> {
  const { stdout } = await runGit(["branch", "--show-current"], {
    cwd: repoDir,
  });
  const branch = stdout.trim();
  if (!branch) {
    throw new Error(
      `Primary repo at ${repoDir} is on a detached HEAD. Check out a branch before creating subagent worktrees.`,
    );
  }
  return branch;
}

async function getCurrentSha(repoDir: string): Promise<string> {
  const { stdout } = await runGit(["rev-parse", "HEAD"], { cwd: repoDir });
  return stdout.trim();
}

async function isGitDirty(repoDir: string): Promise<boolean> {
  const { stdout } = await runGit(["status", "--porcelain"], { cwd: repoDir });
  return stdout.trim().length > 0;
}

async function branchExists(repoDir: string, branch: string): Promise<boolean> {
  try {
    await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: repoDir,
    });
    return true;
  } catch {
    return false;
  }
}

async function isTemporaryBranchMerged(
  workspaceDir: string,
  entry: TemporaryWorktreeMetadata,
): Promise<boolean | null> {
  const parentRepoDir = path.join(workspaceDir, entry.parent_repo);
  try {
    await runGit(["merge-base", "--is-ancestor", entry.branch, "HEAD"], {
      cwd: parentRepoDir,
    });
    return true;
  } catch {
    return false;
  }
}

async function pruneStaleWorktree(parentRepoDir: string): Promise<void> {
  try {
    await runGit(["worktree", "prune"], { cwd: parentRepoDir });
  } catch {
    // Stale cleanup should be best-effort; metadata pruning is still useful.
  }
}

async function deleteBranchIfPossible(
  repoDir: string,
  branch: string,
  force: boolean,
): Promise<void> {
  try {
    await runGit(["branch", force ? "-D" : "-d", branch], { cwd: repoDir });
  } catch {
    // The branch may already be gone, or a stale unmerged branch may be kept.
  }
}
