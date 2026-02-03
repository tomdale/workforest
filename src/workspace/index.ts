import { promises as fs } from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import { getCacheDir } from "../config.ts";
import { log } from "../logger.ts";
import { getGitHubSlug } from "../services/git.ts";
import { fetchRepoDiskUsage } from "../services/github.ts";
import {
  type InitializerState,
  runInitializersGenerator,
} from "../services/initializers/index.ts";
import { hasAny } from "../services/pnpm.ts";
import { applyTemplateGenerator, type HookState } from "../templates/apply.ts";
import { loadTemplate } from "../templates/index.ts";
import type { RepoConfig } from "../types.ts";
import { ensureDir, pathExists } from "../utils/fs.ts";
import type { TaskState } from "../utils/task-generator.ts";
import { runParallel } from "../utils/task-generator.ts";
import { writeWorkspaceMetadata } from "./metadata.ts";
import {
  cleanupWorkspaceWorktreesGenerator,
  ensureMirrorRepoGenerator,
  ensureWorkingCopyGenerator,
} from "./repository.ts";

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

  // Track if workspace is new (skip cleanup if so - no stale worktrees possible)
  const isNewWorkspace = !(await pathExists(workspaceDir));
  await ensureDir(workspaceDir);

  yield { phase: "init", message: `Preparing workspace for "${featureName}"` };

  // Start template loading early (runs in parallel with git operations)
  const templatePromise = templateId ? loadTemplate(templateId) : null;

  // Phase A: Unified parallel git operations per repo
  // Each repo runs: mirror → cleanup (if needed) → worktree → lockfile check
  // This overlaps I/O better than sequential phases
  const effectiveBranchName = branchName ?? featureName;
  const preparedRepos: PreparedRepo[] = [];

  // Build repo info map
  const repoInfo = new Map(
    repos.map((repo) => [
      repo.name,
      {
        repo,
        mirrorDir: path.join(cacheDir, `${repo.name}.git`),
        targetDir: path.join(workspaceDir, repo.name),
      },
    ]),
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
      }
    }
  }

  // Mark all repos as git-complete
  for (const repo of repos) {
    yield { phase: "git-complete", repo: repo.name };
  }

  // Await template (should be ready by now, was loading in parallel)
  const template = templatePromise ? await templatePromise : null;

  // Phase B: Run initializers (package managers, vercel link, turbo link, etc.)
  const contexts = preparedRepos.map((r) => ({
    repoDir: r.targetDir,
    workspaceDir,
    repo: r.repo,
  }));

  yield { phase: "initializers-start", repoCount: contexts.length };

  for await (const state of runInitializersGenerator({
    contexts,
    disabledInitializers: template?.config.disableInitializers,
  })) {
    yield { phase: "initializer", state };
  }

  yield { phase: "initializers-complete" };

  // Phase C: Run template hooks
  if (template) {
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
        const workspaceName = path.basename(state.workspaceDir);
        const vscodePath = `${workspaceName}.code-workspace`;

        log.success("Workspace ready!");
        console.log();
        console.log("Next steps:");
        console.log(`  cd ${state.workspaceDir}`);
        console.log(`  code ${vscodePath}`);
        console.log();
        break;
      }
    }
  }
}

/**
 * Interactive workspace stamping with clack spinner progress.
 * Provides a polished user experience with real-time feedback.
 */
export async function stampWorkspaceInteractive(
  options: StampWorkspaceOptions,
): Promise<void> {
  const s = p.spinner();
  let lastRepo = "";

  for await (const state of stampWorkspaceGenerator(options)) {
    switch (state.phase) {
      case "init":
        s.start(state.message);
        break;

      case "git":
        // Show current repo and step
        if (state.repo !== lastRepo) {
          lastRepo = state.repo;
        }
        s.message(`${state.repo}: ${state.step}`);
        break;

      case "git-complete":
        // Just update spinner, don't stop
        break;

      case "initializers-start":
        s.message("Running initializers...");
        break;

      case "initializer": {
        const { state: initState } = state;
        if (initState.phase === "running") {
          const { state: taskState } = initState;
          if (taskState.status === "running" && taskState.message) {
            s.message(`${initState.repoName}: ${taskState.message}`);
          } else if (taskState.status === "failed") {
            // Log errors but continue
            p.log.error(
              `${initState.repoName}: ${initState.initializerName} failed`,
            );
          }
        }
        break;
      }

      case "initializers-complete":
        break;

      case "hooks-start":
        s.message("Running template hooks...");
        break;

      case "hook": {
        const { hookState } = state;
        if (hookState.phase === "hook-start") {
          s.message(`Hook: ${hookState.hookName}`);
        } else if (hookState.phase === "hook") {
          const { state: taskState } = hookState;
          if (taskState.status === "failed") {
            p.log.error(`Hook failed: ${hookState.hookName}`);
          }
        }
        break;
      }

      case "hooks-complete":
        break;

      case "finalize":
        s.message(state.message);
        break;

      case "complete": {
        s.stop("Workspace ready!");

        const workspaceName = path.basename(state.workspaceDir);

        p.note(
          `cd ${state.workspaceDir}\ncode ${workspaceName}.code-workspace`,
          "Next steps",
        );
        break;
      }
    }
  }
}

// ============================================================================
// Helper functions
// ============================================================================

export async function ensureCacheDir(): Promise<string> {
  const cacheRoot = getCacheDir();
  await ensureDir(cacheRoot);
  return cacheRoot;
}

async function writeVSCodeWorkspaceFile(
  workspaceDir: string,
  repos: readonly RepoConfig[],
): Promise<void> {
  const workspaceName = path.basename(workspaceDir) || "workforest";
  const workspaceFile = path.join(
    workspaceDir,
    `${workspaceName}.code-workspace`,
  );

  const contents = JSON.stringify(
    { folders: repos.map((repo) => ({ path: repo.name })) },
    null,
    2,
  );

  await fs.writeFile(workspaceFile, `${contents}\n`, "utf8");
  log.info(`VS Code workspace saved to ${workspaceFile}`);
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
