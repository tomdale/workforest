import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ReviewWorktreeMetadata,
  TemporaryWorktreeMetadata,
  WorkspaceMetadata,
  WorkspaceRepoMetadata,
} from "../types.ts";
import { pathExists } from "../utils/fs.ts";

const METADATA_FILENAME = ".workforest";
const WORKSPACE_METADATA_FILENAME = "workspace.json";
const WORKSPACE_METADATA_LOCK_FILENAME = ".workforest.lock";
const SCHEMA_VERSION = "1";
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

export type WriteMetadataOptions = {
  featureName: string;
  description?: string;
  templateId?: string;
  type?: "review";
  review?: {
    owner: string;
    repo: string;
  };
  branchName?: string;
  repos: readonly {
    name: string;
    remote: string;
    defaultBranch: string;
    hasLockfile: boolean;
  }[];
};

/**
 * Write workspace metadata to .workforest/workspace.json.
 */
export async function writeWorkspaceMetadata(
  workspaceDir: string,
  options: WriteMetadataOptions,
): Promise<void> {
  const metadata: WorkspaceMetadata = {
    workspace: {
      version: SCHEMA_VERSION,
      created_at: new Date().toISOString(),
      feature_name: options.featureName,
      ...(options.description ? { description: options.description } : {}),
      ...(options.templateId ? { template_id: options.templateId } : {}),
      ...(options.type ? { type: options.type } : {}),
      ...(options.review ? { review: options.review } : {}),
    },
    repos: options.repos.map((repo) => ({
      name: repo.name,
      remote: repo.remote,
      default_branch: repo.defaultBranch,
      has_lockfile: repo.hasLockfile,
      ...(options.branchName ? { feature_branch: options.branchName } : {}),
    })),
  };

  await saveWorkspaceMetadata(workspaceDir, metadata);
}

export async function upsertReviewWorktree(
  workspaceDir: string,
  worktree: ReviewWorktreeMetadata,
): Promise<WorkspaceMetadata> {
  return mutateWorkspaceMetadata(workspaceDir, (metadata) => {
    const existing = metadata.review_worktrees ?? [];
    const nextReviewWorktrees = existing.some(
      (entry) => entry.pr_number === worktree.pr_number,
    )
      ? existing.map((entry) =>
          entry.pr_number === worktree.pr_number ? worktree : entry,
        )
      : [...existing, worktree];

    return {
      ...metadata,
      review_worktrees: nextReviewWorktrees,
    };
  });
}

export async function removeReviewWorktreeMetadata(
  workspaceDir: string,
  prNumber: number,
): Promise<WorkspaceMetadata> {
  return mutateWorkspaceMetadata(workspaceDir, (metadata) => {
    const reviewWorktrees = (metadata.review_worktrees ?? []).filter(
      (entry) => entry.pr_number !== prNumber,
    );

    const nextMetadata: WorkspaceMetadata = {
      ...metadata,
      ...(reviewWorktrees.length > 0
        ? { review_worktrees: reviewWorktrees }
        : {}),
    };

    if (reviewWorktrees.length === 0) {
      delete nextMetadata.review_worktrees;
    }

    return nextMetadata;
  });
}

/**
 * Persist workspace metadata without modifying workspace-level fields.
 */
export async function saveWorkspaceMetadata(
  workspaceDir: string,
  metadata: WorkspaceMetadata,
): Promise<void> {
  await withWorkspaceMetadataLock(workspaceDir, () =>
    writeWorkspaceMetadataFile(workspaceDir, metadata),
  );
}

/**
 * Append repository entries to an existing workspace metadata file.
 */
export async function appendWorkspaceRepos(
  workspaceDir: string,
  repos: readonly WorkspaceRepoMetadata[],
): Promise<WorkspaceMetadata> {
  return mutateWorkspaceMetadata(workspaceDir, (metadata) => ({
    ...metadata,
    repos: [...metadata.repos, ...repos],
  }));
}

export async function updateWorkspaceRepo(
  workspaceDir: string,
  repo: WorkspaceRepoMetadata,
): Promise<WorkspaceMetadata> {
  return mutateWorkspaceMetadata(workspaceDir, (metadata) => {
    const existingIndex = metadata.repos.findIndex(
      (entry) => entry.name === repo.name,
    );
    const repos =
      existingIndex === -1
        ? [...metadata.repos, repo]
        : metadata.repos.map((entry, index) =>
            index === existingIndex ? repo : entry,
          );

    return {
      ...metadata,
      repos,
    };
  });
}

export async function appendTemporaryWorktrees(
  workspaceDir: string,
  worktrees: readonly TemporaryWorktreeMetadata[],
): Promise<WorkspaceMetadata> {
  return mutateWorkspaceMetadata(workspaceDir, (metadata) => ({
    ...metadata,
    temporary_worktrees: [
      ...(metadata.temporary_worktrees ?? []),
      ...worktrees,
    ],
  }));
}

export async function removeTemporaryWorktrees(
  workspaceDir: string,
  entriesToRemove: readonly Pick<
    TemporaryWorktreeMetadata,
    "parent_repo" | "slug"
  >[],
): Promise<WorkspaceMetadata> {
  return mutateWorkspaceMetadata(workspaceDir, (metadata) => {
    const removeKeys = new Set(
      entriesToRemove.map((entry) => `${entry.parent_repo}\0${entry.slug}`),
    );
    const temporaryWorktrees = (metadata.temporary_worktrees ?? []).filter(
      (entry) => !removeKeys.has(`${entry.parent_repo}\0${entry.slug}`),
    );

    const nextMetadata: WorkspaceMetadata = {
      ...metadata,
      ...(temporaryWorktrees.length > 0
        ? { temporary_worktrees: temporaryWorktrees }
        : {}),
    };

    if (temporaryWorktrees.length === 0) {
      delete nextMetadata.temporary_worktrees;
    }

    return nextMetadata;
  });
}

/**
 * Read workspace metadata from .workforest/workspace.json or a legacy
 * .workforest file.
 * Returns null if the file doesn't exist.
 *
 * Supports both JSON (current) and TOML (legacy) formats.
 * Legacy TOML files are automatically migrated to JSON on read.
 */
export async function readWorkspaceMetadata(
  workspaceDir: string,
): Promise<WorkspaceMetadata | null> {
  const metadataPath = await resolveReadableMetadataPath(workspaceDir);

  if (!metadataPath) {
    return null;
  }

  const contents = await fs.readFile(metadataPath, "utf8");

  // Try JSON first (current format)
  try {
    const parsed = JSON.parse(contents);
    return parsed as WorkspaceMetadata;
  } catch {
    // Not valid JSON, try TOML (legacy format)
  }

  // Check if this looks like a TOML file (legacy format)
  if (looksLikeToml(contents)) {
    throw new Error(
      `Workspace metadata at ${metadataPath} appears to be in legacy TOML format. ` +
        `Please convert it to JSON manually or recreate the workspace.`,
    );
  }

  throw new Error(
    `Unable to parse workspace metadata at ${metadataPath}. Expected JSON format.`,
  );
}

/**
 * Get the path to the metadata file for a workspace.
 */
export function getMetadataPath(workspaceDir: string): string {
  return path.join(
    getWorkspaceMetadataDirPath(workspaceDir),
    WORKSPACE_METADATA_FILENAME,
  );
}

/**
 * Get the path to the workspace metadata directory.
 */
export function getWorkspaceMetadataDirPath(workspaceDir: string): string {
  return path.join(workspaceDir, METADATA_FILENAME);
}

/**
 * Check whether a workspace has either current or legacy metadata.
 */
export async function hasWorkspaceMetadata(
  workspaceDir: string,
): Promise<boolean> {
  return (await resolveReadableMetadataPath(workspaceDir)) !== null;
}

/**
 * Ensure the metadata directory exists and migrate a legacy .workforest file
 * into .workforest/workspace.json if needed.
 */
export async function ensureWorkspaceMetadataDir(
  workspaceDir: string,
): Promise<string> {
  const metadataDir = getWorkspaceMetadataDirPath(workspaceDir);

  try {
    const stat = await fs.stat(metadataDir);
    if (stat.isDirectory()) {
      return metadataDir;
    }

    if (!stat.isFile()) {
      throw new Error(
        `Workspace metadata path is not a file or directory: ${metadataDir}`,
      );
    }

    const contents = await fs.readFile(metadataDir, "utf8");
    await fs.rm(metadataDir);
    await fs.mkdir(metadataDir, { recursive: true });
    await fs.writeFile(
      path.join(metadataDir, WORKSPACE_METADATA_FILENAME),
      contents,
      "utf8",
    );
    return metadataDir;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await fs.mkdir(metadataDir, { recursive: true });
  return metadataDir;
}

async function ensureWorkspaceMetadataFilePath(
  workspaceDir: string,
): Promise<string> {
  const metadataDir = await ensureWorkspaceMetadataDir(workspaceDir);
  return path.join(metadataDir, WORKSPACE_METADATA_FILENAME);
}

async function mutateWorkspaceMetadata(
  workspaceDir: string,
  update: (metadata: WorkspaceMetadata) => WorkspaceMetadata,
): Promise<WorkspaceMetadata> {
  return withWorkspaceMetadataLock(workspaceDir, async () => {
    const metadata = await readWorkspaceMetadata(workspaceDir);

    if (!metadata) {
      throw new Error(
        `Workspace metadata not found at ${path.join(workspaceDir, METADATA_FILENAME)}`,
      );
    }

    const nextMetadata = update(metadata);
    await writeWorkspaceMetadataFile(workspaceDir, nextMetadata);
    return nextMetadata;
  });
}

async function writeWorkspaceMetadataFile(
  workspaceDir: string,
  metadata: WorkspaceMetadata,
): Promise<void> {
  const metadataPath = await ensureWorkspaceMetadataFilePath(workspaceDir);
  const temporaryPath = `${metadataPath}.${process.pid}.${randomUUID()}.tmp`;
  const contents = `${JSON.stringify(metadata, null, 2)}\n`;

  try {
    await fs.writeFile(temporaryPath, contents, "utf8");
    await fs.rename(temporaryPath, metadataPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function withWorkspaceMetadataLock<T>(
  workspaceDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  await fs.mkdir(workspaceDir, { recursive: true });
  const lockPath = path.join(
    path.resolve(workspaceDir),
    WORKSPACE_METADATA_LOCK_FILENAME,
  );
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let lockHandle: Awaited<ReturnType<typeof fs.open>> | undefined;

  while (!lockHandle) {
    let candidate: Awaited<ReturnType<typeof fs.open>> | undefined;

    try {
      candidate = await fs.open(lockPath, "wx");
      await candidate.writeFile(
        `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
        "utf8",
      );
      lockHandle = candidate;
    } catch (error) {
      if (candidate) {
        await candidate.close().catch(() => {});
        await fs.rm(lockPath, { force: true }).catch(() => {});
      }

      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      if (await removeStaleMetadataLock(lockPath)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for workspace metadata lock at ${lockPath}`,
        );
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

async function removeStaleMetadataLock(lockPath: string): Promise<boolean> {
  try {
    const lockStat = await fs.stat(lockPath);
    if (Date.now() - lockStat.mtimeMs <= STALE_LOCK_MS) {
      return false;
    }
    await fs.rm(lockPath, { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

async function resolveReadableMetadataPath(
  workspaceDir: string,
): Promise<string | null> {
  const metadataDir = getWorkspaceMetadataDirPath(workspaceDir);

  try {
    const stat = await fs.stat(metadataDir);
    if (stat.isFile()) {
      return metadataDir;
    }

    if (stat.isDirectory()) {
      const metadataPath = path.join(metadataDir, WORKSPACE_METADATA_FILENAME);
      return (await pathExists(metadataPath)) ? metadataPath : null;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return null;
}

/**
 * Check if content looks like TOML format (legacy).
 * TOML files typically have [section] headers and key = value pairs.
 */
function looksLikeToml(content: string): boolean {
  // Check for TOML section headers like [workspace]
  if (/^\s*\[\w+\]\s*$/m.test(content)) {
    return true;
  }
  // Check for TOML array of tables like [[repos]]
  if (/^\s*\[\[\w+\]\]\s*$/m.test(content)) {
    return true;
  }
  return false;
}
