import { promises as fs } from "node:fs";
import path from "node:path";
import { log } from "../logger.ts";
import type { CleanupOptions } from "../types.ts";
import { pathExists } from "../utils/fs.ts";
import type { TaskState } from "../utils/task-generator.ts";
import { ensureCacheDir } from "./index.ts";
import { getMetadataPath, readWorkspaceMetadata } from "./metadata.ts";
import { cleanupWorkspaceWorktreesGenerator } from "./repository.ts";

/**
 * State emitted by the workspace cleanup generator.
 */
export type CleanupState =
  | { phase: "init"; message: string }
  | { phase: "worktree"; repo: string; state: TaskState }
  | { phase: "worktree-complete"; repo: string }
  | { phase: "remove-dir"; message: string }
  | { phase: "complete"; removedRepos: string[] };

/**
 * Result of a dry-run cleanup showing what would be deleted.
 */
export type CleanupPreview = {
  workspaceDir: string;
  repos: string[];
  workspaceFile: string;
  metadataFile?: string;
};

/**
 * Validates that a directory is a workforest workspace.
 * Returns the parsed workspace file contents if valid.
 * Prefers .workforest metadata file, falls back to .code-workspace for legacy support.
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

  // Try .workforest metadata file first (preferred)
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
    return parsed as { folders: Array<{ path: string }> };
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
 */
export async function previewCleanup(
  workspaceDir: string,
): Promise<CleanupPreview> {
  const resolvedDir = path.resolve(workspaceDir);
  const workspaceName = path.basename(resolvedDir);
  const workspace = await validateWorkspace(resolvedDir);

  const metadataExists = await pathExists(getMetadataPath(resolvedDir));

  return {
    workspaceDir: resolvedDir,
    repos: workspace.folders.map((f) => f.path),
    workspaceFile: `${workspaceName}.code-workspace`,
    ...(metadataExists ? { metadataFile: ".workforest" } : {}),
  };
}

/**
 * Generator-based workspace cleanup that yields state updates.
 */
export async function* cleanupWorkspaceGenerator(
  workspaceDir: string,
  options: CleanupOptions = {},
): AsyncGenerator<CleanupState> {
  const { dryRun = false, keepMirrors = true } = options;
  const resolvedDir = path.resolve(workspaceDir);

  yield { phase: "init", message: "Validating workspace" };

  const workspace = await validateWorkspace(resolvedDir);
  const repos = workspace.folders.map((f) => f.path);

  yield {
    phase: "init",
    message: `Found ${repos.length} repository/ies to clean`,
  };

  const cacheDir = await ensureCacheDir();
  const removedRepos: string[] = [];

  // Remove worktrees from mirrors
  for (const repoName of repos) {
    const mirrorDir = path.join(cacheDir, `${repoName}.git`);

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
    } else {
      for await (const state of cleanupWorkspaceWorktreesGenerator(
        mirrorDir,
        resolvedDir,
      )) {
        yield { phase: "worktree", repo: repoName, state };
      }
    }

    yield { phase: "worktree-complete", repo: repoName };
    removedRepos.push(repoName);
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
      const mirrorDir = path.join(cacheDir, `${repoName}.git`);

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

  yield { phase: "complete", removedRepos };
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
      case "remove-dir":
        log.info(state.message);
        break;
      case "complete":
        if (options.dryRun) {
          log.info("Dry-run complete. No changes made.");
        } else {
          log.success(
            `Cleanup complete. Removed ${state.removedRepos.length} worktree(s).`,
          );
        }
        break;
    }
  }
}
