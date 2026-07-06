import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "@wf-plugin/core";
import { loadWorkspaceConfig } from "../config.ts";
import {
  preserveNodeModules,
  restoreNodeModules,
  rollbackPreservedNodeModules,
} from "../node-modules-cache.ts";
import { validateRepositoryComponent } from "../repository-components.ts";
import type { ServiceEventSink } from "../services/events.ts";
import { runGit } from "../services/git.ts";
import {
  runSingleRepoInitializers,
  type SingleRepoInitializerState,
} from "../services/initializers/index.ts";
import {
  addWorktree,
  branchExists,
  deleteBranchIfPossible,
  isGitDirty,
  removeWorktree,
  requireCurrentBranch,
  withGitWorktreeLock,
} from "../services/worktree.ts";
import type {
  RepositorySource,
  TaskMetadata,
  WorkspaceMetadata,
  WorkspaceRepoMetadata,
} from "../types.ts";
import { presentPipelines } from "../ui/grid-consumer.ts";
import { buildBranchName } from "../utils/branch-prefix.ts";
import {
  resolveContainedPath,
  validateResourceName,
} from "../utils/path-safety.ts";
import { isSlug } from "../utils/slug.ts";
import {
  appendTasks,
  getTaskSetupLogRelativePath,
  readWorkspaceMetadata,
  removeTasks as removeTaskMetadata,
} from "./metadata.ts";
import { TASKS_DIRECTORY_NAME } from "./paths.ts";
import {
  mapInitializerStateToPipelineState,
  mapTaskStateToPipelineState,
  type RepoPipelineState,
} from "./pipeline.ts";
import {
  appendRepoSetupLog,
  getRepoSetupLogPath,
  startRepoSetupLog,
} from "./setup-logs.ts";

export type TaskCreateResult = {
  slug: string;
  parentRepo: string;
  path: string;
  branch: string;
  setupStatus: "ready" | "failed" | "skipped";
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
  setup?: boolean;
  disabledInitializers?: boolean | string[];
  /** Render the setup grid when the terminal supports it (default false). */
  interactive?: boolean;
  onEvent?: ServiceEventSink;
};

export type CreateTasksResult = {
  created: TaskCreateResult[];
  failures: TaskFailure[];
};

export type TaskListEntry = TaskMetadata & {
  absolutePath: string;
  state: "ready" | "failed" | "skipped" | "stale";
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
  setup?: boolean;
  disabledInitializers?: boolean | string[];
  /** Render the setup grid when the terminal supports it (default false). */
  interactive?: boolean;
  onEvent?: ServiceEventSink;
};

export type RepositoryTasksOptions = {
  parentRepoDir: string;
  repoName: string;
  changeName: string;
};

export type RemoveRepositoryTasksOptions = RepositoryTasksOptions & {
  repo?: RepositorySource;
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
  repo?: RepositorySource;
  slugs: readonly string[];
  force: boolean;
  dryRun: boolean;
};

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
  setup = false,
  disabledInitializers,
  interactive = false,
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

  const baseBranch = await requireCurrentBranch(resolvedSourceRepoDir);
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
        setupStatus: setup ? entry.setup_status : "skipped",
      })),
      failures: [],
    };
  }

  const repoConfig = workspaceRepoToRepoConfig(parentRepo);
  const createdBySlug = new Map<string, TaskCreateResult>();
  const failureBySlug = new Map<string, Error>();
  const tasks = new Map(
    planned.map((entry) => [
      entry.slug,
      createAndSetupTask({
        workspaceDir: resolvedWorkspaceDir,
        parentRepoDir: resolvedSourceRepoDir,
        repo: repoConfig,
        entry,
        setup,
        ...(disabledInitializers !== undefined ? { disabledInitializers } : {}),
        recordResult: (result) => createdBySlug.set(result.slug, result),
        recordFailure: (slug, error) => failureBySlug.set(slug, error),
      }),
    ]),
  );

  await presentTaskPipelines({
    pipelines: tasks,
    interactive,
    workspaceDir: resolvedWorkspaceDir,
    parentRepoName,
    ...(onEvent ? { onEvent } : {}),
  });

  const created = [...createdBySlug.values()];
  const failures: TaskFailure[] = [...failureBySlug].map(([slug, error]) => ({
    slug,
    error,
  }));

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
  setup = false,
  disabledInitializers,
  interactive = false,
  onEvent,
}: CreateRepositoryTasksOptions): Promise<CreateTasksResult> {
  const resolvedParentRepoDir = path.resolve(parentRepoDir);
  const repoRootDir = path.dirname(resolvedParentRepoDir);
  const repoName = validateRepositoryComponent(repo.name, "Repository name");
  const safeName = validateResourceName(changeName, "Name");
  validateRequestedSlugs(slugs);

  const baseBranch = await requireCurrentBranch(resolvedParentRepoDir);
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
        setupStatus: setup ? entry.setup_status : "skipped",
      })),
      failures: [],
    };
  }

  const createdBySlug = new Map<string, TaskCreateResult>();
  const failureBySlug = new Map<string, Error>();
  const tasks = new Map(
    planned.map((entry) => [
      entry.slug,
      createAndSetupTask({
        workspaceDir: repoRootDir,
        parentRepoDir: resolvedParentRepoDir,
        repo,
        entry,
        setup,
        ...(disabledInitializers !== undefined ? { disabledInitializers } : {}),
        recordResult: (result) => createdBySlug.set(result.slug, result),
        recordFailure: (slug, error) => failureBySlug.set(slug, error),
      }),
    ]),
  );

  await presentTaskPipelines({
    pipelines: tasks,
    interactive,
    workspaceDir: repoRootDir,
    parentRepoName: repoName,
    ...(onEvent ? { onEvent } : {}),
  });

  const created = [...createdBySlug.values()];
  const failures: TaskFailure[] = [...failureBySlug].map(([slug, error]) => ({
    slug,
    error,
  }));

  return { created, failures };
}

/**
 * Route task fan-out through the shared {@link presentPipelines} seam: the grid
 * when interactive, else an inline event drain. Task results are captured
 * out-of-band via the recordResult/recordFailure callbacks the pipelines were
 * built with, so the completed-map presentPipelines returns is discarded here.
 */
async function presentTaskPipelines({
  pipelines,
  interactive,
  workspaceDir,
  parentRepoName,
  onEvent,
}: {
  pipelines: Map<string, AsyncGenerator<RepoPipelineState>>;
  interactive: boolean;
  workspaceDir: string;
  parentRepoName: string;
  onEvent?: ServiceEventSink;
}): Promise<void> {
  await presentPipelines({
    pipelines,
    repoNames: [...pipelines.keys()],
    interactive,
    getLogPath: (slug) =>
      getRepoSetupLogPath({
        workspaceDir,
        repoName: `${parentRepoName}-${slug}`,
      }),
    ...(onEvent ? { onEvent } : {}),
  });
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

  const baseBranch = await requireCurrentBranch(resolvedParentRepoDir).catch(
    () => "HEAD",
  );
  const baseSha = await getCurrentSha(resolvedParentRepoDir).catch(() => "");
  const entries: TaskListEntry[] = [];

  for (const slug of slugs) {
    const relativePath = repositoryTaskRelativePath(safeName, slug);
    const absolutePath = resolveContainedPath(repoRootDir, relativePath);
    const setup = await repositoryTaskSetupStatus(
      repoRootDir,
      safeRepoName,
      slug,
    );
    const branch =
      (await requireCurrentBranch(absolutePath).catch(() => "")) ||
      buildTemporaryBranchName(baseBranch, slug, undefined);

    entries.push({
      slug,
      parent_repo: safeRepoName,
      path: relativePath,
      branch,
      base_branch: baseBranch,
      base_sha: baseSha,
      created_at: await pathModifiedAt(absolutePath),
      setup_status: setup.status,
      ...(setup.logPath ? { setup_log: setup.logPath } : {}),
      absolutePath,
      state: setup.status,
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
  repo,
  slugs,
  force = false,
  dryRun = false,
}: RemoveRepositoryTasksOptions): Promise<DeleteTasksResult> {
  return removeRepositoryTasks({
    parentRepoDir,
    repoName,
    changeName,
    ...(repo ? { repo } : {}),
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
  const reposByName = new Map(
    metadata.repos.map((repo) => [repo.name, workspaceRepoToRepoConfig(repo)]),
  );
  const { config } = await loadWorkspaceConfig();

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

    const repo = reposByName.get(entry.parent_repo);
    const preserved = repo
      ? await preserveNodeModules({
          repo,
          repoDir: absolutePath,
          config: config.cache?.nodeModules,
        })
      : { status: "missing" as const };

    await withGitWorktreeLock(parentRepoDir, async () => {
      try {
        for await (const _state of removeWorktree({
          gitDir: parentRepoDir,
          worktreePath: absolutePath,
          force,
          lock: false,
          timeoutMs: 30_000,
        })) {
          // Drained; task removal does not surface per-step progress.
        }
      } catch (error) {
        await rollbackPreservedNodeModules(preserved);
        throw error;
      }
      await deleteBranchIfPossible(parentRepoDir, entry.branch, force);
    });

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
  repo,
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
  const { config } = await loadWorkspaceConfig();

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

    const preserved = repo
      ? await preserveNodeModules({
          repo,
          repoDir: absolutePath,
          config: config.cache?.nodeModules,
        })
      : { status: "missing" as const };

    await withGitWorktreeLock(resolvedParentRepoDir, async () => {
      try {
        for await (const _state of removeWorktree({
          gitDir: resolvedParentRepoDir,
          worktreePath: absolutePath,
          force,
          lock: false,
          timeoutMs: 30_000,
        })) {
          // Drained; task removal does not surface per-step progress.
        }
      } catch (error) {
        await rollbackPreservedNodeModules(preserved);
        throw error;
      }
      await deleteBranchIfPossible(resolvedParentRepoDir, entry.branch, force);
    });

    removed.push(entry);
  }

  return { removed };
}

/**
 * Set up one task worktree, emitting {@link RepoPipelineState} so the same grid
 * (and console drain) that renders `wf new` renders task fan-out too. The task
 * result carries richer data than the pipeline state (setup status + log), so it
 * is recorded through `recordResult`/`recordFailure` side channels rather than
 * the generator's yielded states.
 */
async function* createAndSetupTask({
  workspaceDir,
  parentRepoDir,
  repo,
  entry,
  setup,
  disabledInitializers,
  recordResult,
  recordFailure,
}: {
  workspaceDir: string;
  parentRepoDir: string;
  repo: RepositorySource;
  entry: TaskMetadata;
  setup: boolean;
  disabledInitializers?: boolean | string[];
  recordResult: (result: TaskCreateResult) => void;
  recordFailure: (slug: string, error: Error) => void;
}): AsyncGenerator<RepoPipelineState> {
  const targetDir = resolveContainedPath(workspaceDir, entry.path);

  try {
    // Task worktrees branch from the parent checkout's HEAD (the in-progress
    // feature tip), not the mirror's default branch, so parallel agents build
    // on committed progress. The lock is shared with every other worktree path.
    for await (const state of addWorktree({
      gitDir: parentRepoDir,
      targetDir,
      base: { ref: "HEAD" },
      branch: { kind: "create", name: entry.branch },
      label: `worktree:${entry.slug}`,
    })) {
      const mapped = mapTaskStateToPipelineState(state, "worktree");
      if (mapped) yield mapped;
    }

    if (!setup) {
      recordResult({
        slug: entry.slug,
        parentRepo: entry.parent_repo,
        path: targetDir,
        branch: entry.branch,
        setupStatus: "skipped",
      });
      yield { phase: "complete", hasLockfile: false };
      return;
    }

    const { config } = await loadWorkspaceConfig();
    const restoreResult = await restoreNodeModules({
      repo,
      repoDir: targetDir,
      config: config.cache?.nodeModules,
      ...(disabledInitializers !== undefined ? { disabledInitializers } : {}),
    });
    if (restoreResult.status === "restored") {
      yield {
        phase: "git",
        step: "worktree",
        status: "log",
        message: `${repo.name}-${entry.slug}: restored pooled node_modules`,
      };
    } else if (restoreResult.status === "warning") {
      yield {
        phase: "git",
        step: "worktree",
        status: "log",
        message: restoreResult.warning,
      };
    }

    const result = yield* runTaskInitializers({
      workspaceDir,
      repo,
      slug: entry.slug,
      targetDir,
      ...(disabledInitializers !== undefined ? { disabledInitializers } : {}),
    });

    recordResult({
      slug: entry.slug,
      parentRepo: entry.parent_repo,
      path: targetDir,
      branch: entry.branch,
      setupStatus: result.status,
      setupLog: getTaskSetupLogRelativePath(entry.parent_repo, entry.slug),
    });
    yield { phase: "complete", hasLockfile: false };
  } catch (error) {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    recordFailure(entry.slug, normalized);
    yield { phase: "failed", error: normalized };
  }
}

async function* runTaskInitializers({
  workspaceDir,
  repo,
  slug,
  targetDir,
  disabledInitializers,
}: {
  workspaceDir: string;
  repo: RepositorySource;
  slug: string;
  targetDir: string;
  disabledInitializers?: boolean | string[];
}): AsyncGenerator<
  RepoPipelineState,
  { status: "ready" | "failed"; logPath?: string }
> {
  const logPath = await startRepoSetupLog({
    workspaceDir,
    repoName: `${repo.name}-${slug}`,
    repoDir: targetDir,
  });
  let failed = false;

  for await (const state of runSingleRepoInitializers({
    context: {
      repoDir: targetDir,
      workspaceDir,
      repo,
    },
    ...(disabledInitializers !== undefined ? { disabledInitializers } : {}),
  })) {
    await appendRepoSetupLog(logPath, formatInitializerState(state));

    if (state.phase === "running" && state.state.status === "failed") {
      failed = true;
    }

    const mapped = mapInitializerStateToPipelineState(state);
    if (mapped) yield mapped;
  }

  if (!failed) {
    return { status: "ready", logPath };
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

async function repositoryTaskSetupStatus(
  repoRootDir: string,
  repoName: string,
  slug: string,
): Promise<{ status: "ready" | "failed" | "skipped"; logPath?: string }> {
  const relativePath = getTaskSetupLogRelativePath(repoName, slug);
  const absolutePath = resolveContainedPath(repoRootDir, relativePath);
  if (!(await pathExists(absolutePath))) {
    return { status: "skipped" };
  }

  const log = await fs.readFile(absolutePath, "utf8");
  return {
    status: latestSetupLogSectionFailed(log) ? "failed" : "ready",
    logPath: relativePath,
  };
}

function latestSetupLogSectionFailed(log: string): boolean {
  const latestHeaderIndex = log.lastIndexOf("# workforest repo setup log");
  const latest = latestHeaderIndex === -1 ? log : log.slice(latestHeaderIndex);
  return (
    /^\[initializer:[^\]]+\] failed:/m.test(latest) ||
    /^\[failed/m.test(latest) ||
    /^\[thrown\]/m.test(latest)
  );
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

async function getCurrentSha(repoDir: string): Promise<string> {
  const { stdout } = await runGit(["rev-parse", "HEAD"], { cwd: repoDir });
  return stdout.trim();
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
