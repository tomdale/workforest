import { promises as fs } from "node:fs";
import path from "node:path";
import type { WorkspaceMetadata, WorkspaceRepoMetadata } from "../types.ts";
import { pathExists } from "../utils/fs.ts";

const METADATA_FILENAME = ".workforest";
const SCHEMA_VERSION = "1";

export type WriteMetadataOptions = {
  featureName: string;
  description?: string;
  templateId?: string;
  branchName?: string;
  repos: readonly {
    name: string;
    remote: string;
    defaultBranch: string;
    hasLockfile: boolean;
  }[];
};

/**
 * Write workspace metadata to the .workforest file.
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

/**
 * Persist workspace metadata without modifying workspace-level fields.
 */
export async function saveWorkspaceMetadata(
  workspaceDir: string,
  metadata: WorkspaceMetadata,
): Promise<void> {
  const metadataPath = path.join(workspaceDir, METADATA_FILENAME);
  const contents = JSON.stringify(metadata, null, 2);
  await fs.writeFile(metadataPath, `${contents}\n`, "utf8");
}

/**
 * Append repository entries to an existing workspace metadata file.
 */
export async function appendWorkspaceRepos(
  workspaceDir: string,
  repos: readonly WorkspaceRepoMetadata[],
): Promise<WorkspaceMetadata> {
  const metadata = await readWorkspaceMetadata(workspaceDir);

  if (!metadata) {
    throw new Error(
      `Workspace metadata not found at ${path.join(workspaceDir, METADATA_FILENAME)}`,
    );
  }

  const nextMetadata: WorkspaceMetadata = {
    ...metadata,
    repos: [...metadata.repos, ...repos],
  };

  await saveWorkspaceMetadata(workspaceDir, nextMetadata);
  return nextMetadata;
}

/**
 * Read workspace metadata from the .workforest file.
 * Returns null if the file doesn't exist.
 *
 * Supports both JSON (current) and TOML (legacy) formats.
 * Legacy TOML files are automatically migrated to JSON on read.
 */
export async function readWorkspaceMetadata(
  workspaceDir: string,
): Promise<WorkspaceMetadata | null> {
  const metadataPath = path.join(workspaceDir, METADATA_FILENAME);

  const exists = await pathExists(metadataPath);
  if (!exists) {
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
  return path.join(workspaceDir, METADATA_FILENAME);
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
