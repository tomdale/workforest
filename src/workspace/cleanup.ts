import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "@wf-plugin/core";
import { loadWorkspaceConfig } from "../config.ts";
import { preserveNodeModules } from "../node-modules-cache.ts";
import { resolveMirrorDir } from "../repositories.ts";
import { validateRepositoryComponent } from "../repository-components.ts";
import { createDefaultBranchResolver, runGit } from "../services/git.ts";
import type {
  CleanupOptions,
  NodeModulesCacheConfig,
  RepositorySource,
  WorkspaceMetadata,
} from "../types.ts";
import { resolveContainedPath } from "../utils/path-safety.ts";
import { runParallel, type TaskState } from "../utils/task-generator.ts";
import { ensureCacheDir } from "./index.ts";
import {
  hasWorkspaceMetadata,
  readWorkspaceMetadata,
  removeWorktreeMetadata,
} from "./metadata.ts";
import { cleanupWorkspaceWorktrees } from "./repository.ts";

/**
 * State emitted by the workspace cleanup generator.
 */
export type CleanupState =
  | { phase: "init"; message: string }
  | {
      phase: "node-modules";
      repo: string;
      path: string;
      status: "preserving" | "preserved" | "skipped" | "warning";
      reason?: "disabled" | "missing" | "ineligible";
      message?: string;
    }
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
  tasks?: string[];
  workspaceFile: string;
  metadataFile?: string;
  remoteBranches?: RemoteBranchInfo[];
};

export type CleanupResult = {
  dryRun: boolean;
  removedRepos: string[];
  deletedBranches: string[];
};

export type CleanupStateSink = (state: CleanupState) => void | Promise<void>;

export type CleanupExecutionOptions = CleanupOptions & {
  onState?: CleanupStateSink;
};

export type WorktreeCleanupOptions = Readonly<{
  repoName: string;
  targetPath: string;
  repo?: RepositorySource;
  dryRun?: boolean;
  onState?: CleanupStateSink;
}>;

const CLEANUP_MAX_CONCURRENT = 4;

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
    const defaultBranchResolver = createDefaultBranchResolver();
    for (const repo of metadata.repos) {
      if (!repo.feature_branch) {
        continue;
      }

      const repoDir = resolveContainedPath(resolvedDir, repo.name);
      if (!(await pathExists(repoDir))) {
        continue;
      }
      const defaultBranch =
        await defaultBranchResolver.resolveWorktreeDefaultBranch(repoDir);
      if (repo.feature_branch === defaultBranch) {
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
        defaultBranch,
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
    ...(metadata?.tasks?.length
      ? {
          tasks: metadata.tasks.map(
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
export async function* streamWorkspaceCleanup(
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
  const repoCount = `${repos.length} ${
    repos.length === 1 ? "repository" : "repositories"
  }`;

  yield {
    phase: "init",
    message: `Found ${repoCount} to clean`,
  };

  const cacheDir = await ensureCacheDir();
  const { config } = await loadWorkspaceConfig();
  const cleanedRepos = new Set<string>();
  const deletedBranches: string[] = [];
  const repoConfigs = new Map(
    metadata?.repos.map((repo) => [
      repo.name,
      {
        name: repo.name,
        remote: repo.remote,
      } satisfies RepositorySource,
    ]) ?? [],
  );

  // Delete remote branches first (before removing worktrees)
  if (deleteRemoteBranches && metadata) {
    const defaultBranchResolver = createDefaultBranchResolver();
    for (const repo of metadata.repos) {
      if (!repo.feature_branch) {
        continue;
      }

      const repoDir = resolveContainedPath(resolvedDir, repo.name);
      if (!(await pathExists(repoDir))) {
        continue;
      }
      const defaultBranch =
        await defaultBranchResolver.resolveWorktreeDefaultBranch(repoDir);
      if (repo.feature_branch === defaultBranch) {
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
        defaultBranch,
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

  const cleanupTasks = new Map<string, AsyncGenerator<CleanupState>>();
  for (const repoName of repos) {
    cleanupTasks.set(
      repoName,
      cleanupRepositoryWorktrees({
        repoName,
        repo: repoConfigs.get(repoName),
        workspaceDir: resolvedDir,
        cacheDir,
        metadata,
        dryRun,
        nodeModulesConfig: config.cache?.nodeModules,
      }),
    );
  }

  for await (const { state } of runParallel(cleanupTasks, {
    maxConcurrent: CLEANUP_MAX_CONCURRENT,
  })) {
    if (state.phase === "worktree-complete") {
      cleanedRepos.add(state.repo);
    }
    yield state;
  }

  const removedRepos = repos.filter((repoName) => cleanedRepos.has(repoName));

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

type RepositoryCleanupOptions = {
  repoName: string;
  repo: RepositorySource | undefined;
  workspaceDir: string;
  cacheDir: string;
  metadata: WorkspaceMetadata | null;
  dryRun: boolean;
  nodeModulesConfig: NodeModulesCacheConfig | undefined;
};

async function* cleanupRepositoryWorktrees({
  repoName,
  repo,
  workspaceDir,
  cacheDir,
  metadata,
  dryRun,
  nodeModulesConfig,
}: RepositoryCleanupOptions): AsyncGenerator<CleanupState> {
  const safeRepoName = validateRepositoryComponent(repoName, "Repository name");
  const mirrorDir = repo
    ? await resolveMirrorDir(repo, cacheDir)
    : resolveContainedPath(cacheDir, `${safeRepoName}.git`);

  try {
    await fs.access(mirrorDir);
  } catch {
    yield {
      phase: "worktree",
      repo: safeRepoName,
      state: {
        status: "skipped",
        reason: "Mirror not found in cache",
      },
    };
    return;
  }

  if (dryRun) {
    yield {
      phase: "worktree",
      repo: safeRepoName,
      state: {
        status: "log",
        level: "info",
        message: "Would remove worktree from mirror (dry-run)",
      },
    };
    yield { phase: "worktree-complete", repo: safeRepoName };
    return;
  }

  if (repo) {
    yield* preserveRepositoryNodeModules({
      repo,
      repoName: safeRepoName,
      workspaceDir,
      metadata,
      config: nodeModulesConfig,
    });
  }

  let cleaned = false;
  try {
    const targetPaths = directCleanupTargetsForRepo(
      workspaceDir,
      safeRepoName,
      metadata,
    );
    const cleanupOptions = targetPaths ? { targetPaths } : {};
    for await (const state of cleanupWorkspaceWorktrees(
      mirrorDir,
      workspaceDir,
      cleanupOptions,
    )) {
      yield { phase: "worktree", repo: safeRepoName, state };
    }
    cleaned = true;
  } catch (error) {
    yield {
      phase: "worktree",
      repo: safeRepoName,
      state: {
        status: "failed",
        error: error instanceof Error ? error : new Error(String(error)),
      },
    };
  }

  if (cleaned) {
    yield { phase: "worktree-complete", repo: safeRepoName };
  }
}

function directCleanupTargetsForRepo(
  workspaceDir: string,
  repoName: string,
  metadata: WorkspaceMetadata | null,
): string[] | undefined {
  if (!metadata) {
    return undefined;
  }

  const targets = [resolveContainedPath(workspaceDir, repoName)];
  for (const task of metadata.tasks ?? []) {
    if (task.parent_repo === repoName) {
      targets.push(resolveContainedPath(workspaceDir, task.path));
    }
  }
  return targets;
}

async function* preserveRepositoryNodeModules({
  repo,
  repoName,
  workspaceDir,
  metadata,
  config,
}: {
  repo: RepositorySource;
  repoName: string;
  workspaceDir: string;
  metadata: WorkspaceMetadata | null;
  config: NodeModulesCacheConfig | undefined;
}): AsyncGenerator<CleanupState> {
  yield* preserveNodeModulesForPath({
    repo,
    repoName,
    repoDir: resolveContainedPath(workspaceDir, repoName),
    config,
  });

  for (const task of metadata?.tasks ?? []) {
    if (task.parent_repo !== repoName) {
      continue;
    }
    yield* preserveNodeModulesForPath({
      repo,
      repoDir: resolveContainedPath(workspaceDir, task.path),
      repoName,
      config,
    });
  }
}

async function* preserveNodeModulesForPath({
  repo,
  repoName,
  repoDir,
  config,
}: {
  repo: RepositorySource;
  repoName: string;
  repoDir: string;
  config: NodeModulesCacheConfig | undefined;
}): AsyncGenerator<CleanupState> {
  yield {
    phase: "node-modules",
    repo: repoName,
    path: repoDir,
    status: "preserving",
  };

  const result = await preserveNodeModules({ repo, repoDir, config });
  if (result.status === "preserved") {
    yield {
      phase: "node-modules",
      repo: repoName,
      path: repoDir,
      status: "preserved",
    };
  } else if (result.status === "warning") {
    yield {
      phase: "node-modules",
      repo: repoName,
      path: repoDir,
      status: "warning",
      message: result.warning,
    };
  } else {
    yield {
      phase: "node-modules",
      repo: repoName,
      path: repoDir,
      status: "skipped",
      reason: result.status,
    };
  }
}

export async function cleanupWorkspace(
  workspaceDir: string,
  { onState, ...options }: CleanupExecutionOptions = {},
): Promise<CleanupResult> {
  let result: CleanupResult | undefined;

  for await (const state of streamWorkspaceCleanup(workspaceDir, options)) {
    await onState?.(state);
    if (state.phase === "complete") {
      result = {
        dryRun: options.dryRun ?? false,
        removedRepos: state.removedRepos,
        deletedBranches: state.deletedBranches ?? [],
      };
    }
  }

  if (!result) {
    throw new Error("Workspace cleanup did not produce a result.");
  }

  return result;
}

export async function cleanupWorktree({
  repoName,
  targetPath,
  repo,
  dryRun = false,
  onState,
}: WorktreeCleanupOptions): Promise<CleanupResult> {
  const safeRepoName = validateRepositoryComponent(repoName, "Repository name");
  const resolvedChangePath = path.resolve(targetPath);
  const cacheDir = await ensureCacheDir();
  const { config } = await loadWorkspaceConfig();
  const mirrorDir = repo
    ? await resolveMirrorDir(repo, cacheDir)
    : resolveContainedPath(cacheDir, `${safeRepoName}.git`);
  const removedRepos: string[] = [];

  await onState?.({
    phase: "init",
    message: `Cleaning worktree ${safeRepoName}`,
  });

  if (await pathExists(mirrorDir)) {
    if (dryRun) {
      await onState?.({
        phase: "worktree",
        repo: safeRepoName,
        state: {
          status: "log",
          level: "info",
          message: "Would remove worktree from mirror (dry-run)",
        },
      });
      await onState?.({ phase: "worktree-complete", repo: safeRepoName });
      removedRepos.push(safeRepoName);
    } else {
      if (repo) {
        for await (const state of preserveNodeModulesForPath({
          repo,
          repoName: safeRepoName,
          repoDir: resolvedChangePath,
          config: config.cache?.nodeModules,
        })) {
          await onState?.(state);
        }
      }
      let cleaned = false;
      try {
        for await (const state of cleanupWorkspaceWorktrees(
          mirrorDir,
          resolvedChangePath,
          { targetPaths: [resolvedChangePath] },
        )) {
          await onState?.({ phase: "worktree", repo: safeRepoName, state });
        }
        cleaned = true;
      } catch (error) {
        await onState?.({
          phase: "worktree",
          repo: safeRepoName,
          state: {
            status: "failed",
            error: error instanceof Error ? error : new Error(String(error)),
          },
        });
      }

      if (cleaned) {
        await onState?.({ phase: "worktree-complete", repo: safeRepoName });
        removedRepos.push(safeRepoName);
      }
    }
  } else {
    await onState?.({
      phase: "worktree",
      repo: safeRepoName,
      state: {
        status: "skipped",
        reason: "Mirror not found in cache",
      },
    });
  }

  if (dryRun) {
    await onState?.({
      phase: "remove-dir",
      message: `Would remove directory: ${resolvedChangePath} (dry-run)`,
    });
  } else {
    await onState?.({
      phase: "remove-dir",
      message: `Removing directory: ${resolvedChangePath}`,
    });
    await fs.rm(resolvedChangePath, { recursive: true, force: true });
    await removeWorktreeMetadata(
      path.dirname(resolvedChangePath),
      path.basename(resolvedChangePath),
    );
  }

  await onState?.({ phase: "complete", removedRepos });

  return {
    dryRun,
    removedRepos,
    deletedBranches: [],
  };
}
