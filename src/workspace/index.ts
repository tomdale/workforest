import { promises as fs } from "node:fs";
import path from "node:path";
import { hasAny } from "@wf-plugin/core";
import { getCacheDir } from "../config.ts";
import { log } from "../logger.ts";
import { resolveMirrorDir } from "../repositories.ts";
import { getGitHubSlug } from "../services/git.ts";
import { fetchRepoDiskUsage } from "../services/github.ts";
import {
  type InitializerState,
  runInitializersGenerator,
} from "../services/initializers/index.ts";
import { isShellAutoCdEnabled } from "../shell.ts";
import {
  applyTemplateGenerator,
  copyTemplateFiles,
  type HookState,
} from "../templates/apply.ts";
import { loadTemplate } from "../templates/index.ts";
import { printReport } from "../terminal/report.ts";
import { terminalColor } from "../terminal/theme.ts";
import type { RepoConfig } from "../types.ts";
import { renderPipelinesGrid, shouldUseGrid } from "../ui/grid-consumer.ts";
import { note, promptLog, withSpinner } from "../ui/prompts/index.ts";
import { ensureDir, pathExists } from "../utils/fs.ts";
import type { TaskState } from "../utils/task-generator.ts";
import { runParallel } from "../utils/task-generator.ts";
import {
  appendWorkspaceRepos,
  readWorkspaceMetadata,
  updateWorkspaceRepo,
  writeWorkspaceMetadata,
} from "./metadata.ts";
import { repoPipelineGenerator } from "./pipeline.ts";
import {
  cleanupWorkspaceWorktreesGenerator,
  ensureMirrorRepoGenerator,
  ensureWorkingCopyGenerator,
} from "./repository.ts";
import {
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
  repos: readonly RepoConfig[];
  templateId?: string;
};

export type PreparedRepo = {
  repo: RepoConfig;
  targetDir: string;
  hasLockfile: boolean;
};

export type AddReposOptions = {
  workspaceDir: string;
  repos: readonly RepoConfig[];
  branchName: string;
  disabledInitializers?: boolean | string[];
};

export type AddReposResult = {
  addedRepos: readonly RepoConfig[];
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
};

/**
 * State emitted by the workspace stamping generator.
 */
export type WorkspaceState =
  | { phase: "init"; message: string }
  | { phase: "git"; repo: string; step: "mirror" | "cleanup" | "worktree" }
  | { phase: "git-complete"; repo: string }
  | { phase: "initializers-start"; repoCount: number }
  | { phase: "initializer"; state: InitializerState }
  | { phase: "initializers-complete" }
  | { phase: "hooks-start"; templateId: string }
  | { phase: "hook"; hookState: HookState }
  | { phase: "hooks-complete" }
  | { phase: "finalize"; message: string }
  | { phase: "complete"; workspaceDir: string; repos: readonly RepoConfig[] };

// ============================================================================
// Generator-based workspace stamping
// ============================================================================

/**
 * Generator-based workspace stamping that yields state updates.
 * This allows the UI to have full visibility into the progress of each step.
 */
export async function* stampWorkspaceGenerator({
  featureName,
  description,
  branchName,
  workspaceDir,
  repos,
  templateId,
}: StampWorkspaceOptions): AsyncGenerator<WorkspaceState> {
  if (repos.length === 0) {
    throw new Error(
      "stampWorkspaceGenerator requires at least one repository.",
    );
  }

  // Check if workspace directory already exists and has contents
  if (await pathExists(workspaceDir)) {
    const contents = await fs.readdir(workspaceDir);
    if (contents.length > 0) {
      throw new Error(
        `Directory already exists and is not empty: ${workspaceDir}\nUse a different name or remove the existing directory.`,
      );
    }
  }

  yield { phase: "init", message: "Setting up cache directory" };
  const cacheDir = await ensureCacheDir();
  const effectiveBranchName = branchName ?? featureName;

  // Track if workspace is new (skip cleanup if so - no stale worktrees possible)
  const isNewWorkspace = !(await pathExists(workspaceDir));
  await ensureDir(workspaceDir);

  await writeInitialWorkspaceMetadata({
    workspaceDir,
    featureName,
    branchName: effectiveBranchName,
    repos,
    ...(description !== undefined ? { description } : {}),
    ...(templateId !== undefined ? { templateId } : {}),
  });

  yield { phase: "init", message: `Preparing workspace for "${featureName}"` };

  // Start template loading early (runs in parallel with git operations)
  const templatePromise = templateId ? loadTemplate(templateId) : null;

  // Phase A: Unified parallel git operations per repo
  // Each repo runs: mirror → cleanup (if needed) → worktree → lockfile check
  // This overlaps I/O better than sequential phases
  const preparedRepos: PreparedRepo[] = [];

  // Build repo info map
  const repoInfo = new Map(
    await Promise.all(
      repos.map(
        async (repo) =>
          [
            repo.name,
            {
              repo,
              mirrorDir: await resolveMirrorDir(repo, cacheDir),
              targetDir: path.join(workspaceDir, repo.name),
            },
          ] as const,
      ),
    ),
  );

  // Combined generator for all git operations per repo
  type GitOpState = TaskState & {
    step: "mirror" | "cleanup" | "worktree";
    hasLockfile?: boolean;
  };

  async function* repoGitOperationsGenerator(
    repoName: string,
  ): AsyncGenerator<GitOpState> {
    const info = repoInfo.get(repoName);
    if (!info) return;

    // Step 1: Mirror (fetch or clone)
    for await (const state of ensureMirrorRepoGenerator(
      info.repo,
      info.mirrorDir,
    )) {
      yield { ...state, step: "mirror" as const };
    }

    // Step 2: Cleanup (skip for new workspaces - no stale worktrees possible)
    if (!isNewWorkspace) {
      for await (const state of cleanupWorkspaceWorktreesGenerator(
        info.mirrorDir,
        workspaceDir,
      )) {
        yield { ...state, step: "cleanup" as const };
      }
    }

    // Step 3: Worktree creation
    for await (const state of ensureWorkingCopyGenerator(
      info.repo,
      info.mirrorDir,
      info.targetDir,
      effectiveBranchName,
    )) {
      yield { ...state, step: "worktree" as const };
    }

    // Step 4: Check for lockfile (done here to avoid sequential loop later)
    const hasLockfile = await hasAny(info.targetDir, [
      "pnpm-lock.yaml",
      "pnpm-lock.yml",
    ]);

    // Yield final state with lockfile info
    yield {
      status: "completed" as const,
      step: "worktree" as const,
      hasLockfile,
    };
  }

  // Run all repos in parallel
  const gitTasks = new Map(
    repos.map((repo) => [repo.name, repoGitOperationsGenerator(repo.name)]),
  );

  for await (const { id, state } of runParallel(gitTasks)) {
    yield { phase: "git", repo: id, step: state.step };

    // Collect prepared repo info when worktree completes
    if (state.status === "completed" && state.hasLockfile !== undefined) {
      const info = repoInfo.get(id);
      if (info) {
        preparedRepos.push({
          repo: info.repo,
          targetDir: info.targetDir,
          hasLockfile: state.hasLockfile,
        });
        await updatePreparedWorkspaceRepoMetadata({
          workspaceDir,
          branchName: effectiveBranchName,
          repo: info.repo,
          hasLockfile: state.hasLockfile,
        });
      }
    }
  }

  // Mark all repos as git-complete
  for (const repo of repos) {
    yield { phase: "git-complete", repo: repo.name };
  }

  // Await template (should be ready by now, was loading in parallel)
  const template = templatePromise ? await templatePromise : null;

  if (template && templateId) {
    await copyTemplateFiles(template, workspaceDir);
  }

  // Phase B: Run initializers (package managers, vercel link, turbo link, etc.)
  const contexts = preparedRepos.map((r) => ({
    repoDir: r.targetDir,
    workspaceDir,
    repo: r.repo,
  }));

  yield { phase: "initializers-start", repoCount: contexts.length };

  for await (const state of runInitializersGenerator({
    contexts,
    ...(template?.config.disableInitializers !== undefined
      ? { disabledInitializers: template.config.disableInitializers }
      : {}),
  })) {
    yield { phase: "initializer", state };
  }

  yield { phase: "initializers-complete" };

  // Phase C: Run template hooks
  if (template && templateId) {
    if (template.config.hooks && template.config.hooks.length > 0) {
      yield { phase: "hooks-start", templateId };

      for await (const hookState of applyTemplateGenerator({
        template,
        workspaceDir,
        repoDirs: preparedRepos.map((r) => r.repo.name),
      })) {
        yield { phase: "hook", hookState };
      }

      yield { phase: "hooks-complete" };
    }
  }

  // Phase D: Finalize
  yield { phase: "finalize", message: "Writing workspace metadata" };
  await writeWorkspaceMetadata(workspaceDir, {
    featureName,
    branchName: effectiveBranchName,
    repos: preparedRepos.map((r) => ({
      name: r.repo.name,
      remote: r.repo.remote,
      defaultBranch: r.repo.defaultBranch,
      hasLockfile: r.hasLockfile,
    })),
    ...(description && { description }),
    ...(templateId && { templateId }),
  });

  yield { phase: "finalize", message: "Writing VS Code workspace file" };
  await writeVSCodeWorkspaceFile(workspaceDir, repos);

  yield { phase: "complete", workspaceDir, repos };
}

/**
 * Run the workspace stamping with simple console logging.
 * This is for non-TUI usage.
 */
export async function stampWorkspace(
  options: StampWorkspaceOptions,
): Promise<void> {
  for await (const state of stampWorkspaceGenerator(options)) {
    switch (state.phase) {
      case "init":
        log.info(state.message);
        break;
      case "git":
        log.info(`${state.repo}: ${state.step}`);
        break;
      case "git-complete":
        log.success(`${state.repo}: git setup complete`);
        break;
      case "initializers-start":
        log.info(`Running initializers for ${state.repoCount} repositories...`);
        break;
      case "initializer": {
        const { state: initState } = state;
        if (initState.phase === "detecting") {
          log.info(`${initState.repoName}: detecting project type`);
        } else if (initState.phase === "running") {
          const { state: taskState } = initState;
          if (taskState.status === "running" && taskState.message) {
            log.info(
              `${initState.repoName}: ${initState.initializerName} - ${taskState.message}`,
            );
          } else if (taskState.status === "completed") {
            log.success(
              `${initState.repoName}: ${initState.initializerName} complete`,
            );
          } else if (taskState.status === "failed") {
            log.error(
              `${initState.repoName}: ${initState.initializerName} failed - ${taskState.error.message}`,
            );
          } else if (taskState.status === "retrying") {
            log.warn(
              `${initState.repoName}: ${initState.initializerName} - ${taskState.reason}, retrying...`,
            );
          }
        } else if (initState.phase === "skipped") {
          log.info(
            `${initState.repoName}: ${initState.initializerId} skipped - ${initState.reason}`,
          );
        } else if (initState.phase === "repo-complete") {
          log.success(`${initState.repoName}: initializers complete`);
        }
        break;
      }
      case "initializers-complete":
        log.success("All initializers completed.");
        break;
      case "hooks-start":
        log.info(`Running hooks from template "${state.templateId}"...`);
        break;
      case "hook": {
        const { hookState } = state;
        if (hookState.phase === "hook-start") {
          log.info(`Running hook: ${hookState.hookName}`);
        } else if (hookState.phase === "hook-complete") {
          log.success(`Hook complete: ${hookState.hookName}`);
        } else if (hookState.phase === "hook") {
          const { state: taskState } = hookState;
          if (taskState.status === "failed") {
            log.error(`Hook failed: ${taskState.error.message}`);
          } else if (taskState.status === "skipped") {
            log.info(`Hook skipped: ${taskState.reason}`);
          }
        }
        break;
      }
      case "hooks-complete":
        log.success("All hooks completed.");
        break;
      case "finalize":
        log.info(state.message);
        break;
      case "complete": {
        log.success("Workspace ready!");
        printReport({
          title: "Next steps",
          sections: [
            {
              entries: getNextSteps(state.workspaceDir).map((step) => ({
                title: step,
              })),
            },
          ],
          footer: `Workspace: ${state.workspaceDir}`,
        });
        break;
      }
    }
  }
}

/**
 * Interactive workspace stamping with grid or spinner progress.
 * Uses a tmux-style grid layout for concurrent repo output when terminal supports it.
 * Falls back to spinner for non-TTY, small terminals, or CI environments.
 */
export async function stampWorkspaceInteractive(
  options: StampWorkspaceOptions,
): Promise<StampWorkspaceResult> {
  const {
    featureName,
    description,
    branchName,
    workspaceDir,
    repos,
    templateId,
  } = options;

  if (repos.length === 0) {
    throw new Error(
      "stampWorkspaceInteractive requires at least one repository.",
    );
  }

  // Check if workspace directory already exists and has contents
  if (await pathExists(workspaceDir)) {
    const contents = await fs.readdir(workspaceDir);
    if (contents.length > 0) {
      throw new Error(
        `Directory already exists and is not empty: ${workspaceDir}\nUse a different name or remove the existing directory.`,
      );
    }
  }

  const { isNewWorkspace, template } = await withSpinner(
    "Setting up workspace...",
    async () => {
      await ensureCacheDir();

      // Track if workspace is new (skip cleanup if so - no stale worktrees possible)
      const isNewWorkspace = !(await pathExists(workspaceDir));
      await ensureDir(workspaceDir);

      // Load template settings before creating repo pipelines.
      const template = templateId ? await loadTemplate(templateId) : null;

      return { isNewWorkspace, template };
    },
    "Starting repository setup...",
  );

  const effectiveBranchName = branchName ?? featureName;
  await writeInitialWorkspaceMetadata({
    workspaceDir,
    featureName,
    branchName: effectiveBranchName,
    repos,
    ...(description !== undefined ? { description } : {}),
    ...(templateId !== undefined ? { templateId } : {}),
  });

  const repoNames = repos.map((r) => r.name);
  const repoFailures = new Map<string, RepoSetupFailureSummary>();
  const preparedRepoMetadata = new Map<
    string,
    { repo: RepoConfig; hasLockfile: boolean }
  >();
  const templateBarrier =
    template !== null
      ? createTemplateCopyBarrier({
          repoCount: repos.length,
          copyTemplateFiles: () => copyTemplateFiles(template, workspaceDir),
        })
      : null;

  async function recordRepoFailure(
    repoName: string,
    failure: { error: Error; step?: string },
  ): Promise<void> {
    repoFailures.set(
      repoName,
      await createRepoSetupFailureSummary({
        workspaceDir,
        repoName,
        error: failure.error,
        ...(failure.step ? { step: failure.step } : {}),
      }),
    );
  }

  async function beforeInitializers({
    repo,
    repoDir,
  }: {
    repo: RepoConfig;
    repoDir: string;
  }): Promise<void> {
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
    preparedRepoMetadata.set(repo.name, { repo, hasLockfile });

    await templateBarrier?.waitForTemplateFiles();
  }

  // Create per-repo pipeline generators
  const pipelines = new Map(
    repos.map((repo) => [
      repo.name,
      reportPipelineFailureToTemplateBarrier(
        withRepoSetupLog(
          repoPipelineGenerator({
            repo,
            workspaceDir,
            branchName: effectiveBranchName,
            isNewWorkspace,
            beforeInitializers,
            ...(template?.config.disableInitializers !== undefined
              ? { disabledInitializers: template.config.disableInitializers }
              : {}),
          }),
          {
            workspaceDir,
            repoName: repo.name,
            repoDir: path.join(workspaceDir, repo.name),
          },
        ),
        templateBarrier,
      ),
    ]),
  );

  // Run all repo pipelines in parallel (git + initializers per repo)
  let repoResults: Map<string, { hasLockfile: boolean }>;
  const useGrid = shouldUseGrid(repos.length) && repos.length > 1;

  async function finalizeWorkspace(
    results: Map<string, { hasLockfile: boolean }>,
  ): Promise<void> {
    const completedRepos = repos.filter((repo) => results.has(repo.name));
    const completedRepoNames = completedRepos.map((repo) => repo.name);

    for (const repo of completedRepos) {
      const hasLockfile = results.get(repo.name)?.hasLockfile ?? false;
      await updatePreparedWorkspaceRepoMetadata({
        workspaceDir,
        branchName: effectiveBranchName,
        repo,
        hasLockfile,
      });
      preparedRepoMetadata.set(repo.name, { repo, hasLockfile });
    }

    // Hooks run after all repos complete (can reference multiple repos).
    if (template?.config.hooks && template.config.hooks.length > 0) {
      for await (const hookState of applyTemplateGenerator({
        template,
        workspaceDir,
        repoDirs: completedRepoNames,
      })) {
        if (hookState.phase === "hook") {
          const { state: taskState } = hookState;
          if (taskState.status === "failed") {
            promptLog.error(`Hook failed: ${hookState.hookName}`);
          }
        }
      }
    }

    const reposWithWorktrees = repos.filter((repo) =>
      preparedRepoMetadata.has(repo.name),
    );
    const preparedRepos = repos.map((repo) => ({
      name: repo.name,
      remote: repo.remote,
      defaultBranch: repo.defaultBranch,
      hasLockfile: preparedRepoMetadata.get(repo.name)?.hasLockfile ?? false,
    }));

    await writeWorkspaceMetadata(workspaceDir, {
      featureName,
      branchName: effectiveBranchName,
      repos: preparedRepos,
      ...(description && { description }),
      ...(templateId && { templateId }),
    });

    await writeVSCodeWorkspaceFile(workspaceDir, reposWithWorktrees, {
      logOutput: !useGrid,
    });
  }

  if (useGrid) {
    // Grid mode: visual concurrent output
    repoResults = await renderPipelinesGrid({
      pipelines,
      repoNames,
      workspacePath: workspaceDir,
      getLogPath: (repoName) => getRepoSetupLogPath({ workspaceDir, repoName }),
      onFailure: recordRepoFailure,
      onBeforeCompletionPrompt: finalizeWorkspace,
    });
  } else {
    // Spinner mode: simple progress indicator
    repoResults = await runPipelinesWithSpinner({
      pipelines,
      onFailure: recordRepoFailure,
    });
    await withSpinner(
      "Finalizing workspace...",
      () => finalizeWorkspace(repoResults),
      "Workspace finalized",
    );
  }

  note(getNextSteps(workspaceDir).join("\n"), "Next steps");

  return {
    setupFailures: [...repoFailures.values()],
  };
}

export async function addReposToWorkspace({
  workspaceDir,
  repos,
  branchName,
  disabledInitializers,
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
    if (existingNames.has(repo.name)) {
      throw new Error(
        `Workspace already contains a repository named "${repo.name}".`,
      );
    }

    const existingRemote = existingRemotes.get(repo.remote);
    if (existingRemote) {
      throw new Error(
        `Workspace already contains repository "${existingRemote}" from ${repo.remote}.`,
      );
    }

    const targetDir = path.join(workspaceDir, repo.name);
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
        repoPipelineGenerator({
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
          repoDir: path.join(workspaceDir, repo.name),
        },
      ),
    ]),
  );

  const completed = new Map<string, { hasLockfile: boolean }>();
  const failures = new Map<string, Error>();

  for await (const { id, state } of runParallel(pipelines)) {
    switch (state.phase) {
      case "git":
        if (state.status === "running" && state.message) {
          log.info(`${id}: ${state.step} - ${state.message}`);
        } else if (state.status === "retrying" && state.message) {
          log.warn(`${id}: ${state.step} - ${state.message}`);
        } else if (state.status === "completed") {
          log.success(`${id}: ${state.step} complete`);
        } else if (state.status === "failed") {
          log.error(`${id}: ${state.step} failed`);
        }
        break;

      case "initializer":
        if (state.status === "running" && state.message) {
          log.info(`${id}: ${state.name} - ${state.message}`);
        } else if (state.status === "retrying" && state.message) {
          log.warn(`${id}: ${state.name} - ${state.message}`);
        } else if (state.status === "completed") {
          log.success(`${id}: ${state.name} complete`);
        } else if (state.status === "failed") {
          log.error(`${id}: ${state.name} failed`);
        }
        break;

      case "complete":
        completed.set(id, { hasLockfile: state.hasLockfile });
        break;

      case "failed":
        failures.set(id, state.error);
        log.error(`${id}: ${state.error.message}`);
        log.error(
          `${id}: setup log saved to ${await getRepoSetupLogPath({
            workspaceDir,
            repoName: id,
          })}`,
        );
        break;
    }
  }

  const addedRepos = repos.filter((repo) => completed.has(repo.name));

  if (addedRepos.length > 0) {
    await appendWorkspaceRepos(
      workspaceDir,
      addedRepos.map((repo) => ({
        name: repo.name,
        remote: repo.remote,
        default_branch: repo.defaultBranch,
        has_lockfile: completed.get(repo.name)?.hasLockfile ?? false,
        feature_branch: branchName,
      })),
    );

    await writeVSCodeWorkspaceFile(workspaceDir, [
      ...metadata.repos.map((repo) => ({
        name: repo.name,
        remote: repo.remote,
        defaultBranch: repo.default_branch,
      })),
      ...addedRepos,
    ]);
  }

  return {
    addedRepos,
    failedRepos: Array.from(failures, ([name, error]) => ({
      name,
      error,
    })),
  };
}

/**
 * Run pipelines with a simple spinner (fallback for non-grid mode).
 */
async function runPipelinesWithSpinner({
  pipelines,
  onFailure,
}: {
  pipelines: Map<
    string,
    AsyncGenerator<import("./pipeline.ts").RepoPipelineState>
  >;
  onFailure?: (
    repoName: string,
    state: Extract<
      import("./pipeline.ts").RepoPipelineState,
      { phase: "failed" }
    >,
  ) => void | Promise<void>;
}): Promise<Map<string, { hasLockfile: boolean }>> {
  return withSpinner(
    "Setting up repositories...",
    async (s) => {
      const results = new Map<string, { hasLockfile: boolean }>();
      const repoPhases = new Map<string, string>();

      for await (const { id, state } of runParallel(pipelines)) {
        switch (state.phase) {
          case "git":
            repoPhases.set(id, state.step);
            s.message(`${id}: ${state.step}`);
            break;

          case "initializer":
            repoPhases.set(id, state.name);
            s.message(`${id}: ${state.name}`);
            break;

          case "complete":
            repoPhases.set(id, "complete");
            results.set(id, { hasLockfile: state.hasLockfile });
            break;

          case "failed":
            repoPhases.set(id, "failed");
            await onFailure?.(id, state);
            break;
        }
      }

      return results;
    },
    "Repository setup complete",
  );
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

async function* reportPipelineFailureToTemplateBarrier(
  pipeline: AsyncGenerator<import("./pipeline.ts").RepoPipelineState>,
  barrier: TemplateCopyBarrier | null,
): AsyncGenerator<import("./pipeline.ts").RepoPipelineState> {
  let markedFailed = false;

  for await (const state of pipeline) {
    if (state.phase === "failed" && !markedFailed) {
      markedFailed = true;
      barrier?.markRepoFailed();
    }

    yield state;
  }
}

async function createRepoSetupFailureSummary({
  workspaceDir,
  repoName,
  error,
  step,
}: {
  workspaceDir: string;
  repoName: string;
  error: Error;
  step?: string;
}): Promise<RepoSetupFailureSummary> {
  const logPath = await getRepoSetupLogPath({ workspaceDir, repoName });
  let logExcerpt: string | null = null;

  try {
    logExcerpt = await readRepoSetupLogExcerpt({ workspaceDir, repoName });
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

export function printRepoSetupFailures(
  failures: readonly RepoSetupFailureSummary[],
): void {
  if (failures.length === 0) {
    return;
  }

  process.stdout.write(
    `${terminalColor.error(formatRepoSetupFailures(failures))}\n`,
  );
}

function formatRepoSetupFailures(
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
      defaultBranch: repo.defaultBranch,
      hasLockfile: false,
    })),
    ...(description && { description }),
    ...(templateId && { templateId }),
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
  repo: RepoConfig;
  hasLockfile: boolean;
}): Promise<void> {
  await updateWorkspaceRepo(workspaceDir, {
    name: repo.name,
    remote: repo.remote,
    default_branch: repo.defaultBranch,
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

async function writeVSCodeWorkspaceFile(
  workspaceDir: string,
  repos: readonly RepoConfig[],
  { logOutput = true }: { logOutput?: boolean } = {},
): Promise<void> {
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
      log.warn(
        `Unable to parse existing VS Code workspace file at ${workspaceFile}; overwriting it.`,
      );
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
  if (logOutput) {
    log.info(`VS Code workspace saved to ${workspaceFile}`);
  }
}

const LARGE_REPO_THRESHOLD_MB = 500;

export async function warnAboutLargeRepositories(
  repos: readonly RepoConfig[],
): Promise<void> {
  await Promise.all(
    repos.map(async (repo) => {
      const slug = getGitHubSlug(repo.remote);
      if (!slug) {
        return;
      }

      const { sizeBytes } = await fetchRepoDiskUsage(slug);
      if (sizeBytes === null) {
        return;
      }

      const sizeMB = sizeBytes / (1024 * 1024);
      if (sizeMB >= LARGE_REPO_THRESHOLD_MB) {
        const sizeString = sizeMB.toFixed(1);
        log.warn(
          `Repository ${repo.name} is approximately ${sizeString} MB and may take a while to mirror.`,
        );
      }
    }),
  );
}
