import { promises as fs } from "node:fs";
import path from "node:path";
import * as TOML from "smol-toml";
import type { WorkspaceMetadata } from "../types.ts";
import { pathExists } from "../utils/fs.ts";

const METADATA_FILENAME = ".workforest";
const SCHEMA_VERSION = "1";

export type WriteMetadataOptions = {
  featureName: string;
  description?: string;
  templateId?: string;
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
  const metadataPath = path.join(workspaceDir, METADATA_FILENAME);

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
    })),
  };

  const contents = TOML.stringify(metadata);
  await fs.writeFile(metadataPath, contents, "utf8");
}

/**
 * Read workspace metadata from the .workforest file.
 * Returns null if the file doesn't exist.
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
  const parsed = TOML.parse(contents);

  return parsed as WorkspaceMetadata;
}

/**
 * Get the path to the metadata file for a workspace.
 */
export function getMetadataPath(workspaceDir: string): string {
  return path.join(workspaceDir, METADATA_FILENAME);
}
