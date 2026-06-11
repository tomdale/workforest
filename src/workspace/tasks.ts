import { promises as fs } from "node:fs";
import path from "node:path";
import { validateRepositoryComponent } from "../repository-components.ts";
import { emitServiceEvent, type ServiceEventSink } from "../services/events.ts";
import { runGit } from "../services/git.ts";
import {
  runSingleRepoInitializersGenerator,
  type SingleRepoInitializerState,
} from "../services/initializers/index.ts";
import type {
  RepoConfig,
  TaskMetadata,
  WorkspaceMetadata,
  WorkspaceRepoMetadata,
} from "../types.ts";
import { buildBranchName } from "../utils/branch-prefix.ts";
import { pathExists } from "../utils/fs.ts";
import {
  resolveContainedPath,
  validateResourceName,
} from "../utils/path-safety.ts";
import { isSlug } from "../utils/slug.ts";
import { runParallel } from "../utils/task-generator.ts";
import {
  appendTasks,
  getTaskSetupLogRelativePath,
  readWorkspaceMetadata,
  removeTasks as removeTaskMetadata,
} from "./metadata.ts";
import {
  appendRepoSetupLog,
  removeRepoSetupLog,
  startRepoSetupLog,
} from "./setup-logs.ts";

export type TaskCreateResult = {
  slug: string;
  parentRepo: string;
  path: string;
  branch: string;
  setupStatus: "ready" | "failed";
  setupLog?: string;
};

export type TaskFailure = {
  slug: string;
  error: Error;
};

export type CreateTasksOptions = {
  workspaceDir: string;
  parentRepo: WorkspaceRepoMetadata;
  sourceRepoDir?: string;
  slugs: readonly string[];
  branchPrefix?: string;
  force?: boolean;
  dryRun?: boolean;
  disabledInitializers?: boolean | string[];
  onEvent?: ServiceEventSink;
};

export type CreateTasksResult = {
  created: TaskCreateResult[];
  failures: TaskFailure[];
};

export type TaskListEntry = TaskMetadata & {
  absolutePath: string;
  state: "ready" | "failed" | "stale";
  merged: boolean | null;
};

export type DeleteTasksOptions = {
  workspaceDir: string;
  slugs: readonly string[];
  parentRepoName?: string;
  force?: boolean;
  dryRun?: boolean;
};

export type DeleteTasksResult = {
  removed: TaskMetadata[];
};

type CreateTaskState =
  | { phase: "complete"; result: TaskCreateResult }
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

export async function createTasks({
  workspaceDir,
  parentRepo,
  sourceRepoDir,
  slugs,
  branchPrefix,
  force = false,
  dryRun = false,
  disabledInitializers,
  onEvent,
}: CreateTasksOptions): Promise<CreateTasksResult> {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const parentRepoName = validateRepositoryComponent(
    parentRepo.name,
    "Repository name",
  );
  const repoDir = resolveContainedPath(resolvedWorkspaceDir, parentRepoName);
  const resolvedSourceRepoDir = sourceRepoDir
    ? path.resolve(sourceRepoDir)
    : repoDir;
  const metadata = await requireWorkspaceMetadata(resolvedWorkspaceDir);

  validateRequestedSlugs(slugs);

  const baseBranch = await getCurrentBranch(resolvedSourceRepoDir);
  const baseSha = await getCurrentSha(resolvedSourceRepoDir);

  if (!dryRun && !force && (await isGitDirty(resolvedSourceRepoDir))) {
    throw new Error(
      `Primary repo "${parentRepo.name}" has uncommitted changes. Commit or stash them before creating tasks, or pass --force.`,
    );
  }

  const planned = await planTasks({
    workspaceDir: resolvedWorkspaceDir,
    metadata,
    parentRepo,
    slugs,
    baseBranch,
    baseSha,
    ...(branchPrefix !== undefined ? { branchPrefix } : {}),
  });

  if (dryRun) {
    return {
      created: planned.map((entry) => ({
        slug: entry.slug,
        parentRepo: entry.parent_repo,
        path: resolveContainedPath(resolvedWorkspaceDir, entry.path),
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
      createAndSetupTask({
        workspaceDir: resolvedWorkspaceDir,
        parentRepoDir: resolvedSourceRepoDir,
        repo: repoConfig,
        entry,
        ...(disabledInitializers !== undefined ? { disabledInitializers } : {}),
        ...(onEvent ? { onEvent } : {}),
      }),
    ]),
  );

  const created: TaskCreateResult[] = [];
  const failures: TaskFailure[] = [];

  for await (const { id, state } of runParallel(tasks)) {
    if (state.phase === "complete") {
      created.push(state.result);
      continue;
    }

    failures.push({ slug: id, error: state.error });
  }

  if (created.length > 0) {
    await appendTasks(
      resolvedWorkspaceDir,
      created.map((result) => ({
        slug: result.slug,
        parent_repo: result.parentRepo,
        path: result.slug,
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

export async function listTasks(
  workspaceDir: string,
  parentRepoName?: string,
): Promise<TaskListEntry[]> {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const metadata = await requireWorkspaceMetadata(resolvedWorkspaceDir);
  if (parentRepoName) {
    validateRepositoryComponent(parentRepoName, "Repository name");
  }
  const entries = (metadata.tasks ?? []).filter((entry) =>
    parentRepoName ? entry.parent_repo === parentRepoName : true,
  );

  const listed: TaskListEntry[] = [];

  for (const entry of entries) {
    const absolutePath = resolveContainedPath(resolvedWorkspaceDir, entry.path);
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

export async function deleteTasks({
  workspaceDir,
  slugs,
  parentRepoName,
  force = false,
  dryRun = false,
}: DeleteTasksOptions): Promise<DeleteTasksResult> {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const metadata = await requireWorkspaceMetadata(resolvedWorkspaceDir);
  validateRequestedSlugs(slugs);
  if (parentRepoName) {
    validateRepositoryComponent(parentRepoName, "Repository name");
  }

  const targets = resolveRemovalTargets(
    metadata.tasks ?? [],
    slugs,
    parentRepoName,
  );

  if (dryRun) {
    return { removed: targets };
  }

  const removed: TaskMetadata[] = [];

  for (const entry of targets) {
    const absolutePath = resolveContainedPath(resolvedWorkspaceDir, entry.slug);
    const parentRepoDir = resolveContainedPath(
      resolvedWorkspaceDir,
      entry.parent_repo,
    );
    const exists = await pathExists(absolutePath);

    if (!exists) {
      await pruneStaleWorktree(parentRepoDir);
      await deleteBranchIfPossible(parentRepoDir, entry.branch, false);
      removed.push(entry);
      continue;
    }

    if (!force && (await isGitDirty(absolutePath))) {
      throw new Error(
        `Task "${entry.slug}" has uncommitted changes. Commit, discard, or pass --force.`,
      );
    }

    if (
      !force &&
      !(await isTemporaryBranchMerged(resolvedWorkspaceDir, entry))
    ) {
      throw new Error(
        `Task branch "${entry.branch}" is not merged into ${entry.parent_repo}. Merge it first or pass --force.`,
      );
    }

    const removeArgs = ["worktree", "remove"];
    if (force) removeArgs.push("--force");
    removeArgs.push(absolutePath);
    await runGit(removeArgs, { cwd: parentRepoDir, timeout: 30_000 });
    await deleteBranchIfPossible(parentRepoDir, entry.branch, force);

    if (entry.setup_log) {
      await fs.rm(
        resolveContainedPath(
          resolvedWorkspaceDir,
          getTaskSetupLogRelativePath(entry.parent_repo, entry.slug),
        ),
        { force: true },
      );
    }

    removed.push(entry);
  }

  if (removed.length > 0) {
    await removeTaskMetadata(resolvedWorkspaceDir, removed);
  }

  return { removed };
}

async function* createAndSetupTask({
  workspaceDir,
  parentRepoDir,
  repo,
  entry,
  disabledInitializers,
  onEvent,
}: {
  workspaceDir: string;
  parentRepoDir: string;
  repo: RepoConfig;
  entry: TaskMetadata;
  disabledInitializers?: boolean | string[];
  onEvent?: ServiceEventSink;
}): AsyncGenerator<CreateTaskState> {
  const targetDir = resolveContainedPath(workspaceDir, entry.path);

  try {
    emitServiceEvent(onEvent, {
      type: "message",
      level: "info",
      message: `${entry.slug}: creating ${path.basename(targetDir)} on ${entry.branch}`,
    });
    await runGit(["worktree", "add", "-b", entry.branch, targetDir, "HEAD"], {
      cwd: parentRepoDir,
    });

    const result = await runTaskInitializers({
      workspaceDir,
      repo,
      slug: entry.slug,
      targetDir,
      ...(disabledInitializers !== undefined ? { disabledInitializers } : {}),
      ...(onEvent ? { onEvent } : {}),
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
          ? {
              setupLog: getTaskSetupLogRelativePath(
                entry.parent_repo,
                entry.slug,
              ),
            }
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

async function runTaskInitializers({
  workspaceDir,
  repo,
  slug,
  targetDir,
  disabledInitializers,
  onEvent,
}: {
  workspaceDir: string;
  repo: RepoConfig;
  slug: string;
  targetDir: string;
  disabledInitializers?: boolean | string[];
  onEvent?: ServiceEventSink;
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
        emitServiceEvent(onEvent, {
          type: "message",
          level: "info",
          message: `${repo.name}-${slug}: ${state.initializerName} - ${task.message}`,
        });
      } else if (task.status === "completed") {
        emitServiceEvent(onEvent, {
          type: "message",
          level: "success",
          message: `${repo.name}-${slug}: ${state.initializerName} complete`,
        });
      } else if (task.status === "failed") {
        failed = true;
        emitServiceEvent(onEvent, {
          type: "message",
          level: "error",
          message: `${repo.name}-${slug}: ${state.initializerName} failed`,
        });
      }
    }
  }

  if (!failed) {
    await removeRepoSetupLog(workspaceDir, logPath);
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

async function planTasks({
  workspaceDir,
  metadata,
  parentRepo,
  slugs,
  baseBranch,
  baseSha,
  branchPrefix,
}: {
  workspaceDir: string;
  metadata: WorkspaceMetadata;
  parentRepo: WorkspaceRepoMetadata;
  slugs: readonly string[];
  baseBranch: string;
  baseSha: string;
  branchPrefix?: string;
}): Promise<TaskMetadata[]> {
  const existingEntries = metadata.tasks ?? [];
  const parentRepoDir = resolveContainedPath(
    workspaceDir,
    validateRepositoryComponent(parentRepo.name, "Repository name"),
  );
  const existingSlugs = new Set(existingEntries.map((entry) => entry.slug));
  const planned: TaskMetadata[] = [];

  for (const slug of slugs) {
    const relativePath = slug;
    const targetDir = resolveContainedPath(workspaceDir, relativePath);
    const branch = buildTemporaryBranchName(baseBranch, slug, branchPrefix);

    if (existingSlugs.has(slug)) {
      throw new Error(`Task "${slug}" is already tracked in this workspace.`);
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

function buildTemporaryBranchName(
  baseBranch: string,
  slug: string,
  branchPrefix: string | undefined,
): string {
  if (branchPrefix) {
    return buildBranchName(slug, branchPrefix);
  }

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
    validateResourceName(slug, "Task name");

    if (seen.has(slug)) {
      throw new Error(`Duplicate worktree slug: ${slug}`);
    }
    seen.add(slug);
  }
}

function resolveRemovalTargets(
  entries: readonly TaskMetadata[],
  slugs: readonly string[],
  parentRepoName: string | undefined,
): TaskMetadata[] {
  const targets: TaskMetadata[] = [];

  for (const slug of slugs) {
    const matches = entries.filter(
      (entry) =>
        entry.slug === slug &&
        (parentRepoName ? entry.parent_repo === parentRepoName : true),
    );

    if (matches.length === 0) {
      throw new Error(
        parentRepoName
          ? `No task "${slug}" tracked for ${parentRepoName}.`
          : `No task "${slug}" is tracked.`,
      );
    }

    if (matches.length > 1) {
      throw new Error(`Task "${slug}" is ambiguous. Pass --repo <repoName>.`);
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
      `Primary repo at ${repoDir} is on a detached HEAD. Check out a branch before creating tasks.`,
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
  entry: TaskMetadata,
): Promise<boolean | null> {
  const parentRepoDir = resolveContainedPath(workspaceDir, entry.parent_repo);
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
