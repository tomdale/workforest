import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { validateRepositoryComponent } from "../repository-components.ts";
import { refreshAndMaterializeTemplateAgentsMd } from "../templates/agents-md.ts";
import { applyTemplate, copyTemplateFiles } from "../templates/apply.ts";
import { formatTemplateIdentifier, loadTemplate } from "../templates/index.ts";
import type { RepositorySource } from "../types.ts";
import { terminateRunningCommands } from "../utils/task-generator.ts";
import {
  getInitializationRepoDir,
  getInitializationRootDir,
  getInitializationStateDir,
  type InitializationScope,
  type InitializationTarget,
  normalizeInitializationTarget,
  workspaceInitializationScope,
  worktreeInitializationScope,
} from "./initialization-scope.ts";
import {
  readWorkspaceMetadata,
  readWorktreeMetadata,
  updateWorkspaceRepo,
  updateWorktreeRepo,
} from "./metadata.ts";
import {
  type RepoPipelineState,
  repoInitializationEvents,
} from "./pipeline.ts";
import {
  createPipelineStateConverter,
  hookStatesToEvents,
} from "./run-log/instrument.ts";
import { openWorkerRunSession, type RunSession } from "./run-log/session.ts";
import { getRepoSetupLogPath, withRepoSetupLog } from "./setup-logs.ts";

const WORKSPACE_STATE_FILENAME = "workspace.json";
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;
const QUEUED_STALE_MS = 2_000;
export const REPO_INITIALIZER_WORKER = "repo-initializer";
export const WORKSPACE_AGENTS_MD_WORKER = "workspace-agents-md";
const AGENTS_MD_STEP_ID = "setup:agents-md";

export {
  type InitializationTarget,
  workspaceInitializationScope,
  worktreeInitializationScope,
} from "./initialization-scope.ts";

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
  workspaceDir?: string;
  scope?: InitializationScope;
  repo: RepositorySource;
  disabledInitializers?: boolean | string[];
  /** The setup run this launch belongs to; the worker appends events to it. */
  setupRunId?: string;
};

type WorkerLaunch = (options: {
  scope: InitializationScope;
  repoName: string;
  runId: string;
  setupRunId?: string | undefined;
}) => Promise<number>;

type WorkspaceWorkerLaunch = (options: {
  scope: InitializationScope;
  runId: string;
  setupRunId?: string | undefined;
}) => Promise<number>;

export type WorkspaceAgentsMdJobStatus =
  | "queued"
  | "running"
  | "ready"
  | "skipped"
  | "failed";

export type WorkspaceAgentsMdJobState = {
  version: 1;
  status: WorkspaceAgentsMdJobStatus;
  run_id: string;
  pid?: number;
  warnings?: string[];
  error?: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
};

export function buildRepoInitializerWorkerEnvironment({
  scope: explicitScope,
  workspaceDir,
  repoName,
  runId,
  setupRunId,
  environment = process.env,
}: {
  scope?: InitializationScope;
  workspaceDir?: string;
  repoName: string;
  runId: string;
  setupRunId?: string | undefined;
  environment?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const scope = resolveInitializationScope({
    workspaceDir,
    scope: explicitScope,
  });
  return {
    ...environment,
    WORKFOREST_BACKGROUND_WORKER: "1",
    WORKFOREST_WORKER: REPO_INITIALIZER_WORKER,
    WORKFOREST_WORKER_SCOPE: scope.kind,
    ...(scope.kind === "workspace"
      ? { WORKFOREST_WORKER_WORKSPACE: scope.workspaceDir }
      : {
          WORKFOREST_WORKER_REPO_ROOT: scope.repoRootDir,
          WORKFOREST_WORKER_CHANGE: scope.changeName,
        }),
    WORKFOREST_WORKER_REPO: repoName,
    WORKFOREST_WORKER_RUN_ID: runId,
    ...(setupRunId ? { WORKFOREST_RUN_ID: setupRunId } : {}),
  };
}

export function buildWorkspaceAgentsMdWorkerEnvironment({
  scope: explicitScope,
  workspaceDir,
  runId,
  setupRunId,
  environment = process.env,
}: {
  scope?: InitializationScope;
  workspaceDir?: string;
  runId: string;
  setupRunId?: string | undefined;
  environment?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const scope = resolveInitializationScope({
    workspaceDir,
    scope: explicitScope,
  });
  if (scope.kind !== "workspace") {
    throw new Error("AGENTS.md refresh worker only supports workspaces.");
  }
  return {
    ...environment,
    WORKFOREST_BACKGROUND_WORKER: "1",
    WORKFOREST_WORKER: WORKSPACE_AGENTS_MD_WORKER,
    WORKFOREST_WORKER_SCOPE: "workspace",
    WORKFOREST_WORKER_WORKSPACE: scope.workspaceDir,
    WORKFOREST_WORKER_RUN_ID: runId,
    ...(setupRunId ? { WORKFOREST_RUN_ID: setupRunId } : {}),
  };
}

export async function initializeWorkspaceInitialization({
  workspaceDir,
  repos,
}: {
  workspaceDir: string;
  repos: readonly RepositorySource[];
}): Promise<void> {
  await initializeScopedInitialization({
    scope: workspaceInitializationScope(workspaceDir),
    repos,
    message: "Creating repository worktrees",
  });
}

export async function initializeWorktreeSetup({
  repoRootDir,
  changeName,
  repo,
}: {
  repoRootDir: string;
  changeName: string;
  repo: RepositorySource;
}): Promise<void> {
  await initializeScopedInitialization({
    scope: worktreeInitializationScope({ repoRootDir, changeName }),
    repos: [repo],
    message: "Creating repository worktree",
  });
}

/**
 * Prepare an existing workspace for a resumed setup run: the workspace goes
 * back to "creating" and only the named repos are reset to pending. Repos
 * that are already ready or actively initializing keep their state.
 */
export async function resumeWorkspaceInitialization({
  workspaceDir,
  repos,
}: {
  workspaceDir: string;
  repos: readonly RepositorySource[];
}): Promise<void> {
  const scope = workspaceInitializationScope(workspaceDir);
  await fs.mkdir(getInitializationDir(scope), { recursive: true });
  await resetWorkspaceAgentsMdJobState(scope);
  const now = new Date().toISOString();

  await writeWorkspaceInitializationState(scope, {
    version: 1,
    status: "creating",
    message: "Resuming repository worktrees",
    updated_at: now,
  });

  for (const repo of repos) {
    const existing = await readJsonFile<RepoInitializationState>(
      getRepoStatePath(scope, repo.name),
    );
    await writeRepoInitializationState(scope, {
      version: 1,
      repo: repo.name,
      status: "pending",
      attempt: existing?.attempt ?? 0,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });
  }
}

async function initializeScopedInitialization({
  scope,
  repos,
  message,
}: {
  scope: InitializationScope;
  repos: readonly RepositorySource[];
  message: string;
}): Promise<void> {
  await fs.mkdir(getInitializationDir(scope), { recursive: true });
  await resetWorkspaceAgentsMdJobState(scope);
  const now = new Date().toISOString();

  await writeWorkspaceInitializationState(scope, {
    version: 1,
    status: "creating",
    message,
    updated_at: now,
  });

  await Promise.all(
    repos.map((repo) =>
      writeRepoInitializationState(scope, {
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
  target: InitializationTarget,
  repoName: string,
): Promise<RepoInitializationState | null> {
  const scope = normalizeInitializationTarget(target);
  const state = await readJsonFile<RepoInitializationState>(
    getRepoStatePath(scope, repoName),
  );
  if (!state) return null;

  if (
    (state.status === "running" || state.status === "queued") &&
    state.pid !== undefined &&
    !isProcessAlive(state.pid) &&
    (state.status === "running" ||
      Date.now() - Date.parse(state.updated_at) > QUEUED_STALE_MS)
  ) {
    return updateRepoInitializationState(scope, repoName, (current) => {
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
  target: InitializationTarget,
): Promise<RepoInitializationState[]> {
  const scope = normalizeInitializationTarget(target);
  const metadata = await readInitializationMetadata(scope);
  if (!metadata) return [];

  const states = await Promise.all(
    metadata.repos.map((repo) => readRepoInitializationState(scope, repo.name)),
  );

  return states.filter(
    (state): state is RepoInitializationState => state !== null,
  );
}

export async function readWorkspaceInitializationState(
  target: InitializationTarget,
): Promise<WorkspaceInitializationState | null> {
  return readJsonFile<WorkspaceInitializationState>(
    getWorkspaceStatePath(normalizeInitializationTarget(target)),
  );
}

export async function* watchRepoInitialization({
  workspaceDir,
  scope: explicitScope,
  repoName,
  includeExistingLog = false,
  pollIntervalMs = 100,
}: {
  workspaceDir?: string;
  scope?: InitializationScope;
  repoName: string;
  includeExistingLog?: boolean;
  pollIntervalMs?: number;
}): AsyncGenerator<RepoPipelineState> {
  const scope = resolveInitializationScope({
    workspaceDir,
    scope: explicitScope,
  });
  const logPath = await getRepoInitializationLogPath(scope, repoName);
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

    const state = await readRepoInitializationState(scope, repoName);
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
  target: InitializationTarget,
  repoName: string,
  state: Extract<RepoPipelineState, { phase: "git" }>,
): Promise<void> {
  const scope = normalizeInitializationTarget(target);
  await updateRepoInitializationState(scope, repoName, (current) => {
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
  target: InitializationTarget,
  repoName: string,
  error: Error,
  step?: string,
): Promise<void> {
  const scope = normalizeInitializationTarget(target);
  const now = new Date().toISOString();
  await updateRepoInitializationState(scope, repoName, (current) => ({
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
  target: InitializationTarget,
): Promise<void> {
  const scope = normalizeInitializationTarget(target);
  await updateWorkspaceInitializationState(scope, () => ({
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
  const scope = resolveInitializationScope(options);
  const previous = await readRepoInitializationState(scope, options.repo.name);
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

  await writeRepoInitializationState(scope, queued);
  await markWorkspaceInitializing(scope);

  try {
    const pid = await launchWorker({
      scope,
      repoName: options.repo.name,
      runId,
      setupRunId: options.setupRunId,
    });

    return updateRepoInitializationState(scope, options.repo.name, (current) =>
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
      scope,
      options.repo.name,
      setupError,
      "initializer:launch",
    );
    throw setupError;
  }
}

export async function readWorkspaceAgentsMdJobState(
  target: InitializationTarget,
): Promise<WorkspaceAgentsMdJobState | null> {
  const scope = normalizeInitializationTarget(target);
  const state = await readJsonFile<WorkspaceAgentsMdJobState>(
    getAgentsMdJobStatePath(scope),
  );
  if (!state) return null;

  if (
    (state.status === "running" || state.status === "queued") &&
    state.pid !== undefined &&
    !isProcessAlive(state.pid) &&
    (state.status === "running" ||
      Date.now() - Date.parse(state.updated_at) > QUEUED_STALE_MS)
  ) {
    return updateWorkspaceAgentsMdJobState(scope, (current) => {
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
        error: "Background AGENTS.md refresh exited unexpectedly.",
        completed_at: now,
        updated_at: now,
      };
    });
  }

  return state;
}

export async function startWorkspaceAgentsMdRefresh(
  target: InitializationTarget,
  { setupRunId }: { setupRunId?: string } = {},
  launchWorker: WorkspaceWorkerLaunch = launchDetachedAgentsMdWorker,
): Promise<WorkspaceAgentsMdJobState> {
  const scope = normalizeInitializationTarget(target);
  if (scope.kind !== "workspace") {
    const now = new Date().toISOString();
    const skipped: WorkspaceAgentsMdJobState = {
      version: 1,
      status: "skipped",
      run_id: randomUUID(),
      created_at: now,
      updated_at: now,
      completed_at: now,
    };
    await writeWorkspaceAgentsMdJobState(scope, skipped);
    return skipped;
  }

  const existing = await readWorkspaceAgentsMdJobState(scope);
  if (
    existing &&
    (existing.status === "queued" ||
      existing.status === "running" ||
      existing.status === "ready" ||
      existing.status === "failed" ||
      existing.status === "skipped")
  ) {
    return existing;
  }

  const now = new Date().toISOString();
  const runId = randomUUID();
  const queued: WorkspaceAgentsMdJobState = {
    version: 1,
    status: "queued",
    run_id: runId,
    created_at: now,
    updated_at: now,
  };
  await writeWorkspaceAgentsMdJobState(scope, queued);

  try {
    const pid = await launchWorker({ scope, runId, setupRunId });
    return updateWorkspaceAgentsMdJobState(scope, (current) =>
      current.run_id === runId
        ? { ...current, pid, updated_at: new Date().toISOString() }
        : current,
    );
  } catch (error) {
    const setupError =
      error instanceof Error ? error : new Error(String(error));
    const failed = await updateWorkspaceAgentsMdJobState(scope, (current) =>
      current.run_id === runId
        ? {
            ...current,
            status: "failed",
            error: setupError.message,
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }
        : current,
    );
    return failed;
  }
}

export async function runWorkspaceAgentsMdWorker({
  workspaceDir,
  scope: explicitScope,
  runId,
  setupRunId,
}: {
  workspaceDir?: string;
  scope?: InitializationScope;
  runId: string;
  setupRunId?: string | undefined;
}): Promise<void> {
  const scope = resolveInitializationScope({
    workspaceDir,
    scope: explicitScope,
  });
  const rootDir = getInitializationRootDir(scope);
  const metadata = await readInitializationMetadata(scope);
  if (!metadata) {
    throw new Error(`Workspace metadata not found: ${rootDir}`);
  }
  const session = await openWorkerRunSession({
    scope,
    repoName: "workspace",
    runId: setupRunId,
  });

  try {
    await runAgentsMdRefreshJob(scope, metadata, session, runId);
    const finalState = await finalizeWorkspaceInitialization(scope, {
      session,
    });
    emitRunEndIfTerminal(session, finalState);
  } finally {
    await session.close().catch(() => undefined);
  }
}

export async function runRepoInitializationWorker({
  workspaceDir,
  scope: explicitScope,
  repoName,
  runId,
  setupRunId,
}: {
  workspaceDir?: string;
  scope?: InitializationScope;
  repoName: string;
  runId: string;
  setupRunId?: string | undefined;
}): Promise<void> {
  const scope = resolveInitializationScope({
    workspaceDir,
    scope: explicitScope,
  });
  const rootDir = getInitializationRootDir(scope);
  const repoDir = getInitializationRepoDir(scope, repoName);
  const metadata = await readInitializationMetadata(scope);
  const repoMetadata = metadata?.repos.find((repo) => repo.name === repoName);
  if (!metadata || !repoMetadata) {
    throw new Error(`Workspace repository not found: ${repoName}`);
  }

  const repo: RepositorySource = {
    name: repoMetadata.name,
    remote: repoMetadata.remote,
  };
  const template = metadata.workspace.template_id
    ? await loadTemplate(
        formatTemplateIdentifier({
          parent: metadata.workspace.template_id,
          variant: metadata.workspace.template_variant,
        }),
      )
    : null;
  const session = await openWorkerRunSession({
    scope,
    repoName,
    runId: setupRunId,
  });
  let stopping = false;
  let checkingCancellation = false;

  const cancel = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await terminateRunningCommands();
    await markRepoCancelled(scope, repoName, runId);
    session.emit({ kind: "repo-end", repo: repoName, outcome: "cancelled" });
    const finalState = await finalizeWorkspaceInitialization(scope, {
      session,
    });
    emitRunEndIfTerminal(session, finalState);
    await session.close().catch(() => undefined);
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
    void readRepoInitializationState(scope, repoName)
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
      scope,
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
      await finalizeWorkspaceInitialization(scope, { session });
      return;
    }

    // The canonical record is the event stream; the legacy state view is
    // derived from it, so the setup log and persisted snapshots can never
    // drift from what the run log says happened.
    const converter = createPipelineStateConverter();
    const events = session.record(
      repoInitializationEvents({
        repo,
        workspaceDir: rootDir,
        repoDir,
        ...(template?.config.disableInitializers !== undefined
          ? { disabledInitializers: template.config.disableInitializers }
          : {}),
      }),
    );
    const legacyStates =
      (async function* (): AsyncGenerator<RepoPipelineState> {
        for await (const event of events) {
          if (stopping) return;
          yield* converter.convert(event);
        }
      })();
    const pipeline = withRepoSetupLog(legacyStates, {
      workspaceDir: rootDir,
      initializationScope: scope,
      repoName,
      repoDir,
    });

    for await (const state of pipeline) {
      if (stopping) return;
      await recordWorkerPipelineState(scope, repo, runId, state);
    }

    const finalState = await finalizeWorkspaceInitialization(scope, {
      session,
    });
    emitRunEndIfTerminal(session, finalState);
  } finally {
    clearInterval(cancellationTimer);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    await session.close().catch(() => undefined);
  }
}

export async function cancelRepoInitializations(
  target: InitializationTarget,
  repoNames: readonly string[],
): Promise<RepoInitializationState[]> {
  const scope = normalizeInitializationTarget(target);
  const results: RepoInitializationState[] = [];

  for (const repoName of repoNames) {
    const state = await readRepoInitializationState(scope, repoName);
    if (!state) {
      throw new Error(`No initialization state found for "${repoName}".`);
    }
    if (state.status !== "queued" && state.status !== "running") {
      throw new Error(
        `Cannot cancel "${repoName}" because it is ${state.status}.`,
      );
    }

    const cancelled = await markRepoCancelled(scope, repoName, state.run_id);
    results.push(cancelled);
  }

  return results;
}

export async function retryRepoInitializations(
  target: InitializationTarget,
  repoNames: readonly string[],
  launchWorker: WorkerLaunch = launchDetachedWorker,
  options: { setupRunId?: string } = {},
): Promise<RepoInitializationState[]> {
  const scope = normalizeInitializationTarget(target);
  const metadata = await readInitializationMetadata(scope);
  if (!metadata) {
    throw new Error(
      `Initialization metadata not found: ${getInitializationRootDir(scope)}`,
    );
  }

  const results: RepoInitializationState[] = [];
  for (const repoName of repoNames) {
    const current = await readRepoInitializationState(scope, repoName);
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
          scope,
          repo: {
            name: repoMetadata.name,
            remote: repoMetadata.remote,
          },
          ...(options.setupRunId !== undefined
            ? { setupRunId: options.setupRunId }
            : {}),
        },
        launchWorker,
      ),
    );
  }

  return results;
}

/**
 * Once every repo is terminal, run workspace-level finishing work (AGENTS.md
 * refresh, template hooks) and write the terminal workspace state. Any
 * process may call this; the finalize lock makes exactly one perform the
 * transition. Returns the terminal state when this call performed it, null
 * when finalization was not yet possible or already done. When a `session`
 * is provided, workspace-level steps are recorded to the run log.
 */
export async function finalizeWorkspaceInitialization(
  target: InitializationTarget,
  { session }: { session?: RunSession } = {},
): Promise<WorkspaceInitializationState | null> {
  const scope = normalizeInitializationTarget(target);
  return withExclusiveLock(getFinalizeLockPath(scope), async () => {
    const workspaceState = await readWorkspaceInitializationState(scope);
    if (
      workspaceState?.status === "ready" ||
      workspaceState?.status === "failed" ||
      workspaceState?.status === "cancelled"
    ) {
      return null;
    }

    const states = await readRepoInitializationStates(scope);
    if (
      states.length === 0 ||
      states.some((state) => !isTerminalRepoStatus(state.status))
    ) {
      return null;
    }

    const metadata = await readInitializationMetadata(scope);
    if (!metadata) return null;

    const warnings: string[] = [];
    const failedRepos = states.filter((state) => state.status === "failed");
    const cancelledRepos = states.filter(
      (state) => state.status === "cancelled",
    );
    const template = metadata.workspace.template_id
      ? await loadTemplate(
          formatTemplateIdentifier({
            parent: metadata.workspace.template_id,
            variant: metadata.workspace.template_variant,
          }),
        )
      : null;

    if (template?.config["AGENTS.md"]) {
      await updateWorkspaceInitializationState(scope, (current) => ({
        ...current,
        message: "Refreshing AGENTS.md guidance",
        updated_at: new Date().toISOString(),
      }));

      let job = await readWorkspaceAgentsMdJobState(scope);
      if (!job) {
        await copyTemplateFiles(template, getInitializationRootDir(scope));
        job = await startWorkspaceAgentsMdRefresh(
          scope,
          session ? { setupRunId: session.runId } : {},
        );
      }

      job = await waitForWorkspaceAgentsMdJob(scope);
      if (job.warnings) warnings.push(...job.warnings);
      if (job.status === "failed") {
        warnings.push(
          `Could not materialize AGENTS.md guidance: ${job.error ?? "AGENTS.md refresh failed."}`,
        );
      }
    }

    if (template?.config.hooks && template.config.hooks.length > 0) {
      await updateWorkspaceInitializationState(scope, (current) => ({
        ...current,
        status: "hooks",
        message: "Running workspace hooks",
        updated_at: new Date().toISOString(),
      }));

      try {
        const hookEvents = hookStatesToEvents(
          applyTemplate({
            template,
            workspaceDir: getInitializationRootDir(scope),
            repoDirs: states
              .filter((state) => state.status === "ready")
              .map((state) => state.repo),
          }),
        );
        for await (const event of hookEvents) {
          session?.emit(event);
          if (event.kind === "step-start") {
            await updateWorkspaceInitializationState(scope, (current) => ({
              ...current,
              current_hook: event.title,
              message: `Running hook: ${event.title}`,
              updated_at: new Date().toISOString(),
            }));
          } else if (event.kind === "step-log" && event.level === "warn") {
            warnings.push(event.message);
          }
        }
      } catch (error) {
        const hookError =
          error instanceof Error ? error : new Error(String(error));
        const failedState: WorkspaceInitializationState = {
          version: 1,
          status: "failed",
          message: "Workspace hook failed",
          error: hookError.message,
          ...(warnings.length > 0 ? { warnings } : {}),
          updated_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        };
        await writeWorkspaceInitializationState(scope, failedState);
        return failedState;
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

    const finalState: WorkspaceInitializationState = {
      version: 1,
      status,
      message,
      ...(warnings.length > 0 ? { warnings } : {}),
      updated_at: now,
      completed_at: now,
    };
    await writeWorkspaceInitializationState(scope, finalState);
    return finalState;
  });
}

/**
 * Record the run's terminal event when a finalize call actually performed
 * the transition (its return is non-null exactly once per run).
 */
export function emitRunEndIfTerminal(
  session: RunSession,
  finalState: WorkspaceInitializationState | null,
): void {
  if (!finalState) return;
  if (
    finalState.status !== "ready" &&
    finalState.status !== "failed" &&
    finalState.status !== "cancelled"
  ) {
    return;
  }
  session.emit({
    kind: "run-end",
    outcome: finalState.status,
    durationMs: Date.now() - session.startedAtMs,
  });
}

export function getInitializationDir(target: InitializationTarget): string {
  return getInitializationStateDir(normalizeInitializationTarget(target));
}

export function getRepoInitializationLogPath(
  target: InitializationTarget,
  repoName: string,
): Promise<string> {
  const scope = normalizeInitializationTarget(target);
  return getRepoSetupLogPath({
    workspaceDir: getInitializationRootDir(scope),
    initializationScope: scope,
    repoName,
  });
}

function getRepoStatePath(
  scope: InitializationScope,
  repoName: string,
): string {
  const safeRepoName = validateRepositoryComponent(repoName, "Repository name");
  return path.join(
    getInitializationDir(scope),
    "repos",
    `${encodeURIComponent(safeRepoName)}.json`,
  );
}

function getWorkspaceStatePath(scope: InitializationScope): string {
  return path.join(getInitializationDir(scope), WORKSPACE_STATE_FILENAME);
}

function getAgentsMdJobStatePath(scope: InitializationScope): string {
  return path.join(getInitializationDir(scope), "agents-md.json");
}

async function resetWorkspaceAgentsMdJobState(
  scope: InitializationScope,
): Promise<void> {
  if (scope.kind !== "workspace") return;
  await fs.rm(getAgentsMdJobStatePath(scope), { force: true });
}

function getFinalizeLockPath(scope: InitializationScope): string {
  return path.join(getInitializationDir(scope), "finalize.lock");
}

async function launchDetachedWorker({
  scope,
  repoName,
  runId,
  setupRunId,
}: {
  scope: InitializationScope;
  repoName: string;
  runId: string;
  setupRunId?: string | undefined;
}): Promise<number> {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    throw new Error("Unable to resolve the workforest CLI entrypoint.");
  }

  const child = spawn(process.execPath, [path.resolve(entrypoint)], {
    cwd: getInitializationRootDir(scope),
    detached: true,
    stdio: "ignore",
    env: buildRepoInitializerWorkerEnvironment({
      scope,
      repoName,
      runId,
      setupRunId,
    }),
  });

  await waitForSpawn(child);
  if (child.pid === undefined) {
    throw new Error(`Failed to launch initializer for "${repoName}".`);
  }
  child.unref();
  return child.pid;
}

async function launchDetachedAgentsMdWorker({
  scope,
  runId,
  setupRunId,
}: {
  scope: InitializationScope;
  runId: string;
  setupRunId?: string | undefined;
}): Promise<number> {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    throw new Error("Unable to resolve the workforest CLI entrypoint.");
  }

  const child = spawn(process.execPath, [path.resolve(entrypoint)], {
    cwd: getInitializationRootDir(scope),
    detached: true,
    stdio: "ignore",
    env: buildWorkspaceAgentsMdWorkerEnvironment({
      scope,
      runId,
      setupRunId,
    }),
  });

  await waitForSpawn(child);
  if (child.pid === undefined) {
    throw new Error("Failed to launch AGENTS.md refresh worker.");
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

async function runAgentsMdRefreshJob(
  scope: InitializationScope,
  metadata: NonNullable<Awaited<ReturnType<typeof readInitializationMetadata>>>,
  session: RunSession,
  runId: string,
): Promise<WorkspaceAgentsMdJobState> {
  const template = metadata.workspace.template_id
    ? await loadTemplate(
        formatTemplateIdentifier({
          parent: metadata.workspace.template_id,
          variant: metadata.workspace.template_variant,
        }),
      )
    : null;

  const started = await updateWorkspaceAgentsMdJobState(scope, (current) => {
    if (current.run_id !== runId || current.status === "skipped") {
      return current;
    }
    const now = new Date().toISOString();
    return {
      ...current,
      status: "running",
      pid: process.pid,
      started_at: now,
      updated_at: now,
    };
  });
  if (started.run_id !== runId || started.status === "skipped") {
    return started;
  }

  const warnings: string[] = [];
  const startedAt = Date.now();
  session.emit({
    kind: "step-start",
    repo: null,
    step: AGENTS_MD_STEP_ID,
    title: "AGENTS.md",
  });

  if (!template?.config["AGENTS.md"]) {
    session.emit({
      kind: "step-end",
      repo: null,
      step: AGENTS_MD_STEP_ID,
      outcome: "skipped",
      durationMs: Date.now() - startedAt,
      reason: "Template has no AGENTS.md guidance.",
    });
    return completeAgentsMdJob(scope, runId, "skipped", { warnings });
  }

  try {
    await refreshAndMaterializeTemplateAgentsMd(
      template,
      getInitializationRootDir(scope),
      metadata.repos.map((repo) => ({
        name: repo.name,
        remote: repo.remote,
      })),
      {
        onWarning: (message) => {
          warnings.push(message);
          session.emit({
            kind: "step-log",
            repo: null,
            step: AGENTS_MD_STEP_ID,
            level: "warn",
            message,
          });
        },
      },
    );
    session.emit({
      kind: "step-end",
      repo: null,
      step: AGENTS_MD_STEP_ID,
      outcome: "ok",
      durationMs: Date.now() - startedAt,
    });
    return completeAgentsMdJob(scope, runId, "ready", { warnings });
  } catch (error) {
    const message = formatError(error);
    session.emit({
      kind: "step-end",
      repo: null,
      step: AGENTS_MD_STEP_ID,
      outcome: "failed",
      durationMs: Date.now() - startedAt,
      error: { message },
    });
    return completeAgentsMdJob(scope, runId, "failed", {
      warnings,
      error: message,
    });
  }
}

async function completeAgentsMdJob(
  scope: InitializationScope,
  runId: string,
  status: "ready" | "skipped" | "failed",
  {
    warnings,
    error,
  }: {
    warnings: readonly string[];
    error?: string;
  },
): Promise<WorkspaceAgentsMdJobState> {
  const now = new Date().toISOString();
  return updateWorkspaceAgentsMdJobState(scope, (current) =>
    current.run_id === runId
      ? {
          ...current,
          status,
          ...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
          ...(error !== undefined ? { error } : {}),
          completed_at: now,
          updated_at: now,
        }
      : current,
  );
}

async function recordWorkerPipelineState(
  scope: InitializationScope,
  repo: RepositorySource,
  runId: string,
  state: RepoPipelineState,
): Promise<void> {
  if (state.phase === "initializer") {
    if (state.status === "output") {
      return;
    }

    await updateRepoInitializationState(scope, repo.name, (current) => {
      if (
        current.run_id !== runId ||
        current.status === "cancelled" ||
        current.status === "failed"
      ) {
        return current;
      }

      const { message: _message, ...currentWithoutMessage } = current;
      return {
        ...currentWithoutMessage,
        status: "running",
        phase: "initializer",
        step: `initializer:${state.name}`,
        ...(state.message !== undefined ? { message: state.message } : {}),
        updated_at: new Date().toISOString(),
      };
    });
    return;
  }

  if (state.phase === "complete") {
    const now = new Date().toISOString();
    await updateRepoInitializationState(scope, repo.name, (current) => {
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
    const featureBranch = await repoMetadataFeatureBranch(scope, repo.name);
    await updateInitializationRepoMetadata(scope, {
      name: repo.name,
      remote: repo.remote,
      has_lockfile: state.hasLockfile,
      ...(featureBranch ? { feature_branch: featureBranch } : {}),
    });
    return;
  }

  if (state.phase === "failed") {
    const now = new Date().toISOString();
    await updateRepoInitializationState(scope, repo.name, (current) => {
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Best-effort cancellation for one repo's setup: marks any non-terminal
 * state cancelled so finalization can complete. Unlike
 * {@link cancelRepoInitializations} this never throws; it is used by the
 * interactive grid's graceful cancel for repos that are still pending or
 * mid-git in the foreground, where a hard error would strand the cancel.
 */
export async function cancelRepoSetup(
  target: InitializationTarget,
  repoName: string,
): Promise<RepoInitializationState | null> {
  const scope = normalizeInitializationTarget(target);
  const now = new Date().toISOString();
  try {
    return await updateRepoInitializationState(scope, repoName, (current) => {
      if (isTerminalRepoStatus(current.status)) return current;
      return {
        ...current,
        status: "cancelled",
        message: "Setup cancelled",
        completed_at: now,
        updated_at: now,
      };
    });
  } catch {
    return null;
  }
}

async function markRepoCancelled(
  target: InitializationTarget,
  repoName: string,
  runId?: string,
): Promise<RepoInitializationState> {
  const scope = normalizeInitializationTarget(target);
  const now = new Date().toISOString();
  return updateRepoInitializationState(scope, repoName, (current) => {
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
  scope: InitializationScope,
  repoName: string,
  update: (state: RepoInitializationState) => RepoInitializationState,
): Promise<RepoInitializationState> {
  const statePath = getRepoStatePath(scope, repoName);
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
  scope: InitializationScope,
  state: RepoInitializationState,
): Promise<void> {
  const statePath = getRepoStatePath(scope, state.repo);
  await withExclusiveLock(`${statePath}.lock`, () =>
    writeJsonFile(statePath, state),
  );
}

async function waitForWorkspaceAgentsMdJob(
  scope: InitializationScope,
): Promise<WorkspaceAgentsMdJobState> {
  while (true) {
    const state = await readWorkspaceAgentsMdJobState(scope);
    if (!state) {
      throw new Error("AGENTS.md refresh job state not found.");
    }
    if (
      state.status === "ready" ||
      state.status === "skipped" ||
      state.status === "failed"
    ) {
      return state;
    }
    await delay(LOCK_RETRY_MS);
  }
}

async function writeWorkspaceAgentsMdJobState(
  scope: InitializationScope,
  state: WorkspaceAgentsMdJobState,
): Promise<void> {
  const statePath = getAgentsMdJobStatePath(scope);
  await withExclusiveLock(`${statePath}.lock`, () =>
    writeJsonFile(statePath, state),
  );
}

async function updateWorkspaceAgentsMdJobState(
  scope: InitializationScope,
  update: (state: WorkspaceAgentsMdJobState) => WorkspaceAgentsMdJobState,
): Promise<WorkspaceAgentsMdJobState> {
  const statePath = getAgentsMdJobStatePath(scope);
  return withExclusiveLock(`${statePath}.lock`, async () => {
    const current = await readJsonFile<WorkspaceAgentsMdJobState>(statePath);
    if (!current) {
      throw new Error("AGENTS.md refresh job state not found.");
    }
    const next = update(current);
    await writeJsonFile(statePath, next);
    return next;
  });
}

async function updateWorkspaceInitializationState(
  scope: InitializationScope,
  update: (state: WorkspaceInitializationState) => WorkspaceInitializationState,
): Promise<WorkspaceInitializationState> {
  const statePath = getWorkspaceStatePath(scope);
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
  scope: InitializationScope,
  state: WorkspaceInitializationState,
): Promise<void> {
  const statePath = getWorkspaceStatePath(scope);
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
  target: InitializationTarget,
  repoName: string,
): Promise<string | undefined> {
  const metadata = await readInitializationMetadata(
    normalizeInitializationTarget(target),
  );
  return metadata?.repos.find((repo) => repo.name === repoName)?.feature_branch;
}

async function readInitializationMetadata(
  scope: InitializationScope,
): Promise<Awaited<ReturnType<typeof readWorkspaceMetadata>>> {
  return scope.kind === "workspace"
    ? readWorkspaceMetadata(scope.workspaceDir)
    : readWorktreeMetadata(scope.repoRootDir, scope.changeName);
}

async function updateInitializationRepoMetadata(
  scope: InitializationScope,
  repo: Parameters<typeof updateWorkspaceRepo>[1],
): Promise<void> {
  if (scope.kind === "workspace") {
    await updateWorkspaceRepo(scope.workspaceDir, repo);
    return;
  }

  await updateWorktreeRepo(scope.repoRootDir, scope.changeName, repo);
}

function resolveInitializationScope({
  workspaceDir,
  scope,
}: {
  workspaceDir?: string | undefined;
  scope?: InitializationScope | undefined;
}): InitializationScope {
  if (scope) return scope;
  if (workspaceDir) return workspaceInitializationScope(workspaceDir);
  throw new Error("Initialization scope is required.");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
