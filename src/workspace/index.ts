import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "../logger.ts";
import { getGitHubSlug } from "../services/git.ts";
import { fetchRepoDiskUsage } from "../services/github.ts";
import { hasAny, installDependencies } from "../services/pnpm.ts";
import type { RepoConfig } from "../types.ts";
import { ensureDir } from "../utils/fs.ts";
import type { TaskState } from "../utils/task-generator.ts";
import { runParallel } from "../utils/task-generator.ts";
import {
  cleanupWorkspaceWorktrees,
  ensureMirrorRepo,
  ensureWorkingCopy,
} from "./repository.ts";

// ============================================================================
// Types
// ============================================================================

export type StampWorkspaceOptions = {
  featureName: string;
  branchName?: string;
  workspaceDir: string;
  repos: readonly RepoConfig[];
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
  | { phase: "install-start"; repos: PreparedRepo[] }
  | { phase: "install"; repo: string; state: TaskState }
  | { phase: "finalize"; message: string }
  | { phase: "complete" };

// ============================================================================
// Generator-based workspace stamping
// ============================================================================

/**
 * Generator-based workspace stamping that yields state updates.
 * This allows the UI to have full visibility into the progress of each step.
 */
export async function* stampWorkspaceGenerator({
  featureName,
  branchName,
  workspaceDir,
  repos,
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

  // Phase A: Sequential git operations
  const effectiveBranchName = branchName ?? featureName;
  const preparedRepos: PreparedRepo[] = [];

  for (const repo of repos) {
    const mirrorDir = path.join(cacheDir, `${repo.name}.git`);

    yield { phase: "git", repo: repo.name, step: "mirror" };
    await ensureMirrorRepo(repo, mirrorDir);

    yield { phase: "git", repo: repo.name, step: "cleanup" };
    const targetDir = path.join(workspaceDir, repo.name);
    await cleanupWorkspaceWorktrees(mirrorDir, workspaceDir);

    yield { phase: "git", repo: repo.name, step: "worktree" };
    await ensureWorkingCopy(repo, mirrorDir, targetDir, effectiveBranchName);

    yield { phase: "git-complete", repo: repo.name };

    // Check if repo has lockfile for install phase
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

  // Phase C: Finalize
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
        log.info(`${state.repo}: ${state.step}`);
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
  const cacheRoot = path.join(cacheHome, "vercel-workspace");
  await ensureDir(cacheRoot);
  return cacheRoot;
}

async function writeVSCodeWorkspaceFile(
  workspaceDir: string,
  repos: readonly RepoConfig[],
): Promise<void> {
  const workspaceName = path.basename(workspaceDir) || "vercel-workspace";
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

      const sizeBytes = await fetchRepoDiskUsage(slug);
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
