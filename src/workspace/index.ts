import { promises as fs } from "node:fs";
import path from "node:path";
import { hasAny, pathExists } from "@wf-plugin/core";
import { getCacheDir } from "../config.ts";
import { validateRepositoryComponent } from "../repository-components.ts";
import { emitServiceEvent, type ServiceEventSink } from "../services/events.ts";
import { isShellAutoCdEnabled } from "../shell.ts";
import { materializeTemplateAgentsMd } from "../templates/agents-md.ts";
import { copyTemplateFiles } from "../templates/apply.ts";
import { formatTemplateIdentifier, loadTemplate } from "../templates/index.ts";
import type { RepositorySource } from "../types.ts";
import {
  presentPipelines,
  renderPipelinesGrid,
  shouldUseGrid,
} from "../ui/grid-consumer.ts";
import { ensureDir } from "../utils/fs.ts";
import { resolveContainedPath } from "../utils/path-safety.ts";
import {
  emitRunEndIfTerminal,
  finalizeWorkspaceInitialization,
  initializeWorkspaceInitialization,
  markWorkspaceInitializing,
  recordRepoGitState,
  recordRepoSetupFailure,
  startRepoInitialization,
  watchRepoInitialization,
  workspaceInitializationScope,
} from "./initialization.ts";
import type { InitializationScope } from "./initialization-scope.ts";
import {
  appendWorkspaceRepos,
  readWorkspaceMetadata,
  updateWorkspaceRepo,
  writeWorkspaceMetadata,
} from "./metadata.ts";
import {
  type RepoPipelineOptions,
  type RepoPipelineState,
  repoPipeline,
  repoSetupEvents,
} from "./pipeline.ts";
import { toRunEventError } from "./run-log/events.ts";
import { createPipelineStateConverter } from "./run-log/instrument.ts";
import { createRunSession, type RunSession } from "./run-log/session.ts";
import {
  DEFAULT_REPO_SETUP_LOG_EXCERPT_CHARS,
  getRepoSetupLogPath,
  readRepoSetupLogExcerpt,
  withRepoSetupLog,
} from "./setup-logs.ts";

// ============================================================================
// Types
// ============================================================================

export type StampWorkspaceOptions = {
  featureName: string;
  description?: string;
  branchName?: string;
  workspaceDir: string;
  repos: readonly RepositorySource[];
  templateId?: string;
  templateVariant?: string;
  /** Render the setup grid when the terminal supports it (default false). */
  interactive?: boolean;
  onEvent?: ServiceEventSink;
  renderPipelinesGrid?: typeof renderPipelinesGrid;
  shouldUseGrid?: typeof shouldUseGrid;
};

export type PreparedRepo = {
  repo: RepositorySource;
  targetDir: string;
  hasLockfile: boolean;
};

export type AddReposOptions = {
  workspaceDir: string;
  repos: readonly RepositorySource[];
  branchName: string;
  disabledInitializers?: boolean | string[];
  /** Render the setup grid when the terminal supports it (default false). */
  interactive?: boolean;
  onEvent?: ServiceEventSink;
  renderPipelinesGrid?: typeof renderPipelinesGrid;
  shouldUseGrid?: typeof shouldUseGrid;
};

export type AddReposResult = {
  addedRepos: readonly RepositorySource[];
  failedRepos: readonly {
    name: string;
    error: Error;
  }[];
};

export type RepoSetupFailureSummary = {
  repoName: string;
  step?: string;
  message: string;
  logPath: string;
  logExcerpt?: string;
};

export type StampWorkspaceResult = {
  setupFailures: readonly RepoSetupFailureSummary[];
  workspaceDir: string;
  nextSteps: readonly string[];
};

/**
 * Stamp a multi-repo workspace: prepare each repo's worktree in parallel and
 * present progress through the shared seam — the grid when the terminal supports
 * it, inline events otherwise. Finalization (VS Code workspace file, mark-
 * initializing, finalize) is deferred to onBeforeCompletionPrompt so it runs at
 * the same point whichever surface rendered — no eager/deferred asymmetry.
 */
export async function stampWorkspace(
  options: StampWorkspaceOptions,
): Promise<StampWorkspaceResult> {
  const {
    featureName,
    description,
    branchName,
    workspaceDir,
    repos,
    templateId,
    templateVariant,
    interactive = false,
    onEvent,
  } = options;
  if (repos.length === 0) {
    throw new Error("stampWorkspace requires at least one repository.");
  }
  if (await pathExists(workspaceDir)) {
    const contents = await fs.readdir(workspaceDir);
    if (contents.length > 0) {
      throw new Error(
        `Directory already exists and is not empty: ${workspaceDir}\nUse a different name or remove the existing directory.`,
      );
    }
  }

  await ensureCacheDir();
  const isNewWorkspace = !(await pathExists(workspaceDir));
  await ensureDir(workspaceDir);
  const effectiveBranchName = branchName ?? featureName;
  const template = templateId
    ? await loadTemplate(
        formatTemplateIdentifier({
          parent: templateId,
          variant: templateVariant,
        }),
      )
    : null;

  await writeInitialWorkspaceMetadata({
    workspaceDir,
    featureName,
    branchName: effectiveBranchName,
    repos,
    ...(description !== undefined ? { description } : {}),
    ...(templateId !== undefined ? { templateId } : {}),
    ...(templateVariant !== undefined ? { templateVariant } : {}),
  });
  await initializeWorkspaceInitialization({ workspaceDir, repos });

  const scope = workspaceInitializationScope(workspaceDir);
  const session = await createRunSession({
    scope,
    command: "new",
    repos: repos.map((repo) => repo.name),
  });

  const prepared = new Map<
    string,
    { repo: RepositorySource; hasLockfile: boolean }
  >();
  const setupFailures = new Map<string, RepoSetupFailureSummary>();
  const templateBarrier =
    template !== null
      ? createTemplateCopyBarrier({
          repoCount: repos.length,
          copyTemplateFiles: async () => {
            await copyTemplateFiles(template, workspaceDir);
            await materializeTemplateAgentsMd(template, workspaceDir);
          },
        })
      : null;
  const beforeInitializers = async ({
    repo,
    repoDir,
  }: {
    repo: RepositorySource;
    repoDir: string;
  }): Promise<void> => {
    const hasLockfile = await hasAny(repoDir, [
      "pnpm-lock.yaml",
      "pnpm-lock.yml",
    ]);
    await updatePreparedWorkspaceRepoMetadata({
      workspaceDir,
      branchName: effectiveBranchName,
      repo,
      hasLockfile,
    });
    prepared.set(repo.name, { repo, hasLockfile });
    await templateBarrier?.waitForTemplateFiles();
  };
  const pipelines = new Map(
    repos.map((repo) => [
      repo.name,
      createBackgroundRepoSetupPipeline({
        repo,
        workspaceDir,
        branchName: effectiveBranchName,
        isNewWorkspace,
        beforeInitializers,
        monitorBackground: interactive,
        templateBarrier,
        session,
      }),
    ]),
  );

  try {
    await presentPipelines({
      pipelines,
      repoNames: repos.map((repo) => repo.name),
      interactive,
      ...(onEvent ? { onEvent } : {}),
      workspacePath: workspaceDir,
      getLogPath: () => Promise.resolve(session.runDir),
      onFailure: (repoName, state) => {
        setupFailures.set(
          repoName,
          createRunFailureSummary({
            session,
            repoName,
            error: state.error,
            ...(state.step ? { step: state.step } : {}),
          }),
        );
      },
      onBeforeCompletionPrompt: async () => {
        // Deferred to the same point for grid and drain. Suppress service
        // events while the grid owns the screen; the drain is free to emit
        // them.
        await writeVSCodeWorkspaceFile(
          workspaceDir,
          repos.filter((repo) => prepared.has(repo.name)),
          !interactive && onEvent ? { onEvent } : {},
        );
        await markWorkspaceInitializing(workspaceDir);
        const finalState = await finalizeWorkspaceInitialization(workspaceDir, {
          session,
        });
        emitRunEndIfTerminal(session, finalState);
      },
      completeOnWorktreesReady: true,
      backgroundInitialization: true,
      ...(options.renderPipelinesGrid
        ? { renderPipelinesGrid: options.renderPipelinesGrid }
        : {}),
      ...(options.shouldUseGrid
        ? { shouldUseGrid: options.shouldUseGrid }
        : {}),
    });
  } finally {
    await session.close().catch(() => undefined);
  }

  if (!interactive) {
    emitServiceEvent(onEvent, {
      type: "message",
      level: "success",
      message: "Workspace created.",
    });
  }

  return {
    setupFailures: [...setupFailures.values()],
    workspaceDir,
    nextSteps: [...getNextSteps(workspaceDir), "wf status --watch"],
  };
}

async function* createBackgroundRepoSetupPipeline({
  repo,
  workspaceDir,
  branchName,
  isNewWorkspace,
  beforeInitializers,
  monitorBackground,
  templateBarrier,
  session,
}: {
  repo: RepositorySource;
  workspaceDir: string;
  branchName: string;
  isNewWorkspace: boolean;
  beforeInitializers: NonNullable<RepoPipelineOptions["beforeInitializers"]>;
  monitorBackground: boolean;
  templateBarrier: TemplateCopyBarrier | null;
  session: RunSession;
}): AsyncGenerator<RepoPipelineState> {
  yield* runScopedRepoSetupPipeline({
    repo,
    scope: workspaceInitializationScope(workspaceDir),
    rootDir: workspaceDir,
    repoDir: resolveContainedPath(workspaceDir, repo.name),
    branchName,
    isNewWorkspace,
    beforeInitializers,
    monitorBackground,
    onFailed: () => templateBarrier?.markRepoFailed(),
    session,
  });
}

export type ScopedRepoSetupPipelineOptions = {
  repo: RepositorySource;
  /** Initialization scope used to record state, launch, and locate logs. */
  scope: InitializationScope;
  /** Root the worktree lives under (cleanup + log root). */
  rootDir: string;
  /** Absolute path of the repository worktree being created. */
  repoDir: string;
  branchName: string;
  isNewWorkspace: boolean;
  beforeInitializers?: RepoPipelineOptions["beforeInitializers"];
  /** When true, watch the detached initializer and keep yielding its state. */
  monitorBackground: boolean;
  /** Invoked the first time the foreground git pipeline reports a failure. */
  onFailed?: () => void;
  /** Run session this repo's setup events are recorded to. */
  session: RunSession;
};

/**
 * Drive the foreground portion of a single repository's setup (mirror →
 * worktree), record its events against the run session and its state against
 * an initialization scope, hand initialization off to a detached worker, and
 * optionally watch that worker.
 *
 * This is the shared primitive behind both workspace stamping and single-repo
 * change creation, so the two surfaces present identical pipeline state through
 * the grid regardless of repo count.
 */
export async function* runScopedRepoSetupPipeline({
  repo,
  scope,
  rootDir,
  repoDir,
  branchName,
  isNewWorkspace,
  beforeInitializers,
  monitorBackground,
  onFailed,
  session,
}: ScopedRepoSetupPipelineOptions): AsyncGenerator<RepoPipelineState> {
  let markedFailed = false;
  const converter = createPipelineStateConverter();
  const events = session.record(
    repoSetupEvents({
      repo,
      workspaceDir: rootDir,
      repoDir,
      branchName,
      isNewWorkspace,
      ...(beforeInitializers ? { beforeInitializers } : {}),
      skipInitializers: true,
    }),
  );

  for await (const event of events) {
    if (event.kind === "worktree-ready") {
      yield { phase: "worktree-ready", hasLockfile: event.hasLockfile };

      try {
        const queued = await startRepoInitialization({
          scope,
          repo,
          setupRunId: session.runId,
        });
        session.emit({
          kind: "repo-handoff",
          repo: repo.name,
          workerPid: queued.pid ?? 0,
        });
      } catch (error) {
        const launchError =
          error instanceof Error ? error : new Error(String(error));
        session.emit({
          kind: "repo-end",
          repo: repo.name,
          outcome: "failed",
          step: "initializer:launch",
          error: toRunEventError(launchError),
        });
        yield {
          phase: "failed",
          step: "initializer:launch",
          error: launchError,
        };
        const finalState = await finalizeWorkspaceInitialization(scope, {
          session,
        });
        emitRunEndIfTerminal(session, finalState);
        return;
      }

      if (monitorBackground) {
        yield* watchRepoInitialization({ scope, repoName: repo.name });
      }
      return;
    }

    for (const state of converter.convert(event)) {
      if (state.phase === "git") {
        // Output chunks stream through the run log; the derived snapshot
        // only tracks step transitions.
        if (state.status !== "output") {
          await recordRepoGitState(scope, repo.name, state);
        }
        yield state;
        continue;
      }

      if (state.phase === "failed") {
        if (!markedFailed) {
          markedFailed = true;
          onFailed?.();
        }
        await recordRepoSetupFailure(scope, repo.name, state.error, state.step);
        const finalState = await finalizeWorkspaceInitialization(scope, {
          session,
        });
        emitRunEndIfTerminal(session, finalState);
        yield state;
        return;
      }

      yield state;
    }
  }
}

export async function addReposToWorkspace({
  workspaceDir,
  repos,
  branchName,
  disabledInitializers,
  interactive = false,
  onEvent,
  renderPipelinesGrid: renderGrid = renderPipelinesGrid,
  shouldUseGrid: useGrid = shouldUseGrid,
}: AddReposOptions): Promise<AddReposResult> {
  if (repos.length === 0) {
    throw new Error("addReposToWorkspace requires at least one repository.");
  }

  const metadata = await readWorkspaceMetadata(workspaceDir);
  if (!metadata) {
    throw new Error(
      `Could not read workspace metadata from ${path.join(workspaceDir, ".workforest")}`,
    );
  }

  const existingNames = new Set(metadata.repos.map((repo) => repo.name));
  const existingRemotes = new Map(
    metadata.repos.map((repo) => [repo.remote, repo.name]),
  );

  for (const repo of repos) {
    const repoName = validateRepositoryComponent(repo.name, "Repository name");
    if (existingNames.has(repoName)) {
      throw new Error(
        `Workspace already contains a repository named "${repoName}".`,
      );
    }

    const existingRemote = existingRemotes.get(repo.remote);
    if (existingRemote) {
      throw new Error(
        `Workspace already contains repository "${existingRemote}" from ${repo.remote}.`,
      );
    }

    const targetDir = resolveContainedPath(workspaceDir, repoName);
    if (await pathExists(targetDir)) {
      throw new Error(
        `Target directory already exists: ${targetDir}\nRefusing to adopt an unmanaged checkout.`,
      );
    }
  }

  const pipelines = new Map(
    repos.map((repo) => [
      repo.name,
      withRepoSetupLog(
        repoPipeline({
          repo,
          workspaceDir,
          branchName,
          isNewWorkspace: false,
          ...(disabledInitializers !== undefined
            ? { disabledInitializers }
            : {}),
        }),
        {
          workspaceDir,
          repoName: repo.name,
          repoDir: resolveContainedPath(workspaceDir, repo.name),
        },
      ),
    ]),
  );

  const failures = new Map<string, Error>();
  const repoNames = repos.map((repo) => repo.name);

  // Interactive terminals get the same setup grid as `wf new`; everything else
  // (non-TTY, CI, WORKFOREST_NO_TUI, small terminal) drains to inline events.
  // Both surfaces return the completed repos and route failures through
  // `onFailure`, so the result contract is identical regardless of which ran.
  const completed = await presentPipelines({
    pipelines,
    repoNames,
    interactive,
    workspacePath: workspaceDir,
    getLogPath: (repoName) => getRepoSetupLogPath({ workspaceDir, repoName }),
    onFailure: (repoName, state) => {
      failures.set(repoName, state.error);
    },
    renderPipelinesGrid: renderGrid,
    shouldUseGrid: useGrid,
    ...(onEvent ? { onEvent } : {}),
  });

  const addedRepos = repos.filter((repo) => completed.has(repo.name));

  if (addedRepos.length > 0) {
    await appendWorkspaceRepos(
      workspaceDir,
      addedRepos.map((repo) => ({
        name: repo.name,
        remote: repo.remote,
        has_lockfile: completed.get(repo.name)?.hasLockfile ?? false,
        feature_branch: branchName,
      })),
    );

    await writeVSCodeWorkspaceFile(
      workspaceDir,
      [
        ...metadata.repos.map((repo) => ({
          name: repo.name,
          remote: repo.remote,
        })),
        ...addedRepos,
      ],
      onEvent ? { onEvent } : {},
    );
  }

  return {
    addedRepos,
    failedRepos: Array.from(failures, ([name, error]) => ({
      name,
      error,
    })),
  };
}

type TemplateCopyBarrier = {
  waitForTemplateFiles(): Promise<void>;
  markRepoFailed(): void;
};

function createTemplateCopyBarrier({
  repoCount,
  copyTemplateFiles,
}: {
  repoCount: number;
  copyTemplateFiles: () => Promise<void>;
}): TemplateCopyBarrier {
  let readyCount = 0;
  let failedCount = 0;
  let copyPromise: Promise<void> | null = null;
  const waiters: {
    resolve: () => void;
    reject: (error: unknown) => void;
  }[] = [];

  const releaseWaiters = (promise: Promise<void>): void => {
    void promise.then(
      () => {
        for (const waiter of waiters.splice(0)) {
          waiter.resolve();
        }
      },
      (error: unknown) => {
        for (const waiter of waiters.splice(0)) {
          waiter.reject(error);
        }
      },
    );
  };

  const maybeCopyTemplate = (): void => {
    if (copyPromise || readyCount + failedCount < repoCount) return;
    copyPromise = copyTemplateFiles();
    releaseWaiters(copyPromise);
  };

  return {
    async waitForTemplateFiles(): Promise<void> {
      readyCount += 1;
      maybeCopyTemplate();

      if (copyPromise) {
        await copyPromise;
        return;
      }

      await new Promise<void>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },

    markRepoFailed(): void {
      failedCount += 1;
      maybeCopyTemplate();
    },
  };
}

export async function createRepoSetupFailureSummary({
  workspaceDir,
  repoName,
  error,
  step,
  initializationScope,
}: {
  workspaceDir: string;
  repoName: string;
  error: Error;
  step?: string;
  initializationScope?: InitializationScope;
}): Promise<RepoSetupFailureSummary> {
  const logPath = await getRepoSetupLogPath({
    workspaceDir,
    repoName,
    ...(initializationScope ? { initializationScope } : {}),
  });
  let logExcerpt: string | null = null;

  try {
    logExcerpt = await readRepoSetupLogExcerpt({
      workspaceDir,
      repoName,
      ...(initializationScope ? { initializationScope } : {}),
    });
  } catch (logError) {
    const message =
      logError instanceof Error ? logError.message : String(logError);
    logExcerpt = `Unable to read recent log output: ${message}`;
  }

  return {
    repoName,
    ...(step ? { step } : {}),
    message: truncateForDisplay(error.message, 500),
    logPath,
    ...(logExcerpt ? { logExcerpt } : {}),
  };
}

/**
 * Build a failure summary from the run session's reduced snapshot: the
 * repo's recent output tail plus a pointer at the persisted run log.
 */
export function createRunFailureSummary({
  session,
  repoName,
  error,
  step,
}: {
  session: RunSession;
  repoName: string;
  error: Error;
  step?: string;
}): RepoSetupFailureSummary {
  const tail = session.snapshot().repos.get(repoName)?.tail ?? [];
  const excerpt = tail.join("\n").trim();
  const logExcerpt =
    excerpt.length > DEFAULT_REPO_SETUP_LOG_EXCERPT_CHARS
      ? `[log truncated to last ${DEFAULT_REPO_SETUP_LOG_EXCERPT_CHARS} characters]\n${excerpt.slice(-DEFAULT_REPO_SETUP_LOG_EXCERPT_CHARS)}`
      : excerpt;

  return {
    repoName,
    ...(step ? { step } : {}),
    message: truncateForDisplay(error.message, 500),
    logPath: session.runDir,
    ...(logExcerpt ? { logExcerpt } : {}),
  };
}

export function printRepoSetupFailures(
  failures: readonly RepoSetupFailureSummary[],
  onEvent?: ServiceEventSink,
): void {
  if (failures.length === 0) {
    return;
  }

  emitServiceEvent(onEvent, {
    type: "message",
    level: "error",
    message: formatRepoSetupFailures(failures),
  });
}

export function formatRepoSetupFailures(
  failures: readonly RepoSetupFailureSummary[],
): string {
  const lines = [
    "Some repositories did not complete setup. The workspace was still created.",
  ];

  for (const failure of failures) {
    lines.push("");
    lines.push(failure.repoName);
    lines.push(`Step: ${failure.step ?? "unknown"}`);
    lines.push(`Error: ${failure.message}`);

    if (failure.logExcerpt) {
      lines.push("Recent log output:");
      for (const line of failure.logExcerpt.split("\n")) {
        lines.push(`  ${line}`);
      }
    }

    lines.push(`Full log: ${failure.logPath}`);
  }

  return lines.join("\n");
}

function truncateForDisplay(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 15)}... [truncated]`;
}

// ============================================================================
// Helper functions
// ============================================================================

export async function ensureCacheDir(): Promise<string> {
  const cacheRoot = getCacheDir();
  await ensureDir(cacheRoot);
  return cacheRoot;
}

export async function writeInitialWorkspaceMetadata({
  workspaceDir,
  featureName,
  description,
  templateId,
  templateVariant,
  branchName,
  repos,
}: Omit<StampWorkspaceOptions, "branchName"> & {
  branchName: string;
}): Promise<void> {
  await writeWorkspaceMetadata(workspaceDir, {
    featureName,
    branchName,
    repos: repos.map((repo) => ({
      name: repo.name,
      remote: repo.remote,
      hasLockfile: false,
    })),
    ...(description && { description }),
    ...(templateId && { templateId }),
    ...(templateVariant && { templateVariant }),
  });
}

async function updatePreparedWorkspaceRepoMetadata({
  workspaceDir,
  branchName,
  repo,
  hasLockfile,
}: {
  workspaceDir: string;
  branchName: string;
  repo: RepositorySource;
  hasLockfile: boolean;
}): Promise<void> {
  await updateWorkspaceRepo(workspaceDir, {
    name: repo.name,
    remote: repo.remote,
    feature_branch: branchName,
    has_lockfile: hasLockfile,
  });
}

function getNextSteps(workspaceDir: string): string[] {
  const workspaceName = path.basename(workspaceDir);
  const vscodePath = `${workspaceName}.code-workspace`;

  if (isShellAutoCdEnabled()) {
    return [`code ${vscodePath}`];
  }

  return [`cd ${workspaceDir}`, `code ${vscodePath}`];
}

export async function writeVSCodeWorkspaceFile(
  workspaceDir: string,
  repos: readonly RepositorySource[],
  { onEvent }: { onEvent?: ServiceEventSink } = {},
): Promise<void> {
  for (const repo of repos) {
    validateRepositoryComponent(repo.name, "Repository name");
  }
  const workspaceName = path.basename(workspaceDir) || "workforest";
  const workspaceFile = path.join(
    workspaceDir,
    `${workspaceName}.code-workspace`,
  );

  let baseContents: Record<string, unknown> = {};
  if (await pathExists(workspaceFile)) {
    try {
      const existing = JSON.parse(await fs.readFile(workspaceFile, "utf8"));
      if (
        existing &&
        typeof existing === "object" &&
        !Array.isArray(existing)
      ) {
        baseContents = existing as Record<string, unknown>;
      }
    } catch {
      emitServiceEvent(onEvent, {
        type: "message",
        level: "warning",
        message: `Unable to parse existing VS Code workspace file at ${workspaceFile}; overwriting it.`,
      });
    }
  }

  const contents = JSON.stringify(
    {
      ...baseContents,
      folders: repos.map((repo) => ({ path: repo.name })),
    },
    null,
    2,
  );

  await fs.writeFile(workspaceFile, `${contents}\n`, "utf8");
  emitServiceEvent(onEvent, {
    type: "message",
    level: "info",
    message: `VS Code workspace saved to ${workspaceFile}`,
  });
}
