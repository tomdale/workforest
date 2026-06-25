import { randomUUID } from "node:crypto";
import { promises as fs, lstatSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { validateRepositoryComponent } from "../repository-components.ts";
import type {
  ReviewWorktreeMetadata,
  TaskMetadata,
  WorkspaceMetadata,
  WorkspaceRepoMetadata,
} from "../types.ts";
import { pathExists } from "../utils/fs.ts";
import {
  assertContainedPathWithoutSymlinks,
  resolveContainedPath,
  validateResourceName,
} from "../utils/path-safety.ts";
import { TASKS_DIRECTORY_NAME } from "./paths.ts";

const METADATA_FILENAME = ".workforest";
const WORKSPACE_METADATA_FILENAME = "workspace.json";
const WORKSPACE_METADATA_LOCK_FILENAME = ".workforest.lock";
const REPOSITORY_CHANGES_METADATA_DIR = "changes";
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

export type RepositoryChangeMetadataEntry = Readonly<{
  changeName: string;
  metadataPath: string;
  metadata: WorkspaceMetadata;
}>;

function metadataFromOptions(options: WriteMetadataOptions): WorkspaceMetadata {
  return {
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
}

/**
 * Write workspace metadata to .workforest/workspace.json.
 */
export async function writeWorkspaceMetadata(
  workspaceDir: string,
  options: WriteMetadataOptions,
): Promise<void> {
  await saveWorkspaceMetadata(workspaceDir, metadataFromOptions(options));
}

export async function writeRepositoryChangeMetadata(
  repoRootDir: string,
  options: WriteMetadataOptions,
): Promise<void> {
  const changeName = validateResourceName(options.featureName, "Change name");
  const metadata = metadataFromOptions({ ...options, featureName: changeName });
  const metadataPath = getRepositoryChangeMetadataPath(repoRootDir, changeName);

  await withWorkspaceMetadataLock(repoRootDir, async () => {
    await writeMetadataFile(metadataPath, repoRootDir, metadata, {
      source: "repository change metadata",
      ensureParent: async () => {
        await assertRepositoryMetadataPathNotSymlink(repoRootDir);
        await fs.mkdir(path.dirname(metadataPath), { recursive: true });
        await assertRepositoryMetadataPathNotSymlink(repoRootDir);
      },
    });
  });
}

export async function readRepositoryChangeMetadata(
  repoRootDir: string,
  changeName: string,
): Promise<WorkspaceMetadata | null> {
  const safeChangeName = validateResourceName(changeName, "Change name");
  const metadataPath = getRepositoryChangeMetadataPath(
    repoRootDir,
    safeChangeName,
  );
  const metadata = await readMetadataFile(
    metadataPath,
    repoRootDir,
    "repository change metadata",
  );
  if (!metadata) {
    return null;
  }
  if (metadata.workspace.feature_name !== safeChangeName) {
    throw new Error(
      `${metadataPath}.workspace.feature_name must match "${safeChangeName}".`,
    );
  }
  return metadata;
}

export async function removeRepositoryChangeMetadata(
  repoRootDir: string,
  changeName: string,
): Promise<void> {
  const metadataPath = getRepositoryChangeMetadataPath(repoRootDir, changeName);
  await withWorkspaceMetadataLock(repoRootDir, async () => {
    await fs.rm(metadataPath, { force: true });
  });
}

export async function listRepositoryChangeMetadata(
  repoRootDir: string,
): Promise<RepositoryChangeMetadataEntry[]> {
  const metadataRoot =
    await assertRepositoryMetadataPathNotSymlink(repoRootDir);
  const changesDir = path.join(metadataRoot, REPOSITORY_CHANGES_METADATA_DIR);
  let entries: Array<{ isFile(): boolean; name: string }>;

  try {
    entries = await fs.readdir(changesDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const changes: RepositoryChangeMetadataEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const changeName = safeResourceName(entry.name.slice(0, -".json".length));
    if (!changeName) continue;

    const metadataPath = path.join(changesDir, entry.name);
    const metadata = await readMetadataFile(
      metadataPath,
      repoRootDir,
      "repository change metadata",
    );
    if (!metadata) continue;
    if (metadata.workspace.feature_name !== changeName) {
      throw new Error(
        `${metadataPath}.workspace.feature_name must match "${changeName}".`,
      );
    }

    changes.push({ changeName, metadataPath, metadata });
  }

  return changes.sort((left, right) =>
    left.changeName.localeCompare(right.changeName),
  );
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

export async function appendTasks(
  workspaceDir: string,
  tasks: readonly TaskMetadata[],
): Promise<WorkspaceMetadata> {
  return mutateWorkspaceMetadata(workspaceDir, (metadata) => ({
    ...metadata,
    tasks: [...(metadata.tasks ?? []), ...tasks],
  }));
}

export async function removeTasks(
  workspaceDir: string,
  entriesToRemove: readonly Pick<TaskMetadata, "parent_repo" | "slug">[],
): Promise<WorkspaceMetadata> {
  return mutateWorkspaceMetadata(workspaceDir, (metadata) => {
    const removeKeys = new Set(
      entriesToRemove.map((entry) => `${entry.parent_repo}\0${entry.slug}`),
    );
    const tasks = (metadata.tasks ?? []).filter(
      (entry) => !removeKeys.has(`${entry.parent_repo}\0${entry.slug}`),
    );

    const nextMetadata: WorkspaceMetadata = {
      ...metadata,
      ...(tasks.length > 0 ? { tasks } : {}),
    };

    if (tasks.length === 0) {
      delete nextMetadata.tasks;
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

export function getRepositoryChangeMetadataPath(
  repoRootDir: string,
  changeName: string,
): string {
  return path.join(
    getRepositoryMetadataDirPath(repoRootDir),
    REPOSITORY_CHANGES_METADATA_DIR,
    `${validateResourceName(changeName, "Change name")}.json`,
  );
}

/**
 * Get the path to the workspace metadata directory.
 */
export function getWorkspaceMetadataDirPath(workspaceDir: string): string {
  return assertWorkspaceMetadataPathNotSymlinkSync(workspaceDir);
}

export function getRepositoryMetadataDirPath(repoRootDir: string): string {
  return assertRepositoryMetadataPathNotSymlinkSync(repoRootDir);
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
  const metadataDir = await assertWorkspaceMetadataPathNotSymlink(workspaceDir);

  try {
    const stat = await fs.lstat(metadataDir);
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
  await assertWorkspaceMetadataPathNotSymlink(workspaceDir);
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
  await writeMetadataFile(metadataPath, workspaceDir, metadata, {
    source: "workspace metadata",
    ensureParent: async () => {
      await assertWorkspaceMetadataPathNotSymlink(workspaceDir);
    },
  });
}

async function readMetadataFile(
  metadataPath: string,
  rootDir: string,
  source: string,
): Promise<WorkspaceMetadata | null> {
  await assertContainedPathWithoutSymlinks(rootDir, metadataPath);

  let contents: string;
  try {
    contents = await fs.readFile(metadataPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(
      `Unable to parse ${source} at ${metadataPath}. Expected JSON format.`,
    );
  }

  const metadata = validateWorkspaceMetadata(parsed, rootDir, metadataPath);
  await validateWorkspaceMetadataFilesystemPaths(metadata, rootDir);
  return metadata;
}

async function writeMetadataFile(
  metadataPath: string,
  rootDir: string,
  metadata: WorkspaceMetadata,
  options: Readonly<{
    source: string;
    ensureParent: () => Promise<void>;
  }>,
): Promise<void> {
  const validated = validateWorkspaceMetadata(
    metadata,
    rootDir,
    options.source,
  );
  await validateWorkspaceMetadataFilesystemPaths(validated, rootDir);
  await options.ensureParent();
  await assertContainedPathWithoutSymlinks(rootDir, path.dirname(metadataPath));
  const temporaryPath = `${metadataPath}.${process.pid}.${randomUUID()}.tmp`;
  const contents = `${JSON.stringify(validated, null, 2)}\n`;

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
  await assertWorkspaceMetadataPathNotSymlink(workspaceDir);
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
  const metadataDir = await assertWorkspaceMetadataPathNotSymlink(workspaceDir);

  try {
    const stat = await fs.lstat(metadataDir);
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

function assertWorkspaceMetadataPathNotSymlinkSync(
  workspaceDir: string,
): string {
  const metadataPath = path.join(workspaceDir, METADATA_FILENAME);

  try {
    if (lstatSync(metadataPath).isSymbolicLink()) {
      throw new Error(
        `Workspace metadata path must not be a symbolic link: ${path.resolve(metadataPath)}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return metadataPath;
}

async function assertWorkspaceMetadataPathNotSymlink(
  workspaceDir: string,
): Promise<string> {
  const metadataPath = path.join(workspaceDir, METADATA_FILENAME);

  try {
    if ((await fs.lstat(metadataPath)).isSymbolicLink()) {
      throw new Error(
        `Workspace metadata path must not be a symbolic link: ${path.resolve(metadataPath)}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return metadataPath;
}

function assertRepositoryMetadataPathNotSymlinkSync(
  repoRootDir: string,
): string {
  const metadataPath = path.join(repoRootDir, METADATA_FILENAME);

  try {
    if (lstatSync(metadataPath).isSymbolicLink()) {
      throw new Error(
        `Repository metadata path must not be a symbolic link: ${path.resolve(metadataPath)}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return metadataPath;
}

async function assertRepositoryMetadataPathNotSymlink(
  repoRootDir: string,
): Promise<string> {
  const metadataPath = path.join(repoRootDir, METADATA_FILENAME);

  try {
    if ((await fs.lstat(metadataPath)).isSymbolicLink()) {
      throw new Error(
        `Repository metadata path must not be a symbolic link: ${path.resolve(metadataPath)}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return metadataPath;
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

function safeResourceName(value: string): string | null {
  try {
    return validateResourceName(value, "Change name");
  } catch {
    return null;
  }
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

  if (metadata["tasks"] !== undefined) {
    const tasks = requireArray(metadata["tasks"], `${source}.tasks`);
    for (const [index, entry] of tasks.entries()) {
      validateTaskMetadata(entry, workspaceDir, `${source}.tasks[${index}]`);
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

function validateTaskMetadata(
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
  const expectedTaskPath = path.posix.join(
    TASKS_DIRECTORY_NAME,
    parentRepo,
    slug,
  );
  if (worktreePath !== expectedTaskPath) {
    throw new Error(`${source}.path must be exactly "${expectedTaskPath}".`);
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
    const expectedSetupLog = getTaskSetupLogRelativePath(parentRepo, slug);
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
  const worktreePath = requireString(worktree["path"], `${source}.path`);
  const expectedPath = `pr-${prNumber as number}`;
  if (worktreePath !== expectedPath) {
    throw new Error(`${source}.path must be exactly "${expectedPath}".`);
  }
  validateMetadataPath(workspaceDir, worktreePath, `${source}.path`);
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
  for (const worktree of metadata.tasks ?? []) {
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

export function getTaskSetupLogRelativePath(
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
