import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "../logger.ts";
import { getGitHubSlug } from "../services/git.ts";
import { fetchRepoDiskUsage } from "../services/github.ts";
import { runPostInstallHook } from "../services/hooks.ts";
import { hasAny, installDependencies } from "../services/pnpm.ts";
import { applyTemplateGenerator } from "../templates/apply.ts";
import { loadTemplate } from "../templates/index.ts";
import type { RepoConfig } from "../types.ts";
import { ensureDir } from "../utils/fs.ts";
import type { TaskState } from "../utils/task-generator.ts";
import { runParallel } from "../utils/task-generator.ts";
import { writeWorkspaceMetadata } from "./metadata.ts";
import {
  ensureMirrorRepoGenerator,
  ensureWorkingCopyGenerator,
} from "./repository.ts";

// ============================================================================
// Types
// ============================================================================

export type StampWorkspaceOptions = {
  featureName: string;
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
  | { phase: "git"; repo: string; state: TaskState }
  | { phase: "git-complete"; repo: string }
  | { phase: "install-start"; repos: PreparedRepo[] }
  | { phase: "install"; repo: string; state: TaskState }
  | {
      phase: "log";
      repo: string;
      level: "info" | "warn" | "error";
      message: string;
    }
  | { phase: "hooks"; repo: string; hook: string; state: TaskState }
  | { phase: "template"; state: TaskState }
  | { phase: "finalize"; message: string }
  | { phase: "complete" };

// ============================================================================
// Generator-based workspace stamping
// ============================================================================

/**
 * Helper generator that combines git mirror and worktree setup for a single repo.
 * Yields TaskState updates that can be forwarded to the UI.
 */
async function* gitSetupGenerator(
  repo: RepoConfig,
  cacheDir: string,
  targetDir: string,
  featureName: string,
): AsyncGenerator<TaskState, void, undefined> {
  const mirrorDir = path.join(cacheDir, `${repo.name}.git`);

  // Ensure mirror exists (includes prune)
  yield* ensureMirrorRepoGenerator(repo, mirrorDir);

  // Create worktree
  yield* ensureWorkingCopyGenerator(repo, mirrorDir, targetDir, featureName);
}

/**
 * Generator-based workspace stamping that yields state updates.
 * This allows the UI to have full visibility into the progress of each step.
 */
export async function* stampWorkspaceGenerator({
  featureName,
  workspaceDir,
  repos,
  templateId,
}: StampWorkspaceOptions): AsyncGenerator<WorkspaceState> {
  if (repos.length === 0) {
    throw new Error(
      "stampWorkspaceGenerator requires at least one repository.",
    );
  }

  yield { phase: "init", message: "Setting up cache directory" };
  const cacheDir = await ensureCacheDir();
  await ensureDir(workspaceDir);

  yield { phase: "init", message: `Preparing workspace for "${featureName}"` };

  // Phase A: Parallel git operations
  const gitTasks = new Map(
    repos.map((repo) => [
      repo.name,
      gitSetupGenerator(
        repo,
        cacheDir,
        path.join(workspaceDir, repo.name),
        featureName,
      ),
    ]),
  );

  for await (const { id, state } of runParallel(gitTasks)) {
    yield { phase: "git", repo: id, state };
  }

  // Mark all repos as git-complete and check for lockfiles
  const preparedRepos: PreparedRepo[] = [];
  for (const repo of repos) {
    yield { phase: "git-complete", repo: repo.name };

    const targetDir = path.join(workspaceDir, repo.name);
    const hasLockfile = await hasAny(targetDir, [
      "pnpm-lock.yaml",
      "pnpm-lock.yml",
    ]);
    preparedRepos.push({ repo, targetDir, hasLockfile });
  }

  // Phase B: Parallel pnpm installs
  const reposWithLockfiles = preparedRepos.filter((r) => r.hasLockfile);

  if (reposWithLockfiles.length > 0) {
    yield { phase: "install-start", repos: reposWithLockfiles };

    const installTasks = new Map(
      reposWithLockfiles.map(({ repo, targetDir }) => [
        repo.name,
        installDependencies(repo, targetDir),
      ]),
    );

    for await (const { id, state } of runParallel(installTasks)) {
      yield { phase: "install", repo: id, state };
    }
  }

  // Phase C: Run post-install hooks (if template is specified with hooks)
  if (templateId) {
    const template = await loadTemplate(templateId);
    if (template?.postInstallHooks && template.postInstallHooks.length > 0) {
      for (const hook of template.postInstallHooks) {
        for (const { repo, targetDir } of preparedRepos) {
          for await (const state of runPostInstallHook(hook, targetDir)) {
            yield { phase: "hooks", repo: repo.name, hook: hook.name, state };
          }
        }
      }
    }
  }

  // Phase D: Apply template (if specified)
  if (templateId) {
    const template = await loadTemplate(templateId);
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }

    for await (const state of applyTemplateGenerator({
      template,
      workspaceDir,
    })) {
      yield { phase: "template", state };
    }
  }

  // Phase E: Finalize
  yield { phase: "finalize", message: "Writing workspace metadata" };
  await writeWorkspaceMetadata(workspaceDir, {
    featureName,
    templateId,
    repos: preparedRepos.map(({ repo, hasLockfile }) => ({
      name: repo.name,
      remote: repo.remote,
      defaultBranch: repo.defaultBranch,
      hasLockfile,
    })),
  });

  yield { phase: "finalize", message: "Writing VS Code workspace file" };
  await writeVSCodeWorkspaceFile(workspaceDir, repos);

  yield { phase: "complete" };
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
        if (state.state.status === "running" && state.state.message) {
          log.info(`${state.repo}: ${state.state.message}`);
        } else if (state.state.status === "completed") {
          // Silently complete - git-complete phase will log success
        } else if (state.state.status === "failed") {
          log.error(`${state.repo}: git failed - ${state.state.error.message}`);
        } else if (state.state.status === "log") {
          log[state.state.level](`${state.repo}: ${state.state.message}`);
        }
        break;
      case "git-complete":
        log.success(`${state.repo}: git setup complete`);
        break;
      case "install-start":
        log.info(
          `Installing dependencies for: ${state.repos.map((r) => r.repo.name).join(", ")}`,
        );
        break;
      case "install":
        if (state.state.status === "running" && state.state.message) {
          log.info(`${state.repo}: ${state.state.message}`);
        } else if (state.state.status === "completed") {
          log.success(`${state.repo}: dependencies installed`);
        } else if (state.state.status === "failed") {
          log.error(
            `${state.repo}: install failed - ${state.state.error.message}`,
          );
        } else if (state.state.status === "skipped") {
          log.info(`${state.repo}: ${state.state.reason}`);
        } else if (state.state.status === "retrying") {
          log.warn(`${state.repo}: ${state.state.reason}, retrying...`);
        } else if (state.state.status === "log") {
          log[state.state.level](`${state.repo}: ${state.state.message}`);
        }
        break;
      case "log":
        log[state.level](`${state.repo}: ${state.message}`);
        break;
      case "hooks":
        if (state.state.status === "running" && state.state.message) {
          log.info(`${state.repo}: ${state.state.message}`);
        } else if (state.state.status === "completed") {
          log.success(`${state.repo}: ${state.hook} completed`);
        } else if (state.state.status === "failed") {
          log.error(
            `${state.repo}: ${state.hook} failed - ${state.state.error.message}`,
          );
        } else if (state.state.status === "skipped") {
          log.info(`${state.repo}: ${state.hook} - ${state.state.reason}`);
        } else if (state.state.status === "retrying") {
          log.warn(`${state.repo}: ${state.state.reason}, retrying...`);
        } else if (state.state.status === "log") {
          log[state.state.level](`${state.repo}: ${state.state.message}`);
        }
        break;
      case "template":
        if (state.state.status === "running" && state.state.message) {
          log.info(`Template: ${state.state.message}`);
        } else if (state.state.status === "completed") {
          log.success("Template applied successfully");
        } else if (state.state.status === "failed") {
          log.error(
            `Template application failed - ${state.state.error.message}`,
          );
        } else if (state.state.status === "log") {
          log[state.state.level](`Template: ${state.state.message}`);
        }
        break;
      case "finalize":
        log.info(state.message);
        break;
      case "complete":
        log.success("Workspace ready.");
        break;
    }
  }
}

// ============================================================================
// Helper functions
// ============================================================================

export async function ensureCacheDir(): Promise<string> {
  const cacheHome =
    process.env["XDG_CACHE_HOME"] ?? path.join(os.homedir(), ".cache");
  const cacheRoot = path.join(cacheHome, "workforest");
  await ensureDir(cacheRoot);
  return cacheRoot;
}

async function writeVSCodeWorkspaceFile(
  workspaceDir: string,
  repos: readonly RepoConfig[],
): Promise<void> {
  const workspaceName = path.basename(workspaceDir) || "workspace";
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

type LargeRepoWarning = {
  repo: string;
  level: "warn";
  message: string;
};

export async function warnAboutLargeRepositories(
  repos: readonly RepoConfig[],
): Promise<LargeRepoWarning[]> {
  const warnings: LargeRepoWarning[] = [];

  await Promise.all(
    repos.map(async (repo) => {
      const slug = getGitHubSlug(repo.remote);
      if (!slug) {
        return;
      }

      const { sizeBytes, messages } = await fetchRepoDiskUsage(slug);

      // Forward any warnings from fetchRepoDiskUsage
      for (const msg of messages) {
        warnings.push({
          repo: repo.name,
          level: msg.level,
          message: msg.message,
        });
      }

      if (sizeBytes === null) {
        return;
      }

      const sizeMB = sizeBytes / (1024 * 1024);
      if (sizeMB >= LARGE_REPO_THRESHOLD_MB) {
        const sizeString = sizeMB.toFixed(1);
        warnings.push({
          repo: repo.name,
          level: "warn",
          message: `Repository ${repo.name} is approximately ${sizeString} MB and may take a while to mirror.`,
        });
      }
    }),
  );

  // Log warnings in non-TUI mode
  for (const warning of warnings) {
    log.warn(`${warning.repo}: ${warning.message}`);
  }

  return warnings;
}
