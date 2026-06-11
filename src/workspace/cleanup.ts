import { promises as fs } from "node:fs";
import path from "node:path";
import { log } from "../logger.ts";
import { resolveMirrorDir } from "../repositories.ts";
import { validateRepositoryComponent } from "../repository-components.ts";
import { runGit } from "../services/git.ts";
import type { CleanupOptions, RepoConfig } from "../types.ts";
import { pathExists } from "../utils/fs.ts";
import { resolveContainedPath } from "../utils/path-safety.ts";
import type { TaskState } from "../utils/task-generator.ts";
import { ensureCacheDir } from "./index.ts";
import { hasWorkspaceMetadata, readWorkspaceMetadata } from "./metadata.ts";
import { cleanupWorkspaceWorktreesGenerator } from "./repository.ts";

/**
 * State emitted by the workspace cleanup generator.
 */
export type CleanupState =
  | { phase: "init"; message: string }
  | { phase: "worktree"; repo: string; state: TaskState }
  | { phase: "worktree-complete"; repo: string }
  | {
      phase: "remote-branch";
      repo: string;
      branch: string;
      status: "checking" | "deleting" | "deleted" | "skipped" | "failed";
      reason?: string;
    }
  | { phase: "remove-dir"; message: string }
  | { phase: "complete"; removedRepos: string[]; deletedBranches?: string[] };

/**
 * Information about a remote branch that can be deleted.
 */
export type RemoteBranchInfo = {
  repo: string;
  branch: string;
  merged: boolean;
};

/**
 * Result of a dry-run cleanup showing what would be deleted.
 */
export type CleanupPreview = {
  workspaceDir: string;
  repos: string[];
  temporaryWorktrees?: string[];
  workspaceFile: string;
  metadataFile?: string;
  remoteBranches?: RemoteBranchInfo[];
};

/**
 * Check if a remote branch exists on origin.
 */
async function remoteBranchExists(
  repoDir: string,
  branch: string,
): Promise<boolean> {
  try {
    await runGit(["ls-remote", "--exit-code", "--heads", "origin", branch], {
      cwd: repoDir,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a branch has been merged into the default branch.
 * Returns true if the branch is fully merged (no commits beyond default branch).
 */
async function isBranchMerged(
  repoDir: string,
  branch: string,
  defaultBranch: string,
): Promise<boolean> {
  try {
    // Fetch latest to ensure we have up-to-date refs
    await runGit(["fetch", "origin", defaultBranch], { cwd: repoDir });

    // Check if the branch commit is reachable from default branch
    // If `git log origin/main..origin/branch` returns nothing, branch is merged
    const { stdout } = await runGit(
      ["log", "--oneline", `origin/${defaultBranch}..origin/${branch}`],
      { cwd: repoDir },
    );
    return stdout.trim() === "";
  } catch {
    // If check fails, assume not merged (safer default)
    return false;
  }
}

/**
 * Validates that a directory is a workforest workspace.
 * Returns the parsed workspace file contents if valid.
 * Prefers .workforest metadata, falls back to .code-workspace for legacy support.
 */
export async function validateWorkspace(
  workspaceDir: string,
): Promise<{ folders: Array<{ path: string }> }> {
  const resolvedDir = path.resolve(workspaceDir);

  // Check directory exists
  try {
    const stat = await fs.stat(resolvedDir);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${resolvedDir}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Directory does not exist: ${resolvedDir}`);
    }
    throw error;
  }

  // Try .workforest metadata first (preferred)
  const metadata = await readWorkspaceMetadata(resolvedDir);
  if (metadata) {
    return {
      folders: metadata.repos.map((repo) => ({ path: repo.name })),
    };
  }

  // Fall back to .code-workspace file (legacy)
  const workspaceName = path.basename(resolvedDir);
  const workspaceFile = path.join(
    resolvedDir,
    `${workspaceName}.code-workspace`,
  );

  try {
    const contents = await fs.readFile(workspaceFile, "utf8");
    const parsed = JSON.parse(contents) as {
      folders?: Array<{ path: string }>;
    };
    if (!parsed.folders || !Array.isArray(parsed.folders)) {
      throw new Error(`Invalid workspace file: missing folders array`);
    }
    return {
      folders: parsed.folders.map((folder, index) => ({
        path: validateRepositoryComponent(
          folder.path,
          `Workspace repository at folders[${index}]`,
        ),
      })),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Not a workforest workspace: missing .workforest or ${workspaceName}.code-workspace file`,
      );
    }
    throw error;
  }
}

/**
 * Preview what would be cleaned up without actually deleting anything.
 * Optionally checks for merged remote branches that can be deleted.
 */
export async function previewCleanup(
  workspaceDir: string,
  options: { checkRemoteBranches?: boolean } = {},
): Promise<CleanupPreview> {
  const resolvedDir = path.resolve(workspaceDir);
  const workspaceName = path.basename(resolvedDir);
  const workspace = await validateWorkspace(resolvedDir);

  const metadataExists = await hasWorkspaceMetadata(resolvedDir);
  const metadata = await readWorkspaceMetadata(resolvedDir);

  // Check for merged remote branches if requested
  const remoteBranches: RemoteBranchInfo[] = [];
  if (options.checkRemoteBranches && metadata) {
    for (const repo of metadata.repos) {
      // Skip if no feature branch recorded or if it's the same as default
      if (!repo.feature_branch || repo.feature_branch === repo.default_branch) {
        continue;
      }

      const repoDir = resolveContainedPath(resolvedDir, repo.name);
      if (!(await pathExists(repoDir))) {
        continue;
      }

      // Check if branch exists on remote
      const exists = await remoteBranchExists(repoDir, repo.feature_branch);
      if (!exists) {
        continue;
      }

      // Check if branch is merged
      const merged = await isBranchMerged(
        repoDir,
        repo.feature_branch,
        repo.default_branch,
      );

      // Only include merged branches (safe to delete)
      if (merged) {
        remoteBranches.push({
          repo: repo.name,
          branch: repo.feature_branch,
          merged: true,
        });
      }
    }
  }

  return {
    workspaceDir: resolvedDir,
    repos: workspace.folders.map((f) => f.path),
    ...(metadata?.temporary_worktrees?.length
      ? {
          temporaryWorktrees: metadata.temporary_worktrees.map(
            (entry) => `${entry.parent_repo}-${entry.slug}`,
          ),
        }
      : {}),
    workspaceFile: `${workspaceName}.code-workspace`,
    ...(metadataExists ? { metadataFile: ".workforest/workspace.json" } : {}),
    ...(remoteBranches.length > 0 ? { remoteBranches } : {}),
  };
}

/**
 * Generator-based workspace cleanup that yields state updates.
 */
export async function* cleanupWorkspaceGenerator(
  workspaceDir: string,
  options: CleanupOptions = {},
): AsyncGenerator<CleanupState> {
  const {
    dryRun = false,
    keepMirrors = true,
    deleteRemoteBranches = false,
  } = options;
  const resolvedDir = path.resolve(workspaceDir);

  yield { phase: "init", message: "Validating workspace" };

  const workspace = await validateWorkspace(resolvedDir);
  const repos = workspace.folders.map((f) => f.path);
  const metadata = await readWorkspaceMetadata(resolvedDir);

  yield {
    phase: "init",
    message: `Found ${repos.length} repository/ies to clean`,
  };

  const cacheDir = await ensureCacheDir();
  const removedRepos: string[] = [];
  const deletedBranches: string[] = [];
  const repoConfigs = new Map(
    metadata?.repos.map((repo) => [
      repo.name,
      {
        name: repo.name,
        remote: repo.remote,
        defaultBranch: repo.default_branch,
      } satisfies RepoConfig,
    ]) ?? [],
  );

  // Delete remote branches first (before removing worktrees)
  if (deleteRemoteBranches && metadata) {
    for (const repo of metadata.repos) {
      // Skip if no feature branch recorded or if it's the same as default
      if (!repo.feature_branch || repo.feature_branch === repo.default_branch) {
        continue;
      }

      const repoDir = resolveContainedPath(resolvedDir, repo.name);
      if (!(await pathExists(repoDir))) {
        continue;
      }

      yield {
        phase: "remote-branch",
        repo: repo.name,
        branch: repo.feature_branch,
        status: "checking",
      };

      // Check if branch exists on remote
      const exists = await remoteBranchExists(repoDir, repo.feature_branch);
      if (!exists) {
        yield {
          phase: "remote-branch",
          repo: repo.name,
          branch: repo.feature_branch,
          status: "skipped",
          reason: "Branch does not exist on remote",
        };
        continue;
      }

      // Check if branch is merged (safety check)
      const merged = await isBranchMerged(
        repoDir,
        repo.feature_branch,
        repo.default_branch,
      );

      if (!merged) {
        yield {
          phase: "remote-branch",
          repo: repo.name,
          branch: repo.feature_branch,
          status: "skipped",
          reason: "Branch has unmerged changes",
        };
        continue;
      }

      if (dryRun) {
        yield {
          phase: "remote-branch",
          repo: repo.name,
          branch: repo.feature_branch,
          status: "skipped",
          reason: "Would delete (dry-run)",
        };
      } else {
        yield {
          phase: "remote-branch",
          repo: repo.name,
          branch: repo.feature_branch,
          status: "deleting",
        };

        try {
          await runGit(["push", "origin", "--delete", repo.feature_branch], {
            cwd: repoDir,
          });
          yield {
            phase: "remote-branch",
            repo: repo.name,
            branch: repo.feature_branch,
            status: "deleted",
          };
          deletedBranches.push(`${repo.name}:${repo.feature_branch}`);
        } catch (error) {
          yield {
            phase: "remote-branch",
            repo: repo.name,
            branch: repo.feature_branch,
            status: "failed",
            reason:
              error instanceof Error ? error.message : "Unknown error occurred",
          };
        }
      }
    }
  }

  // Remove worktrees from mirrors
  for (const repoName of repos) {
    validateRepositoryComponent(repoName, "Repository name");
    const repo = repoConfigs.get(repoName);
    const mirrorDir = repo
      ? await resolveMirrorDir(repo, cacheDir)
      : resolveContainedPath(cacheDir, `${repoName}.git`);

    // Check if mirror exists
    try {
      await fs.access(mirrorDir);
    } catch {
      yield {
        phase: "worktree",
        repo: repoName,
        state: {
          status: "skipped",
          reason: "Mirror not found in cache",
        },
      };
      continue;
    }

    if (dryRun) {
      yield {
        phase: "worktree",
        repo: repoName,
        state: {
          status: "log",
          level: "info",
          message: "Would remove worktree from mirror (dry-run)",
        },
      };
      yield { phase: "worktree-complete", repo: repoName };
      removedRepos.push(repoName);
    } else {
      let cleaned = false;

      try {
        for await (const state of cleanupWorkspaceWorktreesGenerator(
          mirrorDir,
          resolvedDir,
        )) {
          yield { phase: "worktree", repo: repoName, state };
        }
        cleaned = true;
      } catch (error) {
        yield {
          phase: "worktree",
          repo: repoName,
          state: {
            status: "failed",
            error: error instanceof Error ? error : new Error(String(error)),
          },
        };
      }

      if (cleaned) {
        yield { phase: "worktree-complete", repo: repoName };
        removedRepos.push(repoName);
      }
    }
  }

  // Remove workspace directory
  if (dryRun) {
    yield {
      phase: "remove-dir",
      message: `Would remove directory: ${resolvedDir} (dry-run)`,
    };
  } else {
    yield {
      phase: "remove-dir",
      message: `Removing directory: ${resolvedDir}`,
    };
    await fs.rm(resolvedDir, { recursive: true, force: true });
  }

  // Optionally prune orphaned mirrors
  if (!keepMirrors) {
    yield {
      phase: "init",
      message: "Pruning orphaned mirrors",
    };

    for (const repoName of repos) {
      validateRepositoryComponent(repoName, "Repository name");
      const repo = repoConfigs.get(repoName);
      const mirrorDir = repo
        ? await resolveMirrorDir(repo, cacheDir)
        : resolveContainedPath(cacheDir, `${repoName}.git`);

      // Check if mirror exists
      try {
        await fs.access(mirrorDir);
      } catch {
        continue;
      }

      if (dryRun) {
        yield {
          phase: "worktree",
          repo: repoName,
          state: {
            status: "log",
            level: "info",
            message: "Would remove orphaned mirror (dry-run)",
          },
        };
      } else {
        yield {
          phase: "worktree",
          repo: repoName,
          state: {
            status: "log",
            level: "info",
            message: "Removing orphaned mirror",
          },
        };
        await fs.rm(mirrorDir, { recursive: true, force: true });
      }
    }
  }

  yield {
    phase: "complete",
    removedRepos,
    ...(deletedBranches.length > 0 ? { deletedBranches } : {}),
  };
}

/**
 * Run the workspace cleanup with simple console logging.
 * This is for non-TUI usage.
 */
export async function cleanupWorkspace(
  workspaceDir: string,
  options: CleanupOptions = {},
): Promise<void> {
  for await (const state of cleanupWorkspaceGenerator(workspaceDir, options)) {
    switch (state.phase) {
      case "init":
        log.info(state.message);
        break;
      case "worktree":
        if (state.state.status === "log") {
          log[state.state.level](`${state.repo}: ${state.state.message}`);
        } else if (state.state.status === "skipped") {
          log.info(`${state.repo}: ${state.state.reason}`);
        } else if (state.state.status === "failed") {
          log.error(`${state.repo}: ${state.state.error.message}`);
        }
        break;
      case "worktree-complete":
        log.success(`${state.repo}: worktree removed from mirror`);
        break;
      case "remote-branch":
        switch (state.status) {
          case "checking":
            log.info(`${state.repo}: checking remote branch ${state.branch}`);
            break;
          case "deleting":
            log.info(`${state.repo}: deleting remote branch ${state.branch}`);
            break;
          case "deleted":
            log.success(`${state.repo}: deleted remote branch ${state.branch}`);
            break;
          case "skipped":
            log.info(
              `${state.repo}: skipped ${state.branch} - ${state.reason}`,
            );
            break;
          case "failed":
            log.error(
              `${state.repo}: failed to delete ${state.branch} - ${state.reason}`,
            );
            break;
        }
        break;
      case "remove-dir":
        log.info(state.message);
        break;
      case "complete":
        if (options.dryRun) {
          log.info("Dry-run complete. No changes made.");
        } else {
          const branchMsg = state.deletedBranches?.length
            ? `, deleted ${state.deletedBranches.length} remote branch(es)`
            : "";
          log.success(
            `Cleanup complete. Removed ${state.removedRepos.length} worktree(s)${branchMsg}.`,
          );
        }
        break;
    }
  }
}
