import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { validateRepositoryComponent } from "../repository-components.ts";
import { applyTemplateGenerator } from "../templates/apply.ts";
import { loadTemplate } from "../templates/index.ts";
import type { RepoConfig } from "../types.ts";
import { resolveContainedPath } from "../utils/path-safety.ts";
import { terminateRunningCommands } from "../utils/task-generator.ts";
import { readWorkspaceMetadata, updateWorkspaceRepo } from "./metadata.ts";
import {
  type RepoPipelineState,
  repoInitializationGenerator,
} from "./pipeline.ts";
import { getRepoSetupLogPath, withRepoSetupLog } from "./setup-logs.ts";

const INITIALIZATION_DIR = "initialization";
const WORKSPACE_STATE_FILENAME = "workspace.json";
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;
const QUEUED_STALE_MS = 2_000;
export const REPO_INITIALIZER_WORKER = "repo-initializer";

export type RepoInitializationStatus =
  | "pending"
  | "git"
  | "queued"
  | "running"
  | "ready"
  | "failed"
  | "cancelled";

export type RepoInitializationState = {
  version: 1;
  repo: string;
  status: RepoInitializationStatus;
  phase?: "git" | "initializer";
  step?: string;
  message?: string;
  error?: string;
  pid?: number;
  run_id?: string;
  has_lockfile?: boolean;
  attempt: number;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
};

export type WorkspaceInitializationStatus =
  | "creating"
  | "initializing"
  | "hooks"
  | "ready"
  | "failed"
  | "cancelled";

export type WorkspaceInitializationState = {
  version: 1;
  status: WorkspaceInitializationStatus;
  message?: string;
  current_hook?: string;
  error?: string;
  warnings?: string[];
  updated_at: string;
  completed_at?: string;
};

export type StartRepoInitializationOptions = {
  workspaceDir: string;
  repo: RepoConfig;
  disabledInitializers?: boolean | string[];
};

type WorkerLaunch = (options: {
  workspaceDir: string;
  repoName: string;
  runId: string;
}) => Promise<number>;

export function buildRepoInitializerWorkerEnvironment({
  workspaceDir,
  repoName,
  runId,
  environment = process.env,
}: {
  workspaceDir: string;
  repoName: string;
  runId: string;
  environment?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  return {
    ...environment,
    WORKFOREST_BACKGROUND_WORKER: "1",
    WORKFOREST_WORKER: REPO_INITIALIZER_WORKER,
    WORKFOREST_WORKER_WORKSPACE: workspaceDir,
    WORKFOREST_WORKER_REPO: repoName,
    WORKFOREST_WORKER_RUN_ID: runId,
  };
}

export async function initializeWorkspaceInitialization({
  workspaceDir,
  repos,
}: {
  workspaceDir: string;
  repos: readonly RepoConfig[];
}): Promise<void> {
  await fs.mkdir(getInitializationDir(workspaceDir), { recursive: true });
  const now = new Date().toISOString();

  await writeWorkspaceInitializationState(workspaceDir, {
    version: 1,
    status: "creating",
    message: "Creating repository worktrees",
    updated_at: now,
  });

  await Promise.all(
    repos.map((repo) =>
      writeRepoInitializationState(workspaceDir, {
        version: 1,
        repo: repo.name,
        status: "pending",
        attempt: 0,
        created_at: now,
        updated_at: now,
      }),
    ),
  );
}

export async function readRepoInitializationState(
  workspaceDir: string,
  repoName: string,
): Promise<RepoInitializationState | null> {
  const state = await readJsonFile<RepoInitializationState>(
    getRepoStatePath(workspaceDir, repoName),
  );
  if (!state) return null;

  if (
    (state.status === "running" || state.status === "queued") &&
    state.pid !== undefined &&
    !isProcessAlive(state.pid) &&
    (state.status === "running" ||
      Date.now() - Date.parse(state.updated_at) > QUEUED_STALE_MS)
  ) {
    return updateRepoInitializationState(workspaceDir, repoName, (current) => {
      if (
        current.run_id !== state.run_id ||
        (current.status !== "running" && current.status !== "queued")
      ) {
        return current;
      }

      const now = new Date().toISOString();
      return {
        ...current,
        status: "failed",
        error: "Background initializer exited unexpectedly.",
        message: "Background initializer exited unexpectedly",
        completed_at: now,
        updated_at: now,
      };
    });
  }

  return state;
}

export async function readRepoInitializationStates(
  workspaceDir: string,
): Promise<RepoInitializationState[]> {
  const metadata = await readWorkspaceMetadata(workspaceDir);
  if (!metadata) return [];

  const states = await Promise.all(
    metadata.repos.map((repo) =>
      readRepoInitializationState(workspaceDir, repo.name),
    ),
  );

  return states.filter(
    (state): state is RepoInitializationState => state !== null,
  );
}

export async function readWorkspaceInitializationState(
  workspaceDir: string,
): Promise<WorkspaceInitializationState | null> {
  return readJsonFile<WorkspaceInitializationState>(
    getWorkspaceStatePath(workspaceDir),
  );
}

export async function* watchRepoInitialization({
  workspaceDir,
  repoName,
  includeExistingLog = false,
  pollIntervalMs = 100,
}: {
  workspaceDir: string;
  repoName: string;
  includeExistingLog?: boolean;
  pollIntervalMs?: number;
}): AsyncGenerator<RepoPipelineState> {
  const logPath = await getRepoInitializationLogPath(workspaceDir, repoName);
  let logOffset = includeExistingLog
    ? Math.max((await fileSize(logPath)) - 64 * 1024, 0)
    : await fileSize(logPath);
  let lastUpdatedAt: string | undefined;

  while (true) {
    const logChunk = await readLogChunk(logPath, logOffset);
    logOffset = logChunk.offset;
    if (logChunk.contents) {
      yield {
        phase: "initializer",
        name: "output",
        status: "output",
        output: logChunk.contents,
      };
    }

    const state = await readRepoInitializationState(workspaceDir, repoName);
    if (!state) {
      yield {
        phase: "failed",
        error: new Error(`Initialization state disappeared for "${repoName}".`),
        step: "initializer:status",
      };
      return;
    }

    if (state.updated_at !== lastUpdatedAt) {
      lastUpdatedAt = state.updated_at;
      const pipelineState = mapPersistentStateToPipelineState(state);
      if (pipelineState) yield pipelineState;
    }

    if (state.status === "ready") {
      yield {
        phase: "complete",
        hasLockfile: state.has_lockfile ?? false,
      };
      return;
    }
    if (state.status === "failed") {
      yield {
        phase: "failed",
        error: new Error(
          state.error ?? state.message ?? "Initialization failed",
        ),
        ...(state.step ? { step: state.step } : {}),
      };
      return;
    }
    if (state.status === "cancelled") {
      yield {
        phase: "cancelled",
        ...(state.message ? { message: state.message } : {}),
      };
      return;
    }

    await delay(pollIntervalMs);
  }
}

export async function recordRepoGitState(
  workspaceDir: string,
  repoName: string,
  state: Extract<RepoPipelineState, { phase: "git" }>,
): Promise<void> {
  await updateRepoInitializationState(workspaceDir, repoName, (current) => {
    if (isTerminalRepoStatus(current.status)) return current;

    return {
      ...current,
      status: "git",
      phase: "git",
      step: state.step,
      ...(state.message ? { message: state.message } : {}),
      updated_at: new Date().toISOString(),
    };
  });
}

export async function recordRepoSetupFailure(
  workspaceDir: string,
  repoName: string,
  error: Error,
  step?: string,
): Promise<void> {
  const now = new Date().toISOString();
  await updateRepoInitializationState(workspaceDir, repoName, (current) => ({
    ...current,
    status: "failed",
    ...(step ? { step } : {}),
    message: error.message,
    error: error.message,
    completed_at: now,
    updated_at: now,
  }));
}

export async function markWorkspaceInitializing(
  workspaceDir: string,
): Promise<void> {
  await updateWorkspaceInitializationState(workspaceDir, () => ({
    version: 1,
    status: "initializing",
    message: "Repository initialization continues in the background",
    updated_at: new Date().toISOString(),
  }));
}

export async function startRepoInitialization(
  options: StartRepoInitializationOptions,
  launchWorker: WorkerLaunch = launchDetachedWorker,
): Promise<RepoInitializationState> {
  const previous = await readRepoInitializationState(
    options.workspaceDir,
    options.repo.name,
  );
  const runId = randomUUID();
  const now = new Date().toISOString();
  const queued: RepoInitializationState = {
    version: 1,
    repo: options.repo.name,
    status: "queued",
    phase: "initializer",
    step: "initializer:queued",
    message: "Waiting for background initializer",
    run_id: runId,
    attempt: (previous?.attempt ?? 0) + 1,
    created_at: previous?.created_at ?? now,
    updated_at: now,
  };

  await writeRepoInitializationState(options.workspaceDir, queued);
  await markWorkspaceInitializing(options.workspaceDir);

  try {
    const pid = await launchWorker({
      workspaceDir: options.workspaceDir,
      repoName: options.repo.name,
      runId,
    });

    return updateRepoInitializationState(
      options.workspaceDir,
      options.repo.name,
      (current) =>
        current.run_id === runId
          ? {
              ...current,
              pid,
              updated_at: new Date().toISOString(),
            }
          : current,
    );
  } catch (error) {
    const setupError =
      error instanceof Error ? error : new Error(String(error));
    await recordRepoSetupFailure(
      options.workspaceDir,
      options.repo.name,
      setupError,
      "initializer:launch",
    );
    throw setupError;
  }
}

export async function runRepoInitializationWorker({
  workspaceDir,
  repoName,
  runId,
}: {
  workspaceDir: string;
  repoName: string;
  runId: string;
}): Promise<void> {
  const metadata = await readWorkspaceMetadata(workspaceDir);
  const repoMetadata = metadata?.repos.find((repo) => repo.name === repoName);
  if (!metadata || !repoMetadata) {
    throw new Error(`Workspace repository not found: ${repoName}`);
  }

  const repo: RepoConfig = {
    name: repoMetadata.name,
    remote: repoMetadata.remote,
    defaultBranch: repoMetadata.default_branch,
  };
  const template = metadata.workspace.template_id
    ? await loadTemplate(metadata.workspace.template_id)
    : null;
  let stopping = false;
  let checkingCancellation = false;

  const cancel = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await terminateRunningCommands();
    await markRepoCancelled(workspaceDir, repoName, runId);
    await finalizeWorkspaceInitialization(workspaceDir);
    process.exit(0);
  };
  const onSignal = (): void => {
    void cancel();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  const cancellationTimer = setInterval(() => {
    if (checkingCancellation || stopping) return;
    checkingCancellation = true;
    void readRepoInitializationState(workspaceDir, repoName)
      .then(async (state) => {
        if (
          state?.run_id === runId &&
          state.status === "cancelled" &&
          !stopping
        ) {
          await cancel();
        }
      })
      .finally(() => {
        checkingCancellation = false;
      });
  }, 100);

  try {
    const started = await updateRepoInitializationState(
      workspaceDir,
      repoName,
      (current) => {
        if (current.run_id !== runId || current.status === "cancelled") {
          return current;
        }

        const now = new Date().toISOString();
        return {
          ...current,
          status: "running",
          phase: "initializer",
          step: "initializer:detection",
          message: "Detecting project type",
          pid: process.pid,
          started_at: now,
          updated_at: now,
        };
      },
    );

    if (started.run_id !== runId || started.status === "cancelled") {
      await finalizeWorkspaceInitialization(workspaceDir);
      return;
    }

    const pipeline = withRepoSetupLog(
      repoInitializationGenerator({
        repo,
        workspaceDir,
        ...(template?.config.disableInitializers !== undefined
          ? { disabledInitializers: template.config.disableInitializers }
          : {}),
      }),
      {
        workspaceDir,
        repoName,
        repoDir: resolveContainedPath(
          workspaceDir,
          validateRepositoryComponent(repoName, "Repository name"),
        ),
      },
    );

    for await (const state of pipeline) {
      if (stopping) return;
      await recordWorkerPipelineState(workspaceDir, repo, runId, state);
    }

    await finalizeWorkspaceInitialization(workspaceDir);
  } finally {
    clearInterval(cancellationTimer);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

export async function cancelRepoInitializations(
  workspaceDir: string,
  repoNames: readonly string[],
): Promise<RepoInitializationState[]> {
  const results: RepoInitializationState[] = [];

  for (const repoName of repoNames) {
    const state = await readRepoInitializationState(workspaceDir, repoName);
    if (!state) {
      throw new Error(`No initialization state found for "${repoName}".`);
    }
    if (state.status !== "queued" && state.status !== "running") {
      throw new Error(
        `Cannot cancel "${repoName}" because it is ${state.status}.`,
      );
    }

    const cancelled = await markRepoCancelled(
      workspaceDir,
      repoName,
      state.run_id,
    );
    results.push(cancelled);
  }

  return results;
}

export async function retryRepoInitializations(
  workspaceDir: string,
  repoNames: readonly string[],
  launchWorker: WorkerLaunch = launchDetachedWorker,
): Promise<RepoInitializationState[]> {
  const metadata = await readWorkspaceMetadata(workspaceDir);
  if (!metadata) {
    throw new Error(`Workspace metadata not found: ${workspaceDir}`);
  }

  const results: RepoInitializationState[] = [];
  for (const repoName of repoNames) {
    const current = await readRepoInitializationState(workspaceDir, repoName);
    if (!current) {
      throw new Error(`No initialization state found for "${repoName}".`);
    }
    if (current.status !== "failed" && current.status !== "cancelled") {
      throw new Error(
        `Cannot retry "${repoName}" because it is ${current.status}.`,
      );
    }

    const repoMetadata = metadata.repos.find((repo) => repo.name === repoName);
    if (!repoMetadata) {
      throw new Error(`Workspace repository not found: ${repoName}`);
    }

    results.push(
      await startRepoInitialization(
        {
          workspaceDir,
          repo: {
            name: repoMetadata.name,
            remote: repoMetadata.remote,
            defaultBranch: repoMetadata.default_branch,
          },
        },
        launchWorker,
      ),
    );
  }

  return results;
}

export async function finalizeWorkspaceInitialization(
  workspaceDir: string,
): Promise<void> {
  await withExclusiveLock(getFinalizeLockPath(workspaceDir), async () => {
    const workspaceState = await readWorkspaceInitializationState(workspaceDir);
    if (
      workspaceState?.status === "ready" ||
      workspaceState?.status === "failed" ||
      workspaceState?.status === "cancelled"
    ) {
      return;
    }

    const states = await readRepoInitializationStates(workspaceDir);
    if (
      states.length === 0 ||
      states.some((state) => !isTerminalRepoStatus(state.status))
    ) {
      return;
    }

    const metadata = await readWorkspaceMetadata(workspaceDir);
    if (!metadata) return;

    const warnings: string[] = [];
    const failedRepos = states.filter((state) => state.status === "failed");
    const cancelledRepos = states.filter(
      (state) => state.status === "cancelled",
    );
    const template = metadata.workspace.template_id
      ? await loadTemplate(metadata.workspace.template_id)
      : null;

    if (template?.config.hooks && template.config.hooks.length > 0) {
      await updateWorkspaceInitializationState(workspaceDir, (current) => ({
        ...current,
        status: "hooks",
        message: "Running workspace hooks",
        updated_at: new Date().toISOString(),
      }));

      const hookLogPath = path.join(
        getInitializationDir(workspaceDir),
        "hooks.log",
      );
      await fs.rm(hookLogPath, { force: true });

      try {
        for await (const hookState of applyTemplateGenerator({
          template,
          workspaceDir,
          repoDirs: states
            .filter((state) => state.status === "ready")
            .map((state) => state.repo),
        })) {
          if (hookState.phase === "hook-start") {
            await updateWorkspaceInitializationState(
              workspaceDir,
              (current) => ({
                ...current,
                current_hook: hookState.hookName,
                message: `Running hook: ${hookState.hookName}`,
                updated_at: new Date().toISOString(),
              }),
            );
            await fs.appendFile(
              hookLogPath,
              `[hook:${hookState.hookName}] started\n`,
              "utf8",
            );
          } else if (hookState.phase === "hook") {
            const task = hookState.state;
            if (task.status === "output") {
              await fs.appendFile(hookLogPath, task.data, "utf8");
            } else if (task.status === "log" && task.level === "warn") {
              warnings.push(task.message);
              await fs.appendFile(
                hookLogPath,
                `[warning] ${task.message}\n`,
                "utf8",
              );
            } else if (task.status === "failed") {
              await fs.appendFile(
                hookLogPath,
                `[failed] ${task.error.message}\n`,
                "utf8",
              );
            }
          }
        }
      } catch (error) {
        const hookError =
          error instanceof Error ? error : new Error(String(error));
        await writeWorkspaceInitializationState(workspaceDir, {
          version: 1,
          status: "failed",
          message: "Workspace hook failed",
          error: hookError.message,
          ...(warnings.length > 0 ? { warnings } : {}),
          updated_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        });
        return;
      }
    }

    const now = new Date().toISOString();
    const status: WorkspaceInitializationStatus =
      failedRepos.length > 0
        ? "failed"
        : cancelledRepos.length > 0
          ? "cancelled"
          : "ready";
    const message =
      status === "ready"
        ? "All repository initialization completed"
        : status === "failed"
          ? `${failedRepos.length} repository initializer${failedRepos.length === 1 ? "" : "s"} failed`
          : `${cancelledRepos.length} repository initializer${cancelledRepos.length === 1 ? "" : "s"} cancelled`;

    await writeWorkspaceInitializationState(workspaceDir, {
      version: 1,
      status,
      message,
      ...(warnings.length > 0 ? { warnings } : {}),
      updated_at: now,
      completed_at: now,
    });
  });
}

export function getInitializationDir(workspaceDir: string): string {
  return path.join(workspaceDir, ".workforest", INITIALIZATION_DIR);
}

export function getRepoInitializationLogPath(
  workspaceDir: string,
  repoName: string,
): Promise<string> {
  return getRepoSetupLogPath({ workspaceDir, repoName });
}

function getRepoStatePath(workspaceDir: string, repoName: string): string {
  const safeRepoName = validateRepositoryComponent(repoName, "Repository name");
  return path.join(
    getInitializationDir(workspaceDir),
    "repos",
    `${encodeURIComponent(safeRepoName)}.json`,
  );
}

function getWorkspaceStatePath(workspaceDir: string): string {
  return path.join(
    getInitializationDir(workspaceDir),
    WORKSPACE_STATE_FILENAME,
  );
}

function getFinalizeLockPath(workspaceDir: string): string {
  return path.join(getInitializationDir(workspaceDir), "finalize.lock");
}

async function launchDetachedWorker({
  workspaceDir,
  repoName,
  runId,
}: {
  workspaceDir: string;
  repoName: string;
  runId: string;
}): Promise<number> {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    throw new Error("Unable to resolve the workforest CLI entrypoint.");
  }

  const child = spawn(process.execPath, [path.resolve(entrypoint)], {
    cwd: workspaceDir,
    detached: true,
    stdio: "ignore",
    env: buildRepoInitializerWorkerEnvironment({
      workspaceDir,
      repoName,
      runId,
    }),
  });

  await waitForSpawn(child);
  if (child.pid === undefined) {
    throw new Error(`Failed to launch initializer for "${repoName}".`);
  }
  child.unref();
  return child.pid;
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

async function recordWorkerPipelineState(
  workspaceDir: string,
  repo: RepoConfig,
  runId: string,
  state: RepoPipelineState,
): Promise<void> {
  if (state.phase === "initializer") {
    await updateRepoInitializationState(workspaceDir, repo.name, (current) => {
      if (
        current.run_id !== runId ||
        current.status === "cancelled" ||
        current.status === "failed"
      ) {
        return current;
      }

      return {
        ...current,
        status: "running",
        phase: "initializer",
        step: `initializer:${state.name}`,
        ...(state.message ? { message: state.message } : {}),
        updated_at: new Date().toISOString(),
      };
    });
    return;
  }

  if (state.phase === "complete") {
    const now = new Date().toISOString();
    await updateRepoInitializationState(workspaceDir, repo.name, (current) => {
      if (current.run_id !== runId || current.status === "cancelled") {
        return current;
      }
      return {
        ...current,
        status: "ready",
        message: "Initialization complete",
        has_lockfile: state.hasLockfile,
        completed_at: now,
        updated_at: now,
      };
    });
    const featureBranch = await repoMetadataFeatureBranch(
      workspaceDir,
      repo.name,
    );
    await updateWorkspaceRepo(workspaceDir, {
      name: repo.name,
      remote: repo.remote,
      default_branch: repo.defaultBranch,
      has_lockfile: state.hasLockfile,
      ...(featureBranch ? { feature_branch: featureBranch } : {}),
    });
    return;
  }

  if (state.phase === "failed") {
    const now = new Date().toISOString();
    await updateRepoInitializationState(workspaceDir, repo.name, (current) => {
      if (current.run_id !== runId || current.status === "cancelled") {
        return current;
      }
      return {
        ...current,
        status: "failed",
        ...(state.step ? { step: state.step } : {}),
        message: state.error.message,
        error: state.error.message,
        completed_at: now,
        updated_at: now,
      };
    });
  }
}

async function markRepoCancelled(
  workspaceDir: string,
  repoName: string,
  runId?: string,
): Promise<RepoInitializationState> {
  const now = new Date().toISOString();
  return updateRepoInitializationState(workspaceDir, repoName, (current) => {
    if (runId !== undefined && current.run_id !== runId) {
      return current;
    }
    return {
      ...current,
      status: "cancelled",
      message: "Initialization cancelled",
      completed_at: now,
      updated_at: now,
    };
  });
}

async function updateRepoInitializationState(
  workspaceDir: string,
  repoName: string,
  update: (state: RepoInitializationState) => RepoInitializationState,
): Promise<RepoInitializationState> {
  const statePath = getRepoStatePath(workspaceDir, repoName);
  return withExclusiveLock(`${statePath}.lock`, async () => {
    const current = await readJsonFile<RepoInitializationState>(statePath);
    if (!current) {
      throw new Error(`No initialization state found for "${repoName}".`);
    }
    const next = update(current);
    await writeJsonFile(statePath, next);
    return next;
  });
}

async function writeRepoInitializationState(
  workspaceDir: string,
  state: RepoInitializationState,
): Promise<void> {
  const statePath = getRepoStatePath(workspaceDir, state.repo);
  await withExclusiveLock(`${statePath}.lock`, () =>
    writeJsonFile(statePath, state),
  );
}

async function updateWorkspaceInitializationState(
  workspaceDir: string,
  update: (state: WorkspaceInitializationState) => WorkspaceInitializationState,
): Promise<WorkspaceInitializationState> {
  const statePath = getWorkspaceStatePath(workspaceDir);
  return withExclusiveLock(`${statePath}.lock`, async () => {
    const current = await readJsonFile<WorkspaceInitializationState>(statePath);
    if (!current) {
      throw new Error("Workspace initialization state not found.");
    }
    const next = update(current);
    await writeJsonFile(statePath, next);
    return next;
  });
}

async function writeWorkspaceInitializationState(
  workspaceDir: string,
  state: WorkspaceInitializationState,
): Promise<void> {
  const statePath = getWorkspaceStatePath(workspaceDir);
  await withExclusiveLock(`${statePath}.lock`, () =>
    writeJsonFile(statePath, state),
  );
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8",
    );
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function withExclusiveLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let lockHandle: Awaited<ReturnType<typeof fs.open>> | undefined;

  while (!lockHandle) {
    try {
      lockHandle = await fs.open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      if (await removeStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for lock at ${lockPath}`);
      }
      await delay(LOCK_RETRY_MS);
    }
  }

  try {
    return await operation();
  } finally {
    await lockHandle.close();
    await fs.rm(lockPath, { force: true });
  }
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs <= STALE_LOCK_MS) return false;
    await fs.rm(lockPath, { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function isTerminalRepoStatus(status: RepoInitializationStatus): boolean {
  return status === "ready" || status === "failed" || status === "cancelled";
}

function mapPersistentStateToPipelineState(
  state: RepoInitializationState,
): RepoPipelineState | null {
  if (state.status === "pending") {
    return {
      phase: "git",
      step: "mirror",
      status: "pending",
      message: state.message ?? "Waiting for repository setup",
    };
  }

  if (state.status === "git") {
    return {
      phase: "git",
      step: normalizeGitStep(state.step),
      status: "running",
      ...(state.message ? { message: state.message } : {}),
    };
  }

  if (state.status === "queued" || state.status === "running") {
    return {
      phase: "initializer",
      name: initializerNameFromStep(state.step),
      status: state.status === "queued" ? "pending" : "running",
      ...(state.message ? { message: state.message } : {}),
    };
  }

  return null;
}

function normalizeGitStep(
  step: string | undefined,
): "mirror" | "cleanup" | "worktree" {
  if (step === "cleanup" || step === "worktree") return step;
  return "mirror";
}

function initializerNameFromStep(step: string | undefined): string {
  if (!step?.startsWith("initializer:")) return "initialization";
  return step.slice("initializer:".length) || "initialization";
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function readLogChunk(
  filePath: string,
  offset: number,
): Promise<{ contents: string; offset: number }> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const stat = await fs.stat(filePath);
    const nextOffset = stat.size < offset ? 0 : offset;
    const length = stat.size - nextOffset;
    if (length === 0) {
      return { contents: "", offset: stat.size };
    }

    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, nextOffset);
    return { contents: buffer.toString("utf8"), offset: stat.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { contents: "", offset: 0 };
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function repoMetadataFeatureBranch(
  workspaceDir: string,
  repoName: string,
): Promise<string | undefined> {
  const metadata = await readWorkspaceMetadata(workspaceDir);
  return metadata?.repos.find((repo) => repo.name === repoName)?.feature_branch;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
