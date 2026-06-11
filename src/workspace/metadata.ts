import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { validateRepositoryComponent } from "../repository-components.ts";
import type {
  ReviewWorktreeMetadata,
  TemporaryWorktreeMetadata,
  WorkspaceMetadata,
  WorkspaceRepoMetadata,
} from "../types.ts";
import { pathExists } from "../utils/fs.ts";
import {
  assertContainedPathWithoutSymlinks,
  resolveContainedPath,
  validateResourceName,
} from "../utils/path-safety.ts";

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

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    // Not valid JSON, try TOML (legacy format)
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

  const metadata = validateWorkspaceMetadata(
    parsed,
    workspaceDir,
    metadataPath,
  );
  await validateWorkspaceMetadataFilesystemPaths(metadata, workspaceDir);
  return metadata;
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
  const validated = validateWorkspaceMetadata(
    metadata,
    workspaceDir,
    "workspace metadata",
  );
  await validateWorkspaceMetadataFilesystemPaths(validated, workspaceDir);
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

function validateWorkspaceMetadata(
  value: unknown,
  workspaceDir: string,
  source: string,
): WorkspaceMetadata {
  const metadata = requireRecord(value, source);
  const workspace = requireRecord(metadata["workspace"], `${source}.workspace`);

  requireString(workspace["version"], `${source}.workspace.version`);
  requireString(workspace["created_at"], `${source}.workspace.created_at`);
  validateResourceName(
    requireString(
      workspace["feature_name"],
      `${source}.workspace.feature_name`,
    ),
    "Workspace feature name",
  );
  optionalString(workspace["description"], `${source}.workspace.description`);
  const templateId = optionalString(
    workspace["template_id"],
    `${source}.workspace.template_id`,
  );
  if (templateId !== undefined) {
    validateResourceName(templateId, "Template name");
  }

  if (workspace["type"] !== undefined && workspace["type"] !== "review") {
    throw new Error(`${source}.workspace.type must be "review".`);
  }
  if (workspace["review"] !== undefined) {
    const review = requireRecord(
      workspace["review"],
      `${source}.workspace.review`,
    );
    validateRepositoryComponent(
      requireString(review["owner"], `${source}.workspace.review.owner`),
      "Repository owner",
    );
    validateRepositoryComponent(
      requireString(review["repo"], `${source}.workspace.review.repo`),
      "Repository name",
    );
  }

  const repos = requireArray(metadata["repos"], `${source}.repos`);
  for (const [index, entry] of repos.entries()) {
    validateWorkspaceRepoMetadata(entry, `${source}.repos[${index}]`);
  }

  if (metadata["temporary_worktrees"] !== undefined) {
    const worktrees = requireArray(
      metadata["temporary_worktrees"],
      `${source}.temporary_worktrees`,
    );
    for (const [index, entry] of worktrees.entries()) {
      validateTemporaryWorktreeMetadata(
        entry,
        workspaceDir,
        `${source}.temporary_worktrees[${index}]`,
      );
    }
  }

  if (metadata["review_worktrees"] !== undefined) {
    const worktrees = requireArray(
      metadata["review_worktrees"],
      `${source}.review_worktrees`,
    );
    for (const [index, entry] of worktrees.entries()) {
      validateReviewWorktreeMetadata(
        entry,
        workspaceDir,
        `${source}.review_worktrees[${index}]`,
      );
    }
  }

  return value as WorkspaceMetadata;
}

function validateWorkspaceRepoMetadata(value: unknown, source: string): void {
  const repo = requireRecord(value, source);
  validateRepositoryComponent(
    requireString(repo["name"], `${source}.name`),
    "Repository name",
  );
  requireString(repo["remote"], `${source}.remote`);
  requireString(repo["default_branch"], `${source}.default_branch`);
  requireBoolean(repo["has_lockfile"], `${source}.has_lockfile`);
  optionalString(repo["feature_branch"], `${source}.feature_branch`);
}

function validateTemporaryWorktreeMetadata(
  value: unknown,
  workspaceDir: string,
  source: string,
): void {
  const worktree = requireRecord(value, source);
  const slug = validateResourceName(
    requireString(worktree["slug"], `${source}.slug`),
    "Task name",
  );
  const parentRepo = validateRepositoryComponent(
    requireString(worktree["parent_repo"], `${source}.parent_repo`),
    "Repository name",
  );
  const worktreePath = requireString(worktree["path"], `${source}.path`);
  if (worktreePath !== slug) {
    throw new Error(`${source}.path must be exactly "${slug}".`);
  }
  validateMetadataPath(workspaceDir, worktreePath, `${source}.path`);
  requireString(worktree["branch"], `${source}.branch`);
  requireString(worktree["base_branch"], `${source}.base_branch`);
  requireString(worktree["base_sha"], `${source}.base_sha`);
  requireString(worktree["created_at"], `${source}.created_at`);
  if (
    worktree["setup_status"] !== "ready" &&
    worktree["setup_status"] !== "failed"
  ) {
    throw new Error(`${source}.setup_status must be "ready" or "failed".`);
  }
  const setupLog = optionalString(worktree["setup_log"], `${source}.setup_log`);
  if (setupLog !== undefined) {
    const expectedSetupLog = getTemporaryWorktreeSetupLogRelativePath(
      parentRepo,
      slug,
    );
    if (setupLog !== expectedSetupLog) {
      throw new Error(
        `${source}.setup_log must be exactly "${expectedSetupLog}".`,
      );
    }
    validateMetadataPath(workspaceDir, setupLog, `${source}.setup_log`);
  }
}

function validateReviewWorktreeMetadata(
  value: unknown,
  workspaceDir: string,
  source: string,
): void {
  const worktree = requireRecord(value, source);
  const prNumber = worktree["pr_number"];
  if (!Number.isSafeInteger(prNumber) || (prNumber as number) < 1) {
    throw new Error(`${source}.pr_number must be a positive integer.`);
  }
  validateMetadataPath(
    workspaceDir,
    requireString(worktree["path"], `${source}.path`),
    `${source}.path`,
  );
  optionalString(worktree["branch"], `${source}.branch`);
  requireString(worktree["created_at"], `${source}.created_at`);
}

function validateMetadataPath(
  workspaceDir: string,
  value: string,
  source: string,
): void {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolved = resolveContainedPath(resolvedWorkspaceDir, value);
  if (resolved === resolvedWorkspaceDir) {
    throw new Error(`${source} must identify a path inside the workspace.`);
  }
}

async function validateWorkspaceMetadataFilesystemPaths(
  metadata: WorkspaceMetadata,
  workspaceDir: string,
): Promise<void> {
  for (const worktree of metadata.temporary_worktrees ?? []) {
    await assertContainedPathWithoutSymlinks(
      workspaceDir,
      resolveContainedPath(workspaceDir, worktree.path),
    );
    if (worktree.setup_log) {
      await assertContainedPathWithoutSymlinks(
        workspaceDir,
        resolveContainedPath(workspaceDir, worktree.setup_log),
      );
    }
  }

  for (const worktree of metadata.review_worktrees ?? []) {
    await assertContainedPathWithoutSymlinks(
      workspaceDir,
      resolveContainedPath(workspaceDir, worktree.path),
    );
  }
}

export function getTemporaryWorktreeSetupLogRelativePath(
  parentRepo: string,
  slug: string,
): string {
  const repoName = validateRepositoryComponent(parentRepo, "Repository name");
  const taskName = validateResourceName(slug, "Task name");
  return path.posix.join(
    METADATA_FILENAME,
    "logs",
    `${repoName}-${taskName}.log`,
  );
}

function requireRecord(
  value: unknown,
  source: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, source: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${source} must be an array.`);
  }
  return value;
}

function requireString(value: unknown, source: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${source} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, source: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, source);
}

function requireBoolean(value: unknown, source: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${source} must be a boolean.`);
  }
  return value;
}
