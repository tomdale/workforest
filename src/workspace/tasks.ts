import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathExists } from "@wf-plugin/core";
import { validateRepositoryComponent } from "../repository-components.ts";
import { emitServiceEvent, type ServiceEventSink } from "../services/events.ts";
import { runGit } from "../services/git.ts";
import {
  runSingleRepoInitializersGenerator,
  type SingleRepoInitializerState,
} from "../services/initializers/index.ts";
import type {
  RepositorySource,
  TaskMetadata,
  WorkspaceMetadata,
  WorkspaceRepoMetadata,
} from "../types.ts";
import { buildBranchName } from "../utils/branch-prefix.ts";
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
import { TASKS_DIRECTORY_NAME } from "./paths.ts";
import {
  appendRepoSetupLog,
  removeRepoSetupLog,
  startRepoSetupLog,
} from "./setup-logs.ts";

const GIT_WORKTREE_LOCK_FILENAME = "workforest-worktree.lock";
const GIT_WORKTREE_LOCK_RETRY_MS = 20;
const GIT_WORKTREE_LOCK_TIMEOUT_MS = 10_000;
const GIT_WORKTREE_LOCK_STALE_MS = 30_000;

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

export type CreateRepositoryTasksOptions = {
  parentRepoDir: string;
  repo: RepositorySource;
  changeName: string;
  slugs: readonly string[];
  branchPrefix?: string;
  force?: boolean;
  dryRun?: boolean;
  disabledInitializers?: boolean | string[];
  onEvent?: ServiceEventSink;
};

export type RepositoryTasksOptions = {
  parentRepoDir: string;
  repoName: string;
  changeName: string;
};

export type RemoveRepositoryTasksOptions = RepositoryTasksOptions & {
  slugs: readonly string[];
  force?: boolean;
  dryRun?: boolean;
};

type RemoveWorkspaceTasksOptions = {
  workspaceDir: string;
  slugs: readonly string[];
  parentRepoName: string | undefined;
  force: boolean;
  dryRun: boolean;
};

type RemoveRepositoryTasksInternalOptions = RepositoryTasksOptions & {
  slugs: readonly string[];
  force: boolean;
  dryRun: boolean;
};

type CreateTaskState =
  | { phase: "complete"; result: TaskCreateResult }
  | { phase: "failed"; slug: string; error: Error };

export function workspaceRepoToRepoConfig(
  repo: WorkspaceRepoMetadata,
): RepositorySource {
  return {
    name: repo.name,
    remote: repo.remote,
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
    const plannedBySlug = new Map(planned.map((entry) => [entry.slug, entry]));
    await appendTasks(
      resolvedWorkspaceDir,
      created.map((result) => ({
        slug: result.slug,
        parent_repo: result.parentRepo,
        path: plannedBySlug.get(result.slug)?.path ?? result.slug,
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

export async function createRepositoryTasks({
  parentRepoDir,
  repo,
  changeName,
  slugs,
  branchPrefix,
  force = false,
  dryRun = false,
  disabledInitializers,
  onEvent,
}: CreateRepositoryTasksOptions): Promise<CreateTasksResult> {
  const resolvedParentRepoDir = path.resolve(parentRepoDir);
  const repoRootDir = path.dirname(resolvedParentRepoDir);
  const repoName = validateRepositoryComponent(repo.name, "Repository name");
  const safeName = validateResourceName(changeName, "Name");
  validateRequestedSlugs(slugs);

  const baseBranch = await getCurrentBranch(resolvedParentRepoDir);
  const baseSha = await getCurrentSha(resolvedParentRepoDir);

  if (!dryRun && !force && (await isGitDirty(resolvedParentRepoDir))) {
    throw new Error(
      `Repository change "${repoName}/${safeName}" has uncommitted changes. Commit or stash them before creating tasks, or pass --force.`,
    );
  }

  const planned = await planRepositoryTasks({
    repoRootDir,
    parentRepoDir: resolvedParentRepoDir,
    repoName,
    changeName: safeName,
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
        path: resolveContainedPath(repoRootDir, entry.path),
        branch: entry.branch,
        setupStatus: entry.setup_status,
      })),
      failures: [],
    };
  }

  const tasks = new Map(
    planned.map((entry) => [
      entry.slug,
      createAndSetupTask({
        workspaceDir: repoRootDir,
        parentRepoDir: resolvedParentRepoDir,
        repo,
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

export async function listRepositoryTasks({
  parentRepoDir,
  repoName,
  changeName,
}: RepositoryTasksOptions): Promise<TaskListEntry[]> {
  const resolvedParentRepoDir = path.resolve(parentRepoDir);
  const repoRootDir = path.dirname(resolvedParentRepoDir);
  const safeRepoName = validateRepositoryComponent(repoName, "Repository name");
  const safeName = validateResourceName(changeName, "Name");
  const slugs = await listRepositoryTaskSlugs(repoRootDir, safeName);
  if (slugs.length === 0) {
    return [];
  }

  const baseBranch = await getCurrentBranch(resolvedParentRepoDir).catch(
    () => "HEAD",
  );
  const baseSha = await getCurrentSha(resolvedParentRepoDir).catch(() => "");
  const entries: TaskListEntry[] = [];

  for (const slug of slugs) {
    const relativePath = repositoryTaskRelativePath(safeName, slug);
    const absolutePath = resolveContainedPath(repoRootDir, relativePath);
    const setupLog = await repositoryTaskSetupLog(
      repoRootDir,
      safeRepoName,
      slug,
    );
    const branch =
      (await getCurrentBranch(absolutePath).catch(() => "")) ||
      buildTemporaryBranchName(baseBranch, slug, undefined);

    entries.push({
      slug,
      parent_repo: safeRepoName,
      path: relativePath,
      branch,
      base_branch: baseBranch,
      base_sha: baseSha,
      created_at: await pathModifiedAt(absolutePath),
      setup_status: setupLog ? "failed" : "ready",
      ...(setupLog ? { setup_log: setupLog } : {}),
      absolutePath,
      state: setupLog ? "failed" : "ready",
      merged: branch
        ? await isBranchMerged(resolvedParentRepoDir, branch)
        : null,
    });
  }

  return entries;
}

export async function deleteTasks({
  workspaceDir,
  slugs,
  parentRepoName,
  force = false,
  dryRun = false,
}: DeleteTasksOptions): Promise<DeleteTasksResult> {
  return removeWorkspaceTasks({
    workspaceDir,
    slugs,
    parentRepoName,
    force,
    dryRun,
  });
}

export async function deleteRepositoryTasks({
  parentRepoDir,
  repoName,
  changeName,
  slugs,
  force = false,
  dryRun = false,
}: RemoveRepositoryTasksOptions): Promise<DeleteTasksResult> {
  return removeRepositoryTasks({
    parentRepoDir,
    repoName,
    changeName,
    slugs,
    force,
    dryRun,
  });
}

async function removeWorkspaceTasks({
  workspaceDir,
  slugs,
  parentRepoName,
  force,
  dryRun,
}: RemoveWorkspaceTasksOptions): Promise<DeleteTasksResult> {
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
    const absolutePath = resolveContainedPath(resolvedWorkspaceDir, entry.path);
    const parentRepoDir = resolveContainedPath(
      resolvedWorkspaceDir,
      entry.parent_repo,
    );
    const exists = await pathExists(absolutePath);

    if (!exists) {
      await withGitWorktreeLock(parentRepoDir, async () => {
        await pruneStaleWorktree(parentRepoDir);
        await deleteBranchIfPossible(parentRepoDir, entry.branch, false);
      });
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
    await withGitWorktreeLock(parentRepoDir, async () => {
      await runGit(removeArgs, { cwd: parentRepoDir, timeout: 30_000 });
      await deleteBranchIfPossible(parentRepoDir, entry.branch, force);
    });

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

async function removeRepositoryTasks({
  parentRepoDir,
  repoName,
  changeName,
  slugs,
  force,
  dryRun,
}: RemoveRepositoryTasksInternalOptions): Promise<DeleteTasksResult> {
  const resolvedParentRepoDir = path.resolve(parentRepoDir);
  const repoRootDir = path.dirname(resolvedParentRepoDir);
  const safeRepoName = validateRepositoryComponent(repoName, "Repository name");
  const safeName = validateResourceName(changeName, "Name");
  validateRequestedSlugs(slugs);

  const available = await listRepositoryTasks({
    parentRepoDir: resolvedParentRepoDir,
    repoName: safeRepoName,
    changeName: safeName,
  });
  const targets = resolveRemovalTargets(available, slugs, safeRepoName);

  if (dryRun) {
    return { removed: targets };
  }

  const removed: TaskMetadata[] = [];

  for (const entry of targets) {
    const absolutePath = resolveContainedPath(repoRootDir, entry.path);
    const exists = await pathExists(absolutePath);

    if (!exists) {
      await withGitWorktreeLock(resolvedParentRepoDir, async () => {
        await pruneStaleWorktree(resolvedParentRepoDir);
        await deleteBranchIfPossible(
          resolvedParentRepoDir,
          entry.branch,
          false,
        );
      });
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
      !(await isBranchMerged(resolvedParentRepoDir, entry.branch))
    ) {
      throw new Error(
        `Task branch "${entry.branch}" is not merged into ${entry.parent_repo}. Merge it first or pass --force.`,
      );
    }

    const removeArgs = ["worktree", "remove"];
    if (force) removeArgs.push("--force");
    removeArgs.push(absolutePath);
    await withGitWorktreeLock(resolvedParentRepoDir, async () => {
      await runGit(removeArgs, { cwd: resolvedParentRepoDir, timeout: 30_000 });
      await deleteBranchIfPossible(resolvedParentRepoDir, entry.branch, force);
    });

    if (entry.setup_log) {
      await removeRepoSetupLog(
        repoRootDir,
        resolveContainedPath(repoRootDir, entry.setup_log),
      );
    }

    removed.push(entry);
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
  repo: RepositorySource;
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
    await withGitWorktreeLock(parentRepoDir, () =>
      runGit(["worktree", "add", "-b", entry.branch, targetDir, "HEAD"], {
        cwd: parentRepoDir,
      }),
    );

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
  repo: RepositorySource;
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
  const existingSlugs = new Set(
    existingEntries
      .filter((entry) => entry.parent_repo === parentRepo.name)
      .map((entry) => entry.slug),
  );
  const planned: TaskMetadata[] = [];

  for (const slug of slugs) {
    const relativePath = path.posix.join(
      TASKS_DIRECTORY_NAME,
      parentRepo.name,
      slug,
    );
    const targetDir = resolveContainedPath(workspaceDir, relativePath);
    const branch = buildTemporaryBranchName(baseBranch, slug, branchPrefix);

    if (existingSlugs.has(slug)) {
      throw new Error(
        `Task "${slug}" is already tracked for ${parentRepo.name}.`,
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

async function planRepositoryTasks({
  repoRootDir,
  parentRepoDir,
  repoName,
  changeName,
  slugs,
  baseBranch,
  baseSha,
  branchPrefix,
}: {
  repoRootDir: string;
  parentRepoDir: string;
  repoName: string;
  changeName: string;
  slugs: readonly string[];
  baseBranch: string;
  baseSha: string;
  branchPrefix?: string;
}): Promise<TaskMetadata[]> {
  const planned: TaskMetadata[] = [];

  for (const slug of slugs) {
    const relativePath = repositoryTaskRelativePath(changeName, slug);
    const targetDir = resolveContainedPath(repoRootDir, relativePath);
    const branch = buildTemporaryBranchName(baseBranch, slug, branchPrefix);

    if (await pathExists(targetDir)) {
      throw new Error(`Target directory already exists: ${targetDir}`);
    }

    if (await branchExists(parentRepoDir, branch)) {
      throw new Error(`Branch already exists: ${branch}`);
    }

    planned.push({
      slug,
      parent_repo: repoName,
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

function repositoryTaskRelativePath(changeName: string, slug: string): string {
  return path.posix.join(TASKS_DIRECTORY_NAME, changeName, slug);
}

async function listRepositoryTaskSlugs(
  repoRootDir: string,
  changeName: string,
): Promise<string[]> {
  const taskRoot = resolveContainedPath(
    repoRootDir,
    TASKS_DIRECTORY_NAME,
    changeName,
  );
  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    entries = await fs.readdir(taskRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        return validateResourceName(entry.name, "Task name");
      } catch {
        return null;
      }
    })
    .filter((entry): entry is string => entry !== null)
    .sort((left, right) => left.localeCompare(right));
}

async function repositoryTaskSetupLog(
  repoRootDir: string,
  repoName: string,
  slug: string,
): Promise<string | undefined> {
  const relativePath = getTaskSetupLogRelativePath(repoName, slug);
  const absolutePath = resolveContainedPath(repoRootDir, relativePath);
  return (await pathExists(absolutePath)) ? relativePath : undefined;
}

async function pathModifiedAt(target: string): Promise<string> {
  try {
    const stat = await fs.stat(target);
    return stat.mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
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

async function withGitWorktreeLock<T>(
  repoDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const { stdout } = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: repoDir },
  );
  const gitCommonDir = stdout.trim() || path.join(repoDir, ".git");

  const lockPath = path.join(gitCommonDir, GIT_WORKTREE_LOCK_FILENAME);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + GIT_WORKTREE_LOCK_TIMEOUT_MS;
  let lockHandle: Awaited<ReturnType<typeof fs.open>> | undefined;

  while (!lockHandle) {
    try {
      lockHandle = await fs.open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      if (await removeStaleGitWorktreeLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for git worktree lock at ${lockPath}`,
        );
      }
      await delay(GIT_WORKTREE_LOCK_RETRY_MS);
    }
  }

  try {
    return await operation();
  } finally {
    await lockHandle.close();
    await fs.rm(lockPath, { force: true });
  }
}

async function removeStaleGitWorktreeLock(lockPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs <= GIT_WORKTREE_LOCK_STALE_MS) {
      return false;
    }
    await fs.rm(lockPath, { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }
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
  return isBranchMerged(parentRepoDir, entry.branch);
}

async function isBranchMerged(
  parentRepoDir: string,
  branch: string,
): Promise<boolean> {
  try {
    await runGit(["merge-base", "--is-ancestor", branch, "HEAD"], {
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
