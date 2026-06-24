import { type Dirent, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateRepositoryComponent } from "../repository-components.ts";
import { runGit } from "../services/git.ts";
import type { WorkspaceConfig } from "../types.ts";
import { pathExists } from "../utils/fs.ts";
import { validateResourceName } from "../utils/path-safety.ts";
import { readWorkspaceMetadata } from "./metadata.ts";
import {
  ADHOC_WORKSPACE_GROUP,
  resolveWorkforestDirectories,
  TASKS_DIRECTORY_NAME,
  type WorkforestDirectories,
} from "./paths.ts";

export type ChangeState = "clean" | "dirty" | "stale";

export type WorkspaceChangeInventoryEntry = Readonly<{
  type: "template-workspace" | "adhoc-workspace";
  selector: string;
  groupName: string;
  changeName: string;
  repos: readonly string[];
  repoSummary: string;
  state: ChangeState;
  modifiedAt: string;
  modifiedAtMs: number;
  path: string;
}>;

export type RepositoryChangeInventoryEntry = Readonly<{
  type: "repository-change";
  selector: string;
  groupName: string;
  changeName: string;
  repository: string;
  state: ChangeState;
  modifiedAt: string;
  modifiedAtMs: number;
  path: string;
}>;

export type ChangeInventory = Readonly<{
  workspaces: readonly WorkspaceChangeInventoryEntry[];
  repositories: readonly RepositoryChangeInventoryEntry[];
  totals: Readonly<{
    workspaces: number;
    repositories: number;
  }>;
}>;

export type ChangeInventoryFilters = Readonly<{
  repo?: string;
  group?: string;
}>;

export type RenderChangeListOptions = Readonly<{
  paths?: boolean;
  now?: number;
}>;

export async function collectChangeInventory(
  config: WorkspaceConfig,
  filters: ChangeInventoryFilters = {},
): Promise<ChangeInventory> {
  const directories = resolveWorkforestDirectories(config);
  const [workspaces, repositories] = await Promise.all([
    collectWorkspaceChanges(directories),
    collectRepositoryChanges(directories),
  ]);
  const filteredWorkspaces = workspaces.filter(
    (entry) =>
      (!filters.repo || entry.repos.includes(filters.repo)) &&
      (!filters.group || entry.groupName === filters.group),
  );
  const filteredRepositories = repositories.filter(
    (entry) =>
      (!filters.repo || entry.repository === filters.repo) &&
      (!filters.group || entry.groupName === filters.group),
  );

  return {
    workspaces: sortWorkspaceChanges(filteredWorkspaces),
    repositories: sortRepositoryChanges(filteredRepositories),
    totals: {
      workspaces: filteredWorkspaces.length,
      repositories: filteredRepositories.length,
    },
  };
}

export function renderChangeList(
  inventory: ChangeInventory,
  options: RenderChangeListOptions = {},
): string {
  if (
    inventory.totals.workspaces === 0 &&
    inventory.totals.repositories === 0
  ) {
    return [
      "No Workforest changes found.",
      "Start one: wf start <change> <repo|@template>",
    ].join("\n");
  }

  const lines = ["Changes"];
  if (inventory.workspaces.length > 0) {
    lines.push("", "Workspaces");
    for (const [groupName, entries] of groupWorkspaceEntries(
      inventory.workspaces,
    )) {
      lines.push(`  ${groupName}`);
      lines.push(formatWorkspaceHeader(options.paths === true));
      for (const entry of entries) {
        lines.push(formatWorkspaceRow(entry, options));
      }
      lines.push("");
    }
    trimTrailingBlank(lines);
  }

  if (inventory.repositories.length > 0) {
    lines.push("", "Repositories");
    for (const [repoName, entries] of groupRepositoryEntries(
      inventory.repositories,
    )) {
      lines.push(`  ${repoName}`);
      lines.push(formatRepositoryHeader(options.paths === true));
      for (const entry of entries) {
        lines.push(formatRepositoryRow(entry, options));
      }
      lines.push("");
    }
    trimTrailingBlank(lines);
  }

  lines.push(
    "",
    `${inventory.totals.workspaces} workspace${inventory.totals.workspaces === 1 ? "" : "s"}, ${inventory.totals.repositories} repository change${inventory.totals.repositories === 1 ? "" : "s"}`,
  );
  return lines.join("\n");
}

async function collectWorkspaceChanges(
  directories: WorkforestDirectories,
): Promise<WorkspaceChangeInventoryEntry[]> {
  const groups = await readChildDirectories(directories.workspaces);
  const entries: WorkspaceChangeInventoryEntry[] = [];

  for (const group of groups) {
    const groupName = safeWorkspaceGroupName(group.name);
    if (!groupName) continue;

    const changes = await readChildDirectories(group.path);
    for (const change of changes) {
      const changeName = safeResourceName(change.name);
      if (!changeName) continue;

      const changePath = path.join(group.path, changeName);
      const metadata = await readWorkspaceMetadata(changePath).catch(
        () => null,
      );
      const repos =
        metadata?.repos.map((repo) => repo.name) ??
        (await inferWorkspaceRepoNames(changePath));
      const repoPaths = repos.map((repo) => path.join(changePath, repo));
      const modifiedAtMs = await newestMtimeMs([
        changePath,
        path.join(changePath, ".workforest"),
        ...repoPaths,
      ]);

      entries.push({
        type:
          groupName === ADHOC_WORKSPACE_GROUP
            ? "adhoc-workspace"
            : "template-workspace",
        selector: `${groupName}/${changeName}`,
        groupName,
        changeName,
        repos,
        repoSummary: summarizeRepos(repos),
        state: await aggregateRepoState(repoPaths),
        modifiedAt: new Date(modifiedAtMs).toISOString(),
        modifiedAtMs,
        path: changePath,
      });
    }
  }

  return entries;
}

async function collectRepositoryChanges(
  directories: WorkforestDirectories,
): Promise<RepositoryChangeInventoryEntry[]> {
  const repositories = await readChildDirectories(directories.repos);
  const entries: RepositoryChangeInventoryEntry[] = [];

  for (const repository of repositories) {
    const repoName = safeRepositoryName(repository.name);
    if (!repoName) continue;

    const changes = await readChildDirectories(repository.path);
    for (const change of changes) {
      if (change.name === TASKS_DIRECTORY_NAME) continue;
      const changeName = safeResourceName(change.name);
      if (!changeName) continue;

      const changePath = path.join(repository.path, changeName);
      const modifiedAtMs = await newestMtimeMs([
        changePath,
        path.join(changePath, ".workforest"),
      ]);
      entries.push({
        type: "repository-change",
        selector: `${repoName}/${changeName}`,
        groupName: repoName,
        changeName,
        repository: repoName,
        state: await detectRepoState(changePath),
        modifiedAt: new Date(modifiedAtMs).toISOString(),
        modifiedAtMs,
        path: changePath,
      });
    }
  }

  return entries;
}

async function inferWorkspaceRepoNames(
  changePath: string,
): Promise<readonly string[]> {
  const entries = await readChildDirectories(changePath);
  return entries
    .map((entry) => entry.name)
    .filter(
      (name) => name !== TASKS_DIRECTORY_NAME && safeRepositoryName(name),
    );
}

async function aggregateRepoState(
  repoPaths: readonly string[],
): Promise<ChangeState> {
  if (repoPaths.length === 0) {
    return "stale";
  }

  const states = await Promise.all(repoPaths.map(detectRepoState));
  if (states.includes("dirty")) {
    return "dirty";
  }
  if (states.includes("stale")) {
    return "stale";
  }
  return "clean";
}

async function detectRepoState(repoPath: string): Promise<ChangeState> {
  if (!(await pathExists(repoPath))) {
    return "stale";
  }

  try {
    const { stdout } = await runGit(["status", "--porcelain"], {
      cwd: repoPath,
    });
    return stdout.trim().length > 0 ? "dirty" : "clean";
  } catch {
    return "stale";
  }
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

async function newestMtimeMs(paths: readonly string[]): Promise<number> {
  const times = await Promise.all(
    paths.map(async (candidate) => {
      try {
        return (await fs.stat(candidate)).mtimeMs;
      } catch {
        return 0;
      }
    }),
  );
  const newest = Math.max(0, ...times);
  return newest === 0 ? Date.now() : newest;
}

function sortWorkspaceChanges(
  entries: readonly WorkspaceChangeInventoryEntry[],
): WorkspaceChangeInventoryEntry[] {
  return [...entries].sort(
    (left, right) =>
      compareWorkspaceGroups(left.groupName, right.groupName) ||
      compareEntries(left, right),
  );
}

function sortRepositoryChanges(
  entries: readonly RepositoryChangeInventoryEntry[],
): RepositoryChangeInventoryEntry[] {
  return [...entries].sort(
    (left, right) =>
      left.groupName.localeCompare(right.groupName) ||
      compareEntries(left, right),
  );
}

function compareWorkspaceGroups(left: string, right: string): number {
  if (left === ADHOC_WORKSPACE_GROUP && right !== ADHOC_WORKSPACE_GROUP) {
    return 1;
  }
  if (right === ADHOC_WORKSPACE_GROUP && left !== ADHOC_WORKSPACE_GROUP) {
    return -1;
  }
  return left.localeCompare(right);
}

function compareEntries(
  left: { modifiedAtMs: number; changeName: string },
  right: { modifiedAtMs: number; changeName: string },
): number {
  return (
    right.modifiedAtMs - left.modifiedAtMs ||
    left.changeName.localeCompare(right.changeName)
  );
}

function groupWorkspaceEntries(
  entries: readonly WorkspaceChangeInventoryEntry[],
): Array<[string, WorkspaceChangeInventoryEntry[]]> {
  return groupEntries(entries, (entry) => entry.groupName);
}

function groupRepositoryEntries(
  entries: readonly RepositoryChangeInventoryEntry[],
): Array<[string, RepositoryChangeInventoryEntry[]]> {
  return groupEntries(entries, (entry) => entry.groupName);
}

function groupEntries<Entry>(
  entries: readonly Entry[],
  keyFor: (entry: Entry) => string,
): Array<[string, Entry[]]> {
  const grouped = new Map<string, Entry[]>();
  for (const entry of entries) {
    const key = keyFor(entry);
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }
  return [...grouped.entries()];
}

function formatWorkspaceHeader(showPaths: boolean): string {
  return `    ${formatColumns(
    ["Change", "Repos", "State", "Updated"],
    showPaths,
  )}`;
}

function formatRepositoryHeader(showPaths: boolean): string {
  return `    ${formatColumns(
    ["Change", "Repository", "State", "Updated"],
    showPaths,
  )}`;
}

function formatWorkspaceRow(
  entry: WorkspaceChangeInventoryEntry,
  options: RenderChangeListOptions,
): string {
  return `    ${formatColumns(
    [
      entry.changeName,
      entry.repoSummary,
      entry.state,
      formatRelativeTime(entry.modifiedAtMs, options.now),
    ],
    options.paths === true,
    entry.path,
  )}`;
}

function formatRepositoryRow(
  entry: RepositoryChangeInventoryEntry,
  options: RenderChangeListOptions,
): string {
  return `    ${formatColumns(
    [
      entry.changeName,
      entry.repository,
      entry.state,
      formatRelativeTime(entry.modifiedAtMs, options.now),
    ],
    options.paths === true,
    entry.path,
  )}`;
}

function formatColumns(
  values: readonly string[],
  showPath: boolean,
  entryPath?: string,
): string {
  const widths = [24, 18, 8];
  const columns = values.map((value, index) => {
    const width = widths[index];
    return width ? value.padEnd(width) : value;
  });
  return showPath && entryPath
    ? [...columns, compactHome(entryPath)].join("  ")
    : columns.join("  ");
}

function summarizeRepos(repos: readonly string[]): string {
  if (repos.length <= 2) {
    return repos.join(", ");
  }
  return `${repos.slice(0, 2).join(", ")} +${repos.length - 2}`;
}

function formatRelativeTime(modifiedAtMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - modifiedAtMs) / 1000));
  if (seconds < 60) {
    return "0m";
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }

  return `${Math.floor(hours / 24)}d`;
}

function compactHome(value: string): string {
  const home = os.homedir();
  return value === home
    ? "~"
    : value.startsWith(`${home}${path.sep}`)
      ? path.join("~", path.relative(home, value))
      : value;
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
    return validateResourceName(value, "Change name");
  } catch {
    return null;
  }
}

function safeWorkspaceGroupName(value: string): string | null {
  if (value === ADHOC_WORKSPACE_GROUP) {
    return value;
  }

  return safeResourceName(value);
}

function trimTrailingBlank(lines: string[]): void {
  while (lines.at(-1) === "") {
    lines.pop();
  }
}
