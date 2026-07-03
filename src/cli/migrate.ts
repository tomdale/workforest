import { randomUUID } from "node:crypto";
import { type Dirent, promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "@wf-plugin/core";
import { loadWorkspaceConfig } from "../config.ts";
import {
  type CachedRepository,
  listCachedRepositories,
} from "../repositories.ts";
import { validateRepositoryComponent } from "../repository-components.ts";
import { resolveRepositorySpecifiers } from "../repository-specifiers.ts";
import { runGit } from "../services/git.ts";
import { formatTemplateIdentifier } from "../templates/index.ts";
import { compactHomePath } from "../terminal/paths.ts";
import {
  type ReportEntry,
  type ReportSection,
  renderReport,
} from "../terminal/report.ts";
import type { StatusTone } from "../terminal/status-indicator.ts";
import type {
  RepositorySource,
  WorkspaceConfig,
  WorkspaceMetadata,
} from "../types.ts";
import { comparablePath, validateResourceName } from "../utils/path-safety.ts";
import {
  getWorktreeMetadataPath,
  readWorkspaceMetadata,
  readWorktreeMetadata,
  writeWorktreeMetadata,
} from "../workspace/metadata.ts";
import {
  ADHOC_WORKSPACE_GROUP,
  getWorkspacePath,
  getWorktreePath,
  isPathInsideOrEqual,
  resolveWorkforestDirectories,
  TASKS_DIRECTORY_NAME,
  type WorkforestDirectories,
} from "../workspace/paths.ts";
import {
  failure,
  jsonOutput,
  jsonSuccess,
  reportOutput,
  success,
} from "./output.ts";
import type { CommandResult, ParsedInvocation } from "./types.ts";

export type WorkspaceMigrationEntry = Readonly<{
  source: string;
  target: string;
  selector: string;
  groupName: string;
  changeName: string;
  repoNames: readonly string[];
}>;

export type BlockedWorkspaceMigrationEntry = WorkspaceMigrationEntry &
  Readonly<{
    reason: string;
  }>;

export type RepositoryDirectoryMigrationEntry = Readonly<{
  repository: string;
  changeName: string;
  selector: string;
  source: string;
  target: string;
  metadataPath: string;
  branchName: string;
  repo: RepositorySource;
  hasLockfile: boolean;
}>;

export type BlockedRepositoryDirectoryMigrationEntry = Readonly<{
  repository: string;
  changeName: string;
  selector: string;
  source: string;
  target: string;
  metadataPath: string;
  reason: string;
}>;

export type RepositoryMetadataMigrationEntry = Readonly<{
  repository: string;
  changeName: string;
  selector: string;
  worktreePath: string;
  metadataPath: string;
  branchName: string;
  repo: RepositorySource;
  hasLockfile: boolean;
}>;

export type BlockedRepositoryMetadataMigrationEntry = Readonly<{
  repository: string;
  changeName: string;
  selector: string;
  worktreePath: string;
  metadataPath: string;
  reason: string;
}>;

export type WorkspaceMigrationResult = Readonly<{
  applied: boolean;
  planned: readonly WorkspaceMigrationEntry[];
  migrated: readonly WorkspaceMigrationEntry[];
  blocked: readonly BlockedWorkspaceMigrationEntry[];
  repositoryDirectories: Readonly<{
    planned: readonly RepositoryDirectoryMigrationEntry[];
    migrated: readonly RepositoryDirectoryMigrationEntry[];
    blocked: readonly BlockedRepositoryDirectoryMigrationEntry[];
  }>;
  repositoryMetadata: Readonly<{
    planned: readonly RepositoryMetadataMigrationEntry[];
    migrated: readonly RepositoryMetadataMigrationEntry[];
    blocked: readonly BlockedRepositoryMetadataMigrationEntry[];
  }>;
}>;

export async function runMigrateWorkspacesCommand(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  const apply = invocation.flags["apply"] === true;
  const json = invocation.flags["json"] === true;
  const { config } = await loadWorkspaceConfig();
  const result = await migrateWorkspaceLayout(config, { apply });

  if (json) {
    return result.applied && hasMigrationBlockers(result)
      ? failure(1, jsonOutput(result))
      : jsonSuccess(result);
  }

  const rendered = renderWorkspaceMigration(result);
  return result.applied && hasMigrationBlockers(result)
    ? failure(1, reportOutput(rendered))
    : success(reportOutput(rendered));
}

export async function migrateWorkspaceLayout(
  config: WorkspaceConfig,
  options: Readonly<{ apply: boolean }>,
): Promise<WorkspaceMigrationResult> {
  const directories = resolveWorkforestDirectories(config);
  const candidates = await readChildDirectories(directories.workspaces);
  const entries: WorkspaceMigrationEntry[] = [];
  const blocked: BlockedWorkspaceMigrationEntry[] = [];
  const repositoryDirectories = await planRepositoryDirectoryMigration(config);
  const repositoryMetadata = await planRepositoryMetadataMigration(config);

  for (const candidate of candidates) {
    const metadata = await readWorkspaceMetadata(candidate.path).catch(
      () => null,
    );
    if (!metadata) continue;

    const entry = migrationEntryFromMetadata(metadata, candidate.path, config);
    if (pathsEqual(entry.source, entry.target)) continue;

    if (await pathExists(entry.target)) {
      blocked.push({
        ...entry,
        reason: "Target already exists.",
      });
      continue;
    }

    entries.push(entry);
  }

  if (
    !options.apply ||
    blocked.length > 0 ||
    repositoryDirectories.blocked.length > 0 ||
    repositoryMetadata.blocked.length > 0
  ) {
    return {
      applied: options.apply,
      planned: entries,
      migrated: [],
      blocked,
      repositoryDirectories: {
        planned: repositoryDirectories.entries,
        migrated: [],
        blocked: repositoryDirectories.blocked,
      },
      repositoryMetadata: {
        planned: repositoryMetadata.entries,
        migrated: [],
        blocked: repositoryMetadata.blocked,
      },
    };
  }

  for (const entry of entries) {
    await moveWorkspaceDirectory(entry.source, entry.target);
  }
  for (const entry of repositoryDirectories.entries) {
    await moveWorkspaceDirectory(entry.source, entry.target);
    await writeWorktreeMetadata(path.dirname(entry.target), {
      featureName: entry.changeName,
      branchName: entry.branchName,
      repos: [
        {
          ...entry.repo,
          hasLockfile: entry.hasLockfile,
        },
      ],
    });
  }
  for (const entry of repositoryMetadata.entries) {
    await writeWorktreeMetadata(path.dirname(entry.worktreePath), {
      featureName: entry.changeName,
      branchName: entry.branchName,
      repos: [
        {
          ...entry.repo,
          hasLockfile: entry.hasLockfile,
        },
      ],
    });
  }

  return {
    applied: true,
    planned: [],
    migrated: entries,
    blocked: [],
    repositoryDirectories: {
      planned: [],
      migrated: repositoryDirectories.entries,
      blocked: [],
    },
    repositoryMetadata: {
      planned: [],
      migrated: repositoryMetadata.entries,
      blocked: [],
    },
  };
}

export function renderWorkspaceMigration(
  result: WorkspaceMigrationResult,
): string {
  const title = result.applied
    ? "Workspace migration"
    : "Workspace migration plan";
  const sections: ReportSection[] = [];
  const pushSection = (
    sectionTitle: string,
    entries: readonly ReportEntry[],
  ) => {
    if (entries.length > 0) sections.push({ title: sectionTitle, entries });
  };

  pushSection(
    "Ready",
    result.planned.map((entry) => workspaceEntry(entry, "pending")),
  );
  pushSection(
    "Moved",
    result.migrated.map((entry) => workspaceEntry(entry, "success")),
  );
  pushSection(
    "Blocked",
    result.blocked.map((entry) => workspaceEntry(entry, "error", entry.reason)),
  );
  pushSection(
    "Repository directories ready",
    result.repositoryDirectories.planned.map((entry) =>
      repositoryDirectoryEntry(entry, "pending"),
    ),
  );
  pushSection(
    "Repository directories moved",
    result.repositoryDirectories.migrated.map((entry) =>
      repositoryDirectoryEntry(entry, "success"),
    ),
  );
  pushSection(
    "Repository directories blocked",
    result.repositoryDirectories.blocked.map((entry) =>
      repositoryDirectoryEntry(entry, "error", entry.reason),
    ),
  );
  pushSection(
    "Repository metadata ready",
    result.repositoryMetadata.planned.map((entry) =>
      repositoryMetadataEntry(entry, "pending"),
    ),
  );
  pushSection(
    "Repository metadata written",
    result.repositoryMetadata.migrated.map((entry) =>
      repositoryMetadataEntry(entry, "success"),
    ),
  );
  pushSection(
    "Repository metadata blocked",
    result.repositoryMetadata.blocked.map((entry) =>
      repositoryMetadataEntry(entry, "error", entry.reason),
    ),
  );

  if (sections.length === 0) {
    return renderReport({
      title,
      sections: [
        {
          note: "No workspace directories, repository directories, or repository metadata need migration.",
        },
      ],
    });
  }

  const hasPlanned =
    result.planned.length > 0 ||
    result.repositoryDirectories.planned.length > 0 ||
    result.repositoryMetadata.planned.length > 0;

  return renderReport({
    title,
    sections,
    ...(!result.applied && hasPlanned
      ? { footer: "Run: wf migrate workspaces --apply" }
      : {}),
  });
}

function hasMigrationBlockers(result: WorkspaceMigrationResult): boolean {
  return (
    result.blocked.length > 0 ||
    result.repositoryDirectories.blocked.length > 0 ||
    result.repositoryMetadata.blocked.length > 0
  );
}

function migrationEntryFromMetadata(
  metadata: WorkspaceMetadata,
  source: string,
  config: WorkspaceConfig,
): WorkspaceMigrationEntry {
  const directories = resolveWorkforestDirectories(config);
  const groupName = metadata.workspace.template_id
    ? formatTemplateIdentifier({
        parent: metadata.workspace.template_id,
        variant: metadata.workspace.template_variant,
      })
    : ADHOC_WORKSPACE_GROUP;
  const changeName = metadata.workspace.feature_name;
  const target = getWorkspacePath(directories, groupName, changeName);

  return {
    source,
    target,
    selector: `${groupName}/${changeName}`,
    groupName,
    changeName,
    repoNames: metadata.repos.map((repo) => repo.name),
  };
}

async function planRepositoryDirectoryMigration(
  config: WorkspaceConfig,
): Promise<{
  entries: RepositoryDirectoryMigrationEntry[];
  blocked: BlockedRepositoryDirectoryMigrationEntry[];
}> {
  const directories = resolveWorkforestDirectories(config);
  const comparableDirectories =
    await comparableWorkforestDirectories(directories);
  const repositories = await listCachedRepositories();
  const entries: RepositoryDirectoryMigrationEntry[] = [];
  const blocked: BlockedRepositoryDirectoryMigrationEntry[] = [];
  const seenSources = new Set<string>();

  for (const repository of repositories) {
    const repoName = safeRepositoryName(repository.name);
    if (!repoName) continue;

    for (const worktree of repository.worktrees) {
      if (!worktree.exists || worktree.prunable) continue;

      const source = path.resolve(worktree.path);
      if (seenSources.has(source)) continue;
      seenSources.add(source);

      const candidate = await legacyRepositoryDirectoryCandidate(
        comparableDirectories,
        repoName,
        source,
      );
      if (!candidate) continue;

      const { changeName } = candidate;

      const target = getWorktreePath(directories, repoName, changeName);
      if (pathsEqual(source, target)) continue;

      const metadataPath = getWorktreeMetadataPath(
        path.dirname(target),
        changeName,
      );
      const base = {
        repository: repoName,
        changeName,
        selector: `${repoName}/${changeName}`,
        source,
        target,
        metadataPath,
      };

      if (await pathExists(target)) {
        blocked.push({
          ...base,
          reason: "Target already exists.",
        });
        continue;
      }

      const existing = await readWorktreeMetadata(
        path.dirname(target),
        changeName,
      ).catch(() => null);
      if (existing) {
        blocked.push({
          ...base,
          reason: "Repository metadata already exists.",
        });
        continue;
      }

      const repo = repoConfigFromCachedRepository(repository, repoName);
      if (!repo) {
        blocked.push({
          ...base,
          reason: "Could not infer repository remote.",
        });
        continue;
      }

      entries.push({
        ...base,
        repo,
        branchName: worktree.branch ?? changeName,
        hasLockfile: await hasLockfile(source),
      });
    }
  }

  return { entries, blocked };
}

async function legacyRepositoryDirectoryCandidate(
  directories: WorkforestDirectories,
  repoName: string,
  source: string,
): Promise<{ changeName: string } | null> {
  const comparableSource = await comparablePath(source);

  if (
    [directories.repos, directories.workspaces, directories.reviews].some(
      (managedRoot) => isPathInsideOrEqual(managedRoot, comparableSource),
    )
  ) {
    return null;
  }

  const relative = path.relative(
    path.resolve(directories.base),
    comparableSource,
  );
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }

  const parts = relative.split(path.sep);
  if (parts.length !== 2) {
    return null;
  }

  const [repoDirectoryName, changeDirectoryName] = parts;
  if (!repoDirectoryName || !changeDirectoryName) {
    return null;
  }
  if (safeRepositoryName(repoDirectoryName) !== repoName) {
    return null;
  }

  const changeName = safeResourceName(changeDirectoryName);
  return changeName ? { changeName } : null;
}

async function comparableWorkforestDirectories(
  directories: WorkforestDirectories,
): Promise<WorkforestDirectories> {
  return {
    base: await comparablePath(directories.base),
    repos: await comparablePath(directories.repos),
    workspaces: await comparablePath(directories.workspaces),
    reviews: await comparablePath(directories.reviews),
  };
}

function repoConfigFromCachedRepository(
  repository: CachedRepository,
  repoName: string,
): RepositorySource | null {
  if (!repository.remote) {
    return null;
  }

  return {
    name: repoName,
    remote: repository.remote,
  };
}

async function planRepositoryMetadataMigration(
  config: WorkspaceConfig,
): Promise<{
  entries: RepositoryMetadataMigrationEntry[];
  blocked: BlockedRepositoryMetadataMigrationEntry[];
}> {
  const directories = resolveWorkforestDirectories(config);
  const repositories = await readChildDirectories(directories.repos);
  const entries: RepositoryMetadataMigrationEntry[] = [];
  const blocked: BlockedRepositoryMetadataMigrationEntry[] = [];

  for (const repository of repositories) {
    const repoName = safeRepositoryName(repository.name);
    if (!repoName) continue;

    const changes = await readChildDirectories(repository.path);
    for (const change of changes) {
      if (
        change.name === TASKS_DIRECTORY_NAME ||
        change.name === ".workforest"
      ) {
        continue;
      }
      const changeName = safeResourceName(change.name);
      if (!changeName) continue;

      const existing = await readWorktreeMetadata(
        repository.path,
        changeName,
      ).catch(() => null);
      if (existing) continue;

      const base = {
        repository: repoName,
        changeName,
        selector: `${repoName}/${changeName}`,
        worktreePath: change.path,
        metadataPath: getWorktreeMetadataPath(repository.path, changeName),
      };
      const repo = await inferRepoConfig(repoName, change.path);
      if (!repo) {
        blocked.push({
          ...base,
          reason: "Could not infer repository remote.",
        });
        continue;
      }

      entries.push({
        ...base,
        repo,
        branchName:
          (await optionalGitLine(["branch", "--show-current"], change.path)) ??
          changeName,
        hasLockfile: await hasLockfile(change.path),
      });
    }
  }

  return { entries, blocked };
}

async function inferRepoConfig(
  repoName: string,
  worktreePath: string,
): Promise<RepositorySource | null> {
  const remote = await optionalGitLine(
    ["remote", "get-url", "origin"],
    worktreePath,
  );
  if (remote) {
    return {
      name: repoName,
      remote,
    };
  }

  const [cached] = await resolveRepositorySpecifiers([repoName]).catch(
    () => [],
  );
  return cached ?? null;
}

async function optionalGitLine(
  args: readonly string[],
  cwd: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGit([...args], { cwd, timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function hasLockfile(worktreePath: string): Promise<boolean> {
  return (
    (await pathExists(path.join(worktreePath, "pnpm-lock.yaml"))) ||
    (await pathExists(path.join(worktreePath, "pnpm-lock.yml")))
  );
}

async function readChildDirectories(
  root: string,
): Promise<readonly Readonly<{ name: string; path: string }>[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({ name: entry.name, path: path.join(root, entry.name) }));
}

async function moveWorkspaceDirectory(
  source: string,
  target: string,
): Promise<void> {
  const resolvedSource = path.resolve(source);
  const resolvedTarget = path.resolve(target);

  if (
    isPathInsideOrEqual(resolvedSource, resolvedTarget) &&
    !pathsEqual(resolvedSource, resolvedTarget)
  ) {
    const temporaryPath = path.join(
      path.dirname(resolvedSource),
      `.workforest-migrating-${path.basename(resolvedSource)}-${randomUUID()}`,
    );
    await fs.rename(resolvedSource, temporaryPath);
    try {
      await fs.mkdir(path.dirname(resolvedTarget), { recursive: true });
      await fs.rename(temporaryPath, resolvedTarget);
    } catch (error) {
      await restoreTemporaryMove(temporaryPath, resolvedSource);
      throw error;
    }
    return;
  }

  await fs.mkdir(path.dirname(resolvedTarget), { recursive: true });
  await fs.rename(resolvedSource, resolvedTarget);
}

async function restoreTemporaryMove(
  temporaryPath: string,
  source: string,
): Promise<void> {
  if ((await pathExists(temporaryPath)) && !(await pathExists(source))) {
    await fs.rename(temporaryPath, source).catch(() => undefined);
  }
}

function workspaceEntry(
  entry: WorkspaceMigrationEntry,
  tone: StatusTone,
  reason?: string,
): ReportEntry {
  return {
    title: entry.selector,
    tone,
    ...(reason ? { description: reason } : {}),
    details: [
      { label: "From", value: compactHomePath(entry.source) },
      { label: "To", value: compactHomePath(entry.target) },
    ],
  };
}

function repositoryDirectoryEntry(
  entry:
    | RepositoryDirectoryMigrationEntry
    | BlockedRepositoryDirectoryMigrationEntry,
  tone: StatusTone,
  reason?: string,
): ReportEntry {
  return {
    title: entry.selector,
    tone,
    ...(reason ? { description: reason } : {}),
    details: [
      { label: "From", value: compactHomePath(entry.source) },
      { label: "To", value: compactHomePath(entry.target) },
      { label: "Metadata", value: compactHomePath(entry.metadataPath) },
    ],
  };
}

function repositoryMetadataEntry(
  entry:
    | RepositoryMetadataMigrationEntry
    | BlockedRepositoryMetadataMigrationEntry,
  tone: StatusTone,
  reason?: string,
): ReportEntry {
  return {
    title: entry.selector,
    tone,
    ...(reason ? { description: reason } : {}),
    details: [
      { label: "Worktree", value: compactHomePath(entry.worktreePath) },
      { label: "Metadata", value: compactHomePath(entry.metadataPath) },
    ],
  };
}

function pathsEqual(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function safeRepositoryName(value: string): string | null {
  try {
    return validateRepositoryComponent(value, "Repository name");
  } catch {
    return null;
  }
}

function safeResourceName(value: string): string | null {
  try {
    return validateResourceName(value, "Name");
  } catch {
    return null;
  }
}
