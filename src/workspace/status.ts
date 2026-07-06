import path from "node:path";
import { pathExists } from "@wf-plugin/core";
import { createDefaultBranchResolver, runGit } from "../services/git.ts";
import {
  getWorkspaceAgentsMdStatus,
  type TemplateAgentsMdState,
} from "../templates/agents-md.ts";
import { formatTemplateIdentifier, loadTemplate } from "../templates/index.ts";
import { compactHomePath } from "../terminal/paths.ts";
import {
  literalSpan,
  renderTerminalDocInline,
  type TerminalLine,
  type TerminalSpan,
  type TerminalSpanInput,
  type TerminalStyleRole,
  terminalSpan,
} from "../terminal/render-model.ts";
import { truncate, visibleWidth } from "../terminal/text.ts";
import { terminalSymbol } from "../terminal/theme.ts";
import type { WorkspaceRepoMetadata } from "../types.ts";
import {
  finalizeWorkspaceInitialization,
  getRepoInitializationLogPath,
  type RepoInitializationState,
  readRepoInitializationStates,
  readWorkspaceInitializationState,
  type WorkspaceInitializationState,
  workspaceInitializationScope,
  worktreeInitializationScope,
} from "./initialization.ts";
import type { InitializationScope } from "./initialization-scope.ts";
import type { InventoryEntry } from "./inventory.ts";
import { readWorkspaceMetadata } from "./metadata.ts";
import { listRepositoryTasks, listTasks, type TaskListEntry } from "./tasks.ts";

export type Status = Readonly<{
  selector: string;
  type: InventoryEntry["type"];
  typeLabel: string;
  groupName: string;
  changeName: string;
  path: string;
  modifiedAt: string;
  modifiedAtMs: number;
  summary: StatusSummary;
  repositories: readonly RepositoryStatus[];
  tasks: readonly TaskStatus[];
  initialization: InitializationStatus | null;
  guidance?: GuidanceStatus;
  nextSteps: readonly string[];
}>;

/**
 * AGENTS.md guidance state plus the manifest expiry, so the report can render
 * how long an `expired` guidance file has been stale ("out of date by 3h").
 */
export type GuidanceStatus = Readonly<{
  state: TemplateAgentsMdState;
  expiresAt: string | null;
}>;

export type StatusSummary = Readonly<{
  change: string;
  type: string;
  path: string;
  updated: string;
  group?: string;
  template?: string;
  repository?: string;
  repos?: number;
  branch?: string;
}>;

export type RepositoryStatus = Readonly<{
  name: string;
  path: string;
  branch: string | null;
  defaultBranch: string | null;
  state: "clean" | "dirty" | "stale";
  dirty: DirtySummary;
  base: string | null;
  ahead: number | null;
  behind: number | null;
  integrated: boolean | null;
  setup: RepoSetupSummary;
  line: string;
  details: readonly StatusDetail[];
}>;

export type DirtySummary = Readonly<{
  total: number;
  modified: number;
  added: number;
  deleted: number;
  renamed: number;
  untracked: number;
  other: number;
}>;

export type RepoSetupSummary = Readonly<{
  status:
    | "pending"
    | "git"
    | "queued"
    | "running"
    | "ready"
    | "failed"
    | "cancelled"
    | "unknown";
  /** The step in flight or at fault, e.g. "initializer:pnpm install". */
  step?: string;
  /** The last progress message the initializer recorded. */
  message?: string;
  error?: string;
  logPath?: string;
}>;

export type TaskStatus = Readonly<{
  selector: string;
  parentRepo: string;
  slug: string;
  branch: string;
  path: string;
  state: "ready" | "failed" | "skipped" | "stale";
  merged: boolean | null;
  line: string;
  details: readonly StatusDetail[];
}>;

export type InitializationStatus = Readonly<{
  workspace: WorkspaceInitializationState | null;
  repos: readonly RepoInitializationState[];
  failedRepos: readonly string[];
  runningRepos: readonly string[];
  cancelledRepos: readonly string[];
}>;

export type StatusDetail = Readonly<{
  label: string;
  value: string;
}>;

export type RenderStatusOptions = Readonly<{
  note?: string;
}>;

type RepositoryTarget = Readonly<{
  name: string;
  path: string;
  defaultBranch: string | null;
  setup?: RepoInitializationState;
  setupLogPath?: string;
}>;

export async function buildStatus(entry: InventoryEntry): Promise<Status> {
  const initialization = await readInitializationStatus(entry);
  const repositories = await buildRepositoryStatuses(
    entry,
    initialization?.repos ?? [],
  );
  const tasks = await buildTaskStatuses(entry);
  const summary = buildSummary(entry, repositories);
  const guidance = await workspaceGuidanceState(entry);

  return {
    selector: entry.selector,
    type: entry.type,
    typeLabel: formatTypeLabel(entry.type),
    groupName: entry.groupName,
    changeName: entry.changeName,
    path: entry.path,
    modifiedAt: entry.modifiedAt,
    modifiedAtMs: entry.modifiedAtMs,
    summary,
    repositories,
    tasks,
    initialization,
    ...(guidance ? { guidance } : {}),
    nextSteps: deriveNextSteps(
      entry.selector,
      repositories,
      tasks,
      initialization,
    ),
  };
}

const REPO_INDENT = "  ";
const TASK_INDENT = "      ";
const TASK_LOG_INDENT = "          ";
const COLUMN_GAP = "  ";
const EMPTY_LINE: TerminalLine = { spans: [literalSpan("")] };

/**
 * A single aligned table cell: its styled spans plus the visible width used to
 * pad it to the column width. Widths are precomputed because a span's color
 * codes must not count toward layout.
 */
type Cell = Readonly<{ spans: readonly TerminalSpan[]; width: number }>;

/**
 * Renders status as a compact report: an identity header, a dim path line,
 * an optional guidance/setup line, then a column-aligned table of repositories
 * with their nested tasks indented beneath each parent. The verbose
 * one-liners and `--json`-only fields (`line`, `details`, `nextSteps`) are left
 * on the model untouched; only this presentation layer changed.
 */
export function renderStatus(
  status: Status,
  options: RenderStatusOptions = {},
): string {
  const lines: TerminalLine[] = [
    headerLine(status),
    { spans: [terminalSpan(compactHomePath(status.path), { role: "dim" })] },
  ];

  const guidance = guidanceLine(status.guidance);
  if (guidance) lines.push(guidance);
  lines.push(...workspaceSetupLines(status.initialization));

  const repos = status.repositories.map((repo) => ({
    repo,
    cells: [
      cell(terminalSpan(repo.name, { emphasis: "bold" })),
      branchCell(repo.branch, repo.defaultBranch),
      syncCell(repo),
    ],
  }));
  const repoWidths = maxWidths(repos.map((entry) => entry.cells));
  const taskWidths = maxWidths(status.tasks.map(taskCells));
  const tasksByRepo = groupTasksByRepo(status.tasks);
  const available = Math.max(24, (process.stdout.columns ?? 80) - 4);

  if (repos.length > 0) lines.push(EMPTY_LINE);
  for (const { repo, cells } of repos) {
    lines.push(
      columnsLine(
        REPO_INDENT,
        repoGlyph(repo),
        cells,
        repoWidths,
        worktreeSpans(repo, available),
      ),
    );
    if (repo.setup.status === "failed" && repo.setup.logPath) {
      lines.push(
        dimLine(`${TASK_INDENT}${compactHomePath(repo.setup.logPath)}`),
      );
    }
    for (const task of tasksByRepo.get(repo.name) ?? []) {
      pushTaskLines(lines, task, taskWidths);
    }
  }
  for (const task of orphanTasks(status.tasks, status.repositories)) {
    pushTaskLines(lines, task, taskWidths);
  }

  if (options.note) {
    lines.push(EMPTY_LINE, {
      spans: [terminalSpan(options.note, { role: "muted" })],
    });
  }

  // Frame the report with a blank line above and below so it stands clear
  // of the shell prompt and any preceding command output.
  return `\n\n${renderTerminalDocInline({ lines })}\n\n\n`;
}

function headerLine(status: Status): TerminalLine {
  const identity =
    status.type === "worktree" ? status.selector : status.changeName;
  return {
    spans: [
      terminalSpan(identity, { role: "primary", emphasis: "bold" }),
      literalSpan("   "),
      terminalSpan(headerMeta(status).join(" · "), { role: "muted" }),
    ],
  };
}

function headerMeta(status: Status): string[] {
  const age = formatRelativeAge(status.modifiedAtMs);
  const count = status.repositories.length;
  const repos = `${count} ${count === 1 ? "repo" : "repos"}`;
  switch (status.type) {
    case "worktree":
      return ["worktree", age];
    case "template-workspace":
      return [status.groupName, repos, age];
    case "adhoc-workspace":
      return ["adhoc", repos, age];
  }
}

/** Guidance is shown only when it is not current; `fresh`/`disabled` are silent. */
function guidanceLine(guidance: Status["guidance"]): TerminalLine | null {
  if (!guidance) return null;
  const reason = guidanceReason(guidance);
  return reason
    ? { spans: [terminalSpan(`!  AGENTS.md ${reason}`, { role: "warning" })] }
    : null;
}

function guidanceReason(guidance: GuidanceStatus): string | null {
  switch (guidance.state) {
    case "fresh":
    case "disabled":
      return null;
    case "expired":
      return guidance.expiresAt
        ? `out of date by ${formatDuration(Date.now() - Date.parse(guidance.expiresAt))}`
        : "out of date";
    case "missing":
      return "missing";
    case "modified":
      return "modified";
    case "scope-changed":
      return "scope changed";
    case "conflict":
      return "conflict";
  }
}

/**
 * A single workspace-level setup line for in-flight or failed orchestration.
 * Per-repo phases fold into their own rows; this covers workspace-scoped work
 * (hooks run after repos are ready) and any orchestration warnings.
 */
function workspaceSetupLines(
  initialization: InitializationStatus | null,
): TerminalLine[] {
  const workspace = initialization?.workspace;
  if (!workspace || workspace.status === "ready") return [];

  const lines: TerminalLine[] = [];
  switch (workspace.status) {
    case "creating":
      lines.push(
        setupLine(terminalSymbol.statusRunning, "accent", "creating…"),
      );
      break;
    case "initializing":
      lines.push(
        setupLine(terminalSymbol.statusRunning, "accent", "setting up…"),
      );
      break;
    case "hooks":
      lines.push(
        setupLine(
          terminalSymbol.statusRunning,
          "accent",
          workspace.current_hook
            ? `hook: ${workspace.current_hook}`
            : "running hooks…",
        ),
      );
      break;
    case "failed": {
      const message = firstLine(workspace.error);
      lines.push(
        setupLine(
          terminalSymbol.statusFailed,
          "error",
          message ? `setup failed: ${message}` : "setup failed",
        ),
      );
      break;
    }
    case "cancelled":
      lines.push(
        setupLine(terminalSymbol.statusCancelled, "muted", "cancelled"),
      );
      break;
  }
  for (const warning of workspace.warnings ?? []) {
    lines.push({ spans: [terminalSpan(`!  ${warning}`, { role: "warning" })] });
  }
  return lines;
}

function setupLine(
  symbol: string,
  role: TerminalStyleRole,
  text: string,
): TerminalLine {
  return {
    spans: [terminalSpan(`${symbol} `, { role }), terminalSpan(text, { role })],
  };
}

/** The leading health glyph: setup state takes priority over working-tree state. */
function repoGlyph(repo: RepositoryStatus): TerminalSpan {
  switch (repo.setup.status) {
    case "failed":
      return glyphSpan(terminalSymbol.statusFailed, "error");
    case "cancelled":
      return glyphSpan(terminalSymbol.statusCancelled, "muted");
    case "running":
      return glyphSpan(terminalSymbol.statusRunning, "accent");
    case "pending":
    case "git":
    case "queued":
      return glyphSpan(terminalSymbol.statusPending, "muted");
    default:
      if (repo.state === "stale")
        return glyphSpan(terminalSymbol.statusCancelled, "muted");
      if (repo.state === "dirty")
        return glyphSpan(terminalSymbol.radioOn, "warning");
      return glyphSpan(terminalSymbol.statusComplete, "success");
  }
}

/** The trailing (last, unpadded) column: phase-aware setup label or worktree state. */
function worktreeSpans(
  repo: RepositoryStatus,
  available: number,
): TerminalSpan[] {
  switch (repo.setup.status) {
    case "failed": {
      const message = firstLine(repo.setup.error);
      const text = message ? `setup failed: ${message}` : "setup failed";
      return [terminalSpan(truncate(text, available), { role: "error" })];
    }
    case "pending":
    case "queued":
      return [terminalSpan("queued", { role: "muted" })];
    case "git": {
      const step = gitStepLabel(repo.setup.step);
      return [terminalSpan(truncate(`${step}…`, available), { role: "muted" })];
    }
    case "running": {
      const step = initializerStepLabel(repo.setup.step);
      const text = step ? `installing: ${step}…` : "installing…";
      return [terminalSpan(truncate(text, available), { role: "accent" })];
    }
    case "cancelled":
      return [terminalSpan("cancelled", { role: "muted" })];
    default:
      if (repo.state === "stale")
        return [terminalSpan("missing", { role: "muted" })];
      if (repo.state === "clean")
        return [terminalSpan("clean", { role: "muted" })];
      return [
        terminalSpan(formatDirtyDisplay(repo.dirty), { role: "warning" }),
      ];
  }
}

function branchCell(branch: string | null, defaultBranch: string | null): Cell {
  if (!branch) return cell(terminalSpan("—", { role: "muted" }));
  const isFeature = defaultBranch !== null && branch !== defaultBranch;
  return cell(terminalSpan(branch, { role: isFeature ? "accent" : "dim" }));
}

function syncCell(repo: RepositoryStatus): Cell {
  if (repo.base === null || repo.ahead === null || repo.behind === null) {
    return cell(terminalSpan("—", { role: "muted" }));
  }
  if (repo.ahead === 0 && repo.behind === 0) {
    return cell(terminalSpan("synced", { role: "muted" }));
  }
  const parts: TerminalSpanInput[] = [];
  if (repo.ahead > 0)
    parts.push(terminalSpan(`↑${repo.ahead}`, { role: "success" }));
  if (repo.behind > 0) {
    if (parts.length > 0) parts.push(literalSpan(" "));
    parts.push(terminalSpan(`↓${repo.behind}`, { role: "warning" }));
  }
  return cell(...parts);
}

function pushTaskLines(
  lines: TerminalLine[],
  task: TaskStatus,
  widths: readonly number[],
): void {
  lines.push(
    columnsLine(
      TASK_INDENT,
      taskGlyph(task),
      taskCells(task),
      widths,
      taskSetupSpans(task),
    ),
  );
  if (task.state === "failed") {
    const log = task.details.find((detail) => detail.label === "Log");
    if (log) {
      lines.push(dimLine(`${TASK_LOG_INDENT}${compactHomePath(log.value)}`));
    }
  }
}

function taskCells(task: TaskStatus): readonly Cell[] {
  return [
    cell(terminalSpan(task.slug, { emphasis: "bold" })),
    branchCell(task.branch, null),
    mergedCell(task.merged),
  ];
}

function taskGlyph(task: TaskStatus): TerminalSpan {
  if (task.state === "failed")
    return glyphSpan(terminalSymbol.statusFailed, "error");
  if (task.state === "skipped")
    return glyphSpan(terminalSymbol.statusComplete, "muted");
  if (task.state === "stale")
    return glyphSpan(terminalSymbol.statusCancelled, "muted");
  if (task.merged === true)
    return glyphSpan(terminalSymbol.statusComplete, "success");
  if (task.merged === false)
    return glyphSpan(terminalSymbol.radioOn, "warning");
  return glyphSpan(terminalSymbol.statusPending, "muted");
}

function taskSetupSpans(task: TaskStatus): TerminalSpan[] {
  switch (task.state) {
    case "failed":
      return [terminalSpan("setup failed", { role: "error" })];
    case "skipped":
      return [terminalSpan("setup skipped", { role: "muted" })];
    case "stale":
      return [terminalSpan("stale", { role: "muted" })];
    default:
      return [terminalSpan("ready", { role: "muted" })];
  }
}

function mergedCell(merged: boolean | null): Cell {
  if (merged === true) return cell(terminalSpan("merged", { role: "muted" }));
  if (merged === false)
    return cell(terminalSpan("unmerged", { role: "warning" }));
  return cell(terminalSpan("merge?", { role: "muted" }));
}

function groupTasksByRepo(
  tasks: readonly TaskStatus[],
): Map<string, TaskStatus[]> {
  const map = new Map<string, TaskStatus[]>();
  for (const task of tasks) {
    const list = map.get(task.parentRepo) ?? [];
    list.push(task);
    map.set(task.parentRepo, list);
  }
  return map;
}

function orphanTasks(
  tasks: readonly TaskStatus[],
  repositories: readonly RepositoryStatus[],
): TaskStatus[] {
  const names = new Set(repositories.map((repo) => repo.name));
  return tasks.filter((task) => !names.has(task.parentRepo));
}

/** Builds an aligned row: indent, glyph, padded cells, then the unpadded tail. */
function columnsLine(
  indent: string,
  glyph: TerminalSpan,
  cells: readonly Cell[],
  widths: readonly number[],
  trailing: readonly TerminalSpan[],
): TerminalLine {
  const spans: TerminalSpan[] = [literalSpan(indent), glyph, literalSpan(" ")];
  cells.forEach((current, index) => {
    spans.push(...current.spans);
    const pad = (widths[index] ?? current.width) - current.width;
    if (pad > 0) spans.push(literalSpan(" ".repeat(pad)));
    spans.push(literalSpan(COLUMN_GAP));
  });
  spans.push(...trailing);
  return { spans };
}

function maxWidths(rows: readonly (readonly Cell[])[]): number[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((current, index) => {
      widths[index] = Math.max(widths[index] ?? 0, current.width);
    });
  }
  return widths;
}

function cell(...inputs: TerminalSpanInput[]): Cell {
  const spans = inputs.map((input) =>
    typeof input === "string" ? literalSpan(input) : input,
  );
  const width = spans.reduce((sum, span) => sum + visibleWidth(span.text), 0);
  return { spans, width };
}

function glyphSpan(symbol: string, role: TerminalStyleRole): TerminalSpan {
  return terminalSpan(symbol, { role });
}

function dimLine(text: string): TerminalLine {
  return { spans: [terminalSpan(text, { role: "dim" })] };
}

function firstLine(value: string | undefined): string {
  return value?.split("\n")[0]?.trim() ?? "";
}

/** Words with bullet separators: "3 modified · 2 untracked"; "clean" handled by caller. */
function formatDirtyDisplay(summary: DirtySummary): string {
  const parts = [
    countLabel(summary.modified, "modified"),
    countLabel(summary.added, "added"),
    countLabel(summary.deleted, "deleted"),
    countLabel(summary.renamed, "renamed"),
    countLabel(summary.untracked, "untracked"),
    countLabel(summary.other, "changed"),
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : `${summary.total} changed`;
}

async function workspaceGuidanceState(
  entry: InventoryEntry,
): Promise<GuidanceStatus | undefined> {
  if (entry.type === "worktree") return undefined;
  const metadata = await readWorkspaceMetadata(entry.path).catch(() => null);
  const templateId = metadata?.workspace.template_id;
  if (!templateId) return undefined;
  const template = await loadTemplate(
    formatTemplateIdentifier({
      parent: templateId,
      variant: metadata.workspace.template_variant,
    }),
  );
  if (!template) return { state: "missing", expiresAt: null };
  const status = await getWorkspaceAgentsMdStatus(template, entry.path);
  return { state: status.state, expiresAt: status.manifest?.expiresAt ?? null };
}

async function buildRepositoryStatuses(
  entry: InventoryEntry,
  setupStates: readonly RepoInitializationState[],
): Promise<RepositoryStatus[]> {
  const targets = await getRepositoryTargets(entry, setupStates);
  const statuses = await Promise.all(targets.map(buildRepositoryStatus));
  return statuses.sort((left, right) => left.name.localeCompare(right.name));
}

async function getRepositoryTargets(
  entry: InventoryEntry,
  setupStates: readonly RepoInitializationState[],
): Promise<RepositoryTarget[]> {
  const setupByRepo = new Map(setupStates.map((state) => [state.repo, state]));
  if (entry.type === "worktree") {
    const setup = setupByRepo.get(entry.repository);
    const setupLogPath =
      setup?.status === "failed"
        ? await getRepoInitializationLogPath(
            initializationScope(entry),
            entry.repository,
          ).catch(() => undefined)
        : undefined;
    return [
      {
        name: entry.repository,
        path: entry.path,
        defaultBranch: await inferDefaultBranch(entry.path),
        ...(setup ? { setup } : {}),
        ...(setupLogPath ? { setupLogPath } : {}),
      },
    ];
  }

  const metadata = await readWorkspaceMetadata(entry.path).catch(() => null);
  const repos =
    metadata?.repos ??
    entry.repos.map(
      (repo): WorkspaceRepoMetadata => ({
        name: repo,
        remote: "",
        has_lockfile: false,
      }),
    );

  return Promise.all(
    repos.map(async (repo) => {
      const setup = setupByRepo.get(repo.name);
      const setupLogPath =
        setup?.status === "failed"
          ? await getRepoInitializationLogPath(
              initializationScope(entry),
              repo.name,
            ).catch(() => undefined)
          : undefined;
      return {
        name: repo.name,
        path: path.join(entry.path, repo.name),
        defaultBranch: await inferDefaultBranch(
          path.join(entry.path, repo.name),
        ),
        ...(setup ? { setup } : {}),
        ...(setupLogPath ? { setupLogPath } : {}),
      };
    }),
  );
}

async function buildRepositoryStatus(
  target: RepositoryTarget,
): Promise<RepositoryStatus> {
  if (!(await pathExists(target.path))) {
    const setup = summarizeSetup(target.setup, target.setupLogPath);
    return {
      name: target.name,
      path: target.path,
      branch: null,
      defaultBranch: target.defaultBranch ?? null,
      state: "stale",
      dirty: emptyDirtySummary(),
      base: null,
      ahead: null,
      behind: null,
      integrated: null,
      setup,
      line: `${target.name} - stale; ${formatSetup(setup)}`,
      details: setupDetails(setup),
    };
  }

  const dirty = await readDirtySummary(target.path);
  const branch = await optionalGitLine(
    ["branch", "--show-current"],
    target.path,
  );
  const base = target.defaultBranch ? `origin/${target.defaultBranch}` : null;
  const counts = base ? await readAheadBehind(target.path, base) : null;
  const integrated = base
    ? await isIntegrated(target.path, base, branch, target.defaultBranch)
    : null;
  const setup = summarizeSetup(target.setup, target.setupLogPath);
  const line = formatRepositoryLine({
    name: target.name,
    state: dirty.total > 0 ? "dirty" : "clean",
    dirty,
    base,
    ahead: counts?.ahead ?? null,
    behind: counts?.behind ?? null,
    integrated,
    setup,
  });

  return {
    name: target.name,
    path: target.path,
    branch: branch || null,
    defaultBranch: target.defaultBranch ?? null,
    state: dirty.total > 0 ? "dirty" : "clean",
    dirty,
    base,
    ahead: counts?.ahead ?? null,
    behind: counts?.behind ?? null,
    integrated,
    setup,
    line,
    details: setupDetails(setup),
  };
}

async function readDirtySummary(repoPath: string): Promise<DirtySummary> {
  try {
    const { stdout } = await runGit(["status", "--porcelain"], {
      cwd: repoPath,
    });
    return parseDirtySummary(stdout);
  } catch {
    return emptyDirtySummary();
  }
}

function parseDirtySummary(stdout: string): DirtySummary {
  const summary = mutableDirtySummary();
  for (const line of stdout.split("\n").filter(Boolean)) {
    summary.total += 1;
    const code = line.slice(0, 2);
    if (code === "??") {
      summary.untracked += 1;
    } else if (code.includes("R")) {
      summary.renamed += 1;
    } else if (code.includes("D")) {
      summary.deleted += 1;
    } else if (code.includes("A")) {
      summary.added += 1;
    } else if (code.includes("M")) {
      summary.modified += 1;
    } else {
      summary.other += 1;
    }
  }
  return summary;
}

async function optionalGitLine(
  args: readonly string[],
  cwd: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGit([...args], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function inferDefaultBranch(cwd: string): Promise<string | null> {
  try {
    return await createDefaultBranchResolver().resolveWorktreeDefaultBranch(
      cwd,
    );
  } catch {
    return null;
  }
}

async function readAheadBehind(
  cwd: string,
  base: string,
): Promise<{ ahead: number; behind: number } | null> {
  const line = await optionalGitLine(
    ["rev-list", "--left-right", "--count", `${base}...HEAD`],
    cwd,
  );
  if (!line) return null;
  const [behindText, aheadText] = line.split(/\s+/);
  const behind = Number(behindText);
  const ahead = Number(aheadText);
  return Number.isFinite(ahead) && Number.isFinite(behind)
    ? { ahead, behind }
    : null;
}

async function isIntegrated(
  cwd: string,
  base: string,
  branch: string | null,
  defaultBranch: string | null,
): Promise<boolean | null> {
  if (branch && defaultBranch && branch === defaultBranch) {
    return true;
  }
  try {
    await runGit(["merge-base", "--is-ancestor", "HEAD", base], { cwd });
    return true;
  } catch {
    return false;
  }
}

function summarizeSetup(
  state: RepoInitializationState | undefined,
  setupLogPath: string | undefined,
): RepoSetupSummary {
  if (!state) {
    return { status: "ready" };
  }

  return {
    status: state.status,
    ...(state.step ? { step: state.step } : {}),
    ...(state.message ? { message: state.message } : {}),
    ...(state.error ? { error: state.error } : {}),
    ...(setupLogPath ? { logPath: setupLogPath } : {}),
  };
}

function formatRepositoryLine({
  name,
  state,
  dirty,
  base,
  ahead,
  behind,
  integrated,
  setup,
}: {
  name: string;
  state: "clean" | "dirty";
  dirty: DirtySummary;
  base: string | null;
  ahead: number | null;
  behind: number | null;
  integrated: boolean | null;
  setup: RepoSetupSummary;
}): string {
  return `${name} - ${[
    state === "dirty" ? `dirty: ${formatDirtySummary(dirty)}` : "clean",
    formatBaseSummary(base, ahead, behind),
    formatIntegration(integrated),
    formatSetup(setup),
  ]
    .filter(Boolean)
    .join("; ")}`;
}

function formatDirtySummary(summary: DirtySummary): string {
  const parts = [
    countLabel(summary.modified, "modified"),
    countLabel(summary.added, "added"),
    countLabel(summary.deleted, "deleted"),
    countLabel(summary.renamed, "renamed"),
    countLabel(summary.untracked, "untracked"),
    countLabel(summary.other, "changed"),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : `${summary.total} changed`;
}

function formatBaseSummary(
  base: string | null,
  ahead: number | null,
  behind: number | null,
): string | null {
  if (!base || ahead === null || behind === null) return null;
  if (ahead === 0 && behind === 0) return `${base} synced`;
  const parts = [
    ahead > 0 ? `+${ahead}` : "",
    behind > 0 ? `-${behind}` : "",
  ].filter(Boolean);
  return `${base} ${parts.join("/")}`;
}

function formatIntegration(value: boolean | null): string | null {
  if (value === null) return null;
  return value ? "integrated" : "not integrated";
}

function formatSetup(setup: RepoSetupSummary): string {
  return `setup ${setup.status}`;
}

function gitStepLabel(step: string | undefined): string {
  switch (step) {
    case "cleanup":
      return "cleaning up";
    case "worktree":
      return "checking out";
    default:
      return "cloning";
  }
}

function initializerStepLabel(step: string | undefined): string | null {
  if (!step?.startsWith("initializer:")) return null;
  const name = step.slice("initializer:".length);
  if (!name || name === "queued" || name === "detection") return null;
  return name;
}

/**
 * Block until a worktree or workspace's initialization reaches a terminal
 * state, emitting one line per repo status transition. Safe without a TTY;
 * this is the scripting primitive behind `wf status --wait`.
 */
export async function waitForInitialization(
  scope: InitializationScope,
  {
    timeoutMs,
    pollIntervalMs = 500,
    onLine,
  }: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    onLine?: (line: string) => void;
  } = {},
): Promise<"ready" | "failed" | "cancelled" | "timeout"> {
  const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : null;
  const lastByRepo = new Map<string, string>();

  while (true) {
    await finalizeWorkspaceInitialization(scope).catch(() => undefined);
    const [workspace, repos] = await Promise.all([
      readWorkspaceInitializationState(scope),
      readRepoInitializationStates(scope),
    ]);

    for (const repo of repos) {
      const detail =
        repo.status === "running" && repo.step
          ? `${repo.status} (${repo.step})`
          : repo.status;
      const line = `${repo.repo}: ${detail}`;
      if (lastByRepo.get(repo.repo) !== line) {
        lastByRepo.set(repo.repo, line);
        onLine?.(line);
      }
    }

    if (
      workspace?.status === "ready" ||
      workspace?.status === "failed" ||
      workspace?.status === "cancelled"
    ) {
      return workspace.status;
    }

    if (deadline !== null && Date.now() >= deadline) {
      return "timeout";
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

function setupDetails(setup: RepoSetupSummary): StatusDetail[] {
  return [
    ...(setup.error ? [{ label: "Error", value: setup.error }] : []),
    ...(setup.logPath
      ? [{ label: "Log", value: path.resolve(setup.logPath) }]
      : []),
  ];
}

async function readInitializationStatus(
  entry: InventoryEntry,
): Promise<InitializationStatus | null> {
  const scope = initializationScope(entry);
  await finalizeWorkspaceInitialization(scope).catch(() => undefined);
  const [workspace, repos] = await Promise.all([
    readWorkspaceInitializationState(scope),
    readRepoInitializationStates(scope),
  ]);

  if (!workspace && repos.length === 0) {
    return null;
  }

  return {
    workspace,
    repos,
    failedRepos: repos
      .filter((state) => state.status === "failed")
      .map((state) => state.repo)
      .sort(),
    runningRepos: repos
      .filter((state) =>
        ["pending", "git", "queued", "running"].includes(state.status),
      )
      .map((state) => state.repo)
      .sort(),
    cancelledRepos: repos
      .filter((state) => state.status === "cancelled")
      .map((state) => state.repo)
      .sort(),
  };
}

async function buildTaskStatuses(entry: InventoryEntry): Promise<TaskStatus[]> {
  if (entry.type === "worktree") {
    const tasks = await listRepositoryTasks({
      parentRepoDir: entry.path,
      repoName: entry.repository,
      changeName: entry.changeName,
    }).catch(() => []);
    return tasks
      .map((task) => formatTaskStatus(task, path.dirname(entry.path)))
      .sort((left, right) => left.selector.localeCompare(right.selector));
  }

  const metadata = await readWorkspaceMetadata(entry.path).catch(() => null);
  if (!metadata) {
    return [];
  }

  const tasks = await listTasks(entry.path).catch(() => []);
  return tasks
    .map((task) => formatTaskStatus(task, entry.path))
    .sort((left, right) => left.selector.localeCompare(right.selector));
}

function formatTaskStatus(
  task: TaskListEntry,
  workspaceDir: string,
): TaskStatus {
  const selector = `${task.parent_repo}/${task.slug}`;
  const mergeState =
    task.merged === true
      ? "merged"
      : task.merged === false
        ? "unmerged"
        : "merge unknown";
  const line = `${selector} - ${[
    mergeState,
    task.branch,
    `setup ${task.state}`,
  ].join("; ")}`;

  return {
    selector,
    parentRepo: task.parent_repo,
    slug: task.slug,
    branch: task.branch,
    path: task.absolutePath,
    state: task.state,
    merged: task.merged,
    line,
    details: task.setup_log
      ? [
          {
            label: "Log",
            value: path.resolve(workspaceDir, task.setup_log),
          },
        ]
      : [],
  };
}

function buildSummary(
  entry: InventoryEntry,
  repositories: readonly RepositoryStatus[],
): StatusSummary {
  const sharedBranch = uniqueValue(
    repositories.map((repo) => repo.branch).filter((branch) => branch !== null),
  );

  return {
    change: entry.selector,
    type: formatTypeLabel(entry.type),
    ...(entry.type === "worktree" ? { repository: entry.repository } : {}),
    ...(entry.type === "template-workspace"
      ? { template: entry.groupName }
      : {}),
    ...(entry.type === "adhoc-workspace" ? { group: entry.groupName } : {}),
    ...(entry.type !== "worktree" ? { repos: entry.repos.length } : {}),
    ...(sharedBranch ? { branch: sharedBranch } : {}),
    path: entry.path,
    updated: formatRelativeAge(entry.modifiedAtMs),
  };
}

export function initializationScope(
  entry: InventoryEntry,
): InitializationScope {
  return entry.type === "worktree"
    ? worktreeInitializationScope({
        repoRootDir: path.dirname(entry.path),
        changeName: entry.changeName,
      })
    : workspaceInitializationScope(entry.path);
}

function deriveNextSteps(
  selector: string,
  repositories: readonly RepositoryStatus[],
  tasks: readonly TaskStatus[],
  initialization: InitializationStatus | null,
): string[] {
  const steps: string[] = [];
  if (
    initialization &&
    (initialization.failedRepos.length > 0 ||
      initialization.runningRepos.length > 0 ||
      initialization.workspace?.status === "failed" ||
      initialization.workspace?.status === "hooks" ||
      initialization.workspace?.status === "initializing" ||
      initialization.workspace?.status === "creating")
  ) {
    steps.push("Inspect initialization details above.");
  }
  if (repositories.some((repo) => repo.state === "dirty")) {
    steps.push("Commit or stash worktree changes before deleting.");
    steps.push("Run: git status");
  }
  if (
    tasks.some(
      (task) =>
        task.merged === false ||
        task.state === "failed" ||
        task.state === "stale",
    )
  ) {
    steps.push("Integrate or delete nested tasks before deleting.");
  }
  if (
    steps.length === 0 &&
    repositories.some((repo) => repo.integrated === false)
  ) {
    steps.push("Open or merge the branch before deleting it.");
  }
  if (
    steps.length === 0 &&
    repositories.every((repo) => repo.integrated === true)
  ) {
    steps.push(`Run: wf delete ${selector}`);
  }
  if (steps.length === 0) {
    steps.push("No immediate blockers.");
  }
  return steps;
}

function formatTypeLabel(type: InventoryEntry["type"]): string {
  switch (type) {
    case "worktree":
      return "worktree";
    case "template-workspace":
      return "template workspace";
    case "adhoc-workspace":
      return "adhoc workspace";
  }
}

function formatRelativeAge(modifiedAtMs: number, now = Date.now()): string {
  return `${formatDuration(now - modifiedAtMs)} ago`;
}

/** A coarse, suffix-free duration ("0m", "5m", "3h", "2d") for header age and guidance drift. */
function formatDuration(deltaMs: number): string {
  const seconds = Math.max(0, Math.floor(deltaMs / 1000));
  if (seconds < 60) return "0m";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function countLabel(count: number, label: string): string | null {
  return count > 0 ? `${count} ${label}` : null;
}

function uniqueValue(values: readonly string[]): string | null {
  const unique = [...new Set(values)];
  return unique.length === 1 ? (unique[0] ?? null) : null;
}

function emptyDirtySummary(): DirtySummary {
  return {
    total: 0,
    modified: 0,
    added: 0,
    deleted: 0,
    renamed: 0,
    untracked: 0,
    other: 0,
  };
}

function mutableDirtySummary(): {
  total: number;
  modified: number;
  added: number;
  deleted: number;
  renamed: number;
  untracked: number;
  other: number;
} {
  return { ...emptyDirtySummary() };
}
