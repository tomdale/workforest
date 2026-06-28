import { type Dirent, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathExists } from "@wf-plugin/core";
import { validateRepositoryComponent } from "../repository-components.ts";
import {
  formatTemplateIdentifier,
  validateTemplateIdentifier,
} from "../templates/index.ts";
import {
  renderTerminalDocInline,
  type TerminalDoc,
  type TerminalLineInput,
  type TerminalSpan,
  terminalSpan,
} from "../terminal/render-model.ts";
import type { StatusTone } from "../terminal/status-indicator.ts";
import { padRight } from "../terminal/text.ts";
import { terminalSymbol } from "../terminal/theme.ts";
import type { WorkspaceConfig, WorkspaceMetadata } from "../types.ts";
import { validateResourceName } from "../utils/path-safety.ts";
import { listWorktreeMetadata, readWorkspaceMetadata } from "./metadata.ts";
import {
  ADHOC_WORKSPACE_GROUP,
  resolveWorkforestDirectories,
  type WorkforestDirectories,
} from "./paths.ts";

export type EntryState = "ready" | "stale";

export type WorkspaceInventoryEntry = Readonly<{
  type: "template-workspace" | "adhoc-workspace";
  selector: string;
  groupName: string;
  changeName: string;
  repos: readonly string[];
  repoSummary: string;
  state: EntryState;
  modifiedAt: string;
  modifiedAtMs: number;
  path: string;
}>;

export type WorktreeInventoryEntry = Readonly<{
  type: "worktree";
  selector: string;
  groupName: string;
  changeName: string;
  repository: string;
  state: EntryState;
  modifiedAt: string;
  modifiedAtMs: number;
  path: string;
}>;

export type InventoryEntry = WorkspaceInventoryEntry | WorktreeInventoryEntry;

export type Inventory = Readonly<{
  workspaces: readonly WorkspaceInventoryEntry[];
  repositories: readonly WorktreeInventoryEntry[];
  totals: Readonly<{
    workspaces: number;
    repositories: number;
  }>;
}>;

export type InventoryFilters = Readonly<{
  repo?: string;
  group?: string;
}>;

export type RenderListOptions = Readonly<{
  paths?: boolean;
  now?: number;
}>;

export async function collectInventory(
  config: WorkspaceConfig,
  filters: InventoryFilters = {},
): Promise<Inventory> {
  const directories = resolveWorkforestDirectories(config);
  const [workspaces, repositories] = await Promise.all([
    collectWorkspaces(directories),
    collectWorktrees(directories),
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
    workspaces: sortWorkspaces(filteredWorkspaces),
    repositories: sortWorktrees(filteredRepositories),
    totals: {
      workspaces: filteredWorkspaces.length,
      repositories: filteredRepositories.length,
    },
  };
}

export function renderList(
  inventory: Inventory,
  options: RenderListOptions = {},
): string {
  return renderTerminalDocInline(inventoryDoc(inventory, options));
}

export function inventoryDoc(
  inventory: Inventory,
  options: RenderListOptions = {},
): TerminalDoc {
  if (
    inventory.totals.workspaces === 0 &&
    inventory.totals.repositories === 0
  ) {
    return {
      lines: [
        { spans: [terminalSpan("No worktrees or workspaces found.")] },
        {
          spans: [
            terminalSpan("Start one: wf new <name> <repo|@template>", {
              role: "muted",
            }),
          ],
        },
      ],
    };
  }

  const lines: TerminalLineInput[] = [
    [terminalSpan("Changes", { role: "primary", emphasis: "bold" })],
  ];
  if (inventory.workspaces.length > 0) {
    lines.push("", [
      terminalSpan("Workspaces", { role: "accent", emphasis: "bold" }),
    ]);
    for (const [groupName, entries] of groupWorkspaceEntries(
      inventory.workspaces,
    )) {
      lines.push(["  ", terminalSpan(groupName, { role: "focus" })]);
      lines.push(formatWorkspaceHeader(options.paths === true));
      for (const entry of entries) {
        lines.push(formatWorkspaceRow(entry, options));
      }
      lines.push("");
    }
    trimTrailingBlank(lines);
  }

  if (inventory.repositories.length > 0) {
    lines.push("", [
      terminalSpan("Repositories", { role: "accent", emphasis: "bold" }),
    ]);
    for (const [repoName, entries] of groupRepositoryEntries(
      inventory.repositories,
    )) {
      lines.push(["  ", terminalSpan(repoName, { role: "focus" })]);
      lines.push(formatRepositoryHeader(options.paths === true));
      for (const entry of entries) {
        lines.push(formatRepositoryRow(entry, options));
      }
      lines.push("");
    }
    trimTrailingBlank(lines);
  }

  lines.push("", [
    terminalSpan(
      `${inventory.totals.workspaces} workspace${inventory.totals.workspaces === 1 ? "" : "s"}, ${inventory.totals.repositories} worktree${inventory.totals.repositories === 1 ? "" : "s"}`,
      { role: "muted" },
    ),
  ]);
  return { lines: lines.map((line) => normalizeLine(line)) };
}

async function collectWorkspaces(
  directories: WorkforestDirectories,
): Promise<WorkspaceInventoryEntry[]> {
  const candidates = await readChildDirectories(directories.workspaces);
  const entries: WorkspaceInventoryEntry[] = [];

  for (const candidate of candidates) {
    const directMetadata = await readWorkspaceMetadata(candidate.path).catch(
      () => null,
    );
    if (directMetadata) {
      entries.push(
        await workspaceInventoryEntryFromMetadata({
          metadata: directMetadata,
          path: candidate.path,
          groupName: groupNameFromMetadata(directMetadata),
          changeName: directMetadata.workspace.feature_name,
        }),
      );
      continue;
    }

    const group = candidate;
    const groupName = safeWorkspaceGroupName(group.name);
    if (!groupName) continue;

    const changes = await readChildDirectories(group.path);
    for (const change of changes) {
      const changeName = safeResourceName(change.name);
      if (!changeName) continue;

      const targetPath = path.join(group.path, changeName);
      const metadata = await readWorkspaceMetadata(targetPath).catch(
        () => null,
      );
      if (!metadata) continue;

      entries.push(
        await workspaceInventoryEntryFromMetadata({
          metadata,
          path: targetPath,
          groupName,
          changeName,
        }),
      );
    }
  }

  return entries;
}

async function workspaceInventoryEntryFromMetadata({
  metadata,
  path: targetPath,
  groupName,
  changeName,
}: {
  metadata: WorkspaceMetadata;
  path: string;
  groupName: string;
  changeName: string;
}): Promise<WorkspaceInventoryEntry> {
  const repos = metadata.repos.map((repo) => repo.name);
  const repoPaths = repos.map((repo) => path.join(targetPath, repo));
  const modifiedAtMs = await newestMtimeMs([
    targetPath,
    path.join(targetPath, ".workforest"),
    ...repoPaths,
  ]);

  return {
    type:
      groupName === ADHOC_WORKSPACE_GROUP
        ? "adhoc-workspace"
        : "template-workspace",
    selector: `${groupName}/${changeName}`,
    groupName,
    changeName,
    repos,
    repoSummary: summarizeRepos(repos),
    state: await aggregatePathState(repoPaths),
    modifiedAt: new Date(modifiedAtMs).toISOString(),
    modifiedAtMs,
    path: targetPath,
  };
}

async function collectWorktrees(
  directories: WorkforestDirectories,
): Promise<WorktreeInventoryEntry[]> {
  const repositories = await readChildDirectories(directories.repos);
  const entries: WorktreeInventoryEntry[] = [];

  for (const repository of repositories) {
    const repoName = safeRepositoryName(repository.name);
    if (!repoName) continue;

    const changes = await listWorktreeMetadata(repository.path).catch(() => []);
    for (const change of changes) {
      const changeName = change.metadata.workspace.feature_name;
      const targetPath = path.join(repository.path, changeName);

      const modifiedAtMs = await newestMtimeMs([
        targetPath,
        change.metadataPath,
      ]);
      entries.push({
        type: "worktree",
        selector: `${repoName}/${changeName}`,
        groupName: repoName,
        changeName,
        repository: repoName,
        state: await aggregatePathState([targetPath]),
        modifiedAt: new Date(modifiedAtMs).toISOString(),
        modifiedAtMs,
        path: targetPath,
      });
    }
  }

  return entries;
}

async function aggregatePathState(
  repoPaths: readonly string[],
): Promise<EntryState> {
  if (repoPaths.length === 0) {
    return "stale";
  }

  const states = await Promise.all(repoPaths.map(pathExists));
  return states.every(Boolean) ? "ready" : "stale";
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

function sortWorkspaces(
  entries: readonly WorkspaceInventoryEntry[],
): WorkspaceInventoryEntry[] {
  return [...entries].sort(
    (left, right) =>
      compareWorkspaceGroups(left.groupName, right.groupName) ||
      compareEntries(left, right),
  );
}

function sortWorktrees(
  entries: readonly WorktreeInventoryEntry[],
): WorktreeInventoryEntry[] {
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
  entries: readonly WorkspaceInventoryEntry[],
): Array<[string, WorkspaceInventoryEntry[]]> {
  return groupEntries(entries, (entry) => entry.groupName);
}

function groupRepositoryEntries(
  entries: readonly WorktreeInventoryEntry[],
): Array<[string, WorktreeInventoryEntry[]]> {
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

function formatWorkspaceHeader(showPaths: boolean): TerminalLineInput {
  return [
    "    ",
    ...formatColumns(
      ["Change", "Repos", "State", "Updated"].map((value) =>
        terminalSpan(value, { role: "muted" }),
      ),
      showPaths,
    ),
  ];
}

function formatRepositoryHeader(showPaths: boolean): TerminalLineInput {
  return [
    "    ",
    ...formatColumns(
      ["Change", "Repository", "State", "Updated"].map((value) =>
        terminalSpan(value, { role: "muted" }),
      ),
      showPaths,
    ),
  ];
}

function formatWorkspaceRow(
  entry: WorkspaceInventoryEntry,
  options: RenderListOptions,
): TerminalLineInput {
  return [
    "    ",
    ...formatColumns(
      [
        terminalSpan(entry.changeName, { role: "primary" }),
        terminalSpan(entry.repoSummary, { role: "dim" }),
        statusLabelSpan(stateTone(entry.state), entry.state),
        terminalSpan(formatRelativeTime(entry.modifiedAtMs, options.now), {
          role: "accent",
        }),
      ],
      options.paths === true,
      entry.path,
    ),
  ];
}

function formatRepositoryRow(
  entry: WorktreeInventoryEntry,
  options: RenderListOptions,
): TerminalLineInput {
  return [
    "    ",
    ...formatColumns(
      [
        terminalSpan(entry.changeName, { role: "primary" }),
        terminalSpan(entry.repository, { role: "dim" }),
        statusLabelSpan(stateTone(entry.state), entry.state),
        terminalSpan(formatRelativeTime(entry.modifiedAtMs, options.now), {
          role: "accent",
        }),
      ],
      options.paths === true,
      entry.path,
    ),
  ];
}

/** An entry is `ready` when its worktrees exist; otherwise its files are gone. */
function stateTone(state: EntryState): StatusTone {
  return state === "ready" ? "success" : "cancelled";
}

function formatColumns(
  values: readonly TerminalSpan[],
  showPath: boolean,
  entryPath?: string,
): TerminalLineInput {
  const widths = [24, 18, 8];
  const columns = values.map((value, index) => {
    const width = widths[index];
    return width ? { ...value, text: padRight(value.text, width) } : value;
  });
  return showPath && entryPath
    ? intersperseSpans([
        ...columns,
        terminalSpan(compactHome(entryPath), { role: "muted" }),
      ])
    : intersperseSpans(columns);
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

function groupNameFromMetadata(metadata: WorkspaceMetadata): string {
  const templateId = metadata.workspace.template_id;
  if (!templateId) return ADHOC_WORKSPACE_GROUP;
  return formatTemplateIdentifier({
    parent: templateId,
    variant: metadata.workspace.template_variant,
  });
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

function safeWorkspaceGroupName(value: string): string | null {
  if (value === ADHOC_WORKSPACE_GROUP) {
    return value;
  }

  try {
    return validateTemplateIdentifier(value);
  } catch {
    return null;
  }
}

function trimTrailingBlank(lines: TerminalLineInput[]): void {
  while (lines.at(-1) === "") {
    lines.pop();
  }
}

function statusLabelSpan(tone: StatusTone, label: string): TerminalSpan {
  return terminalSpan(`${statusGlyphText(tone)} ${label}`, {
    role: statusRole(tone),
  });
}

function statusGlyphText(tone: StatusTone): string {
  switch (tone) {
    case "success":
      return terminalSymbol.statusComplete;
    case "error":
      return terminalSymbol.statusFailed;
    case "warning":
      return terminalSymbol.warning;
    case "pending":
      return terminalSymbol.statusPending;
    case "cancelled":
      return terminalSymbol.statusCancelled;
    case "info":
      return terminalSymbol.info;
  }
}

function statusRole(tone: StatusTone): NonNullable<TerminalSpan["role"]> {
  switch (tone) {
    case "success":
      return "success";
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "pending":
    case "cancelled":
      return "muted";
    case "info":
      return "accent";
  }
}

function intersperseSpans(spans: readonly TerminalSpan[]): TerminalLineInput {
  return spans.flatMap((span, index) => (index === 0 ? [span] : ["  ", span]));
}

function normalizeLine(line: TerminalLineInput): TerminalDoc["lines"][number] {
  if (typeof line === "string") {
    return { spans: [terminalSpan(line)] };
  }
  return {
    spans: line.map((span) =>
      typeof span === "string" ? terminalSpan(span) : span,
    ),
  };
}
