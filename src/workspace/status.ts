import os from "node:os";
import path from "node:path";
import { pathExists } from "@wf-plugin/core";
import { runGit } from "../services/git.ts";
import {
  getWorkspaceAgentsMdStatus,
  type TemplateAgentsMdState,
} from "../templates/agents-md.ts";
import { formatTemplateIdentifier, loadTemplate } from "../templates/index.ts";
import {
  type ReportField,
  type ReportSection,
  renderReport,
} from "../terminal/report.ts";
import type { StatusTone } from "../terminal/status-indicator.ts";
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
  guidance?: TemplateAgentsMdState;
  nextSteps: readonly string[];
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
  error?: string;
  logPath?: string;
}>;

export type TaskStatus = Readonly<{
  selector: string;
  parentRepo: string;
  slug: string;
  branch: string;
  path: string;
  state: "ready" | "failed" | "stale";
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
  defaultBranch?: string;
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

export function renderStatus(
  status: Status,
  options: RenderStatusOptions = {},
): string {
  const sections: ReportSection[] = [
    { title: "Summary", fields: compactPaths(summaryFields(status.summary)) },
    {
      title: status.type === "worktree" ? "Repository" : "Repositories",
      entries: status.repositories.map((repo) => ({
        title: repo.name,
        tone: repositoryTone(repo.state),
        description: statusTail(repo.line, repo.name),
        details: compactPaths(repo.details),
      })),
    },
    status.tasks.length === 0
      ? { title: "Tasks", note: "No nested tasks." }
      : {
          title: "Tasks",
          entries: status.tasks.map((task) => ({
            title: task.selector,
            tone: taskTone(task.state),
            description: statusTail(task.line, task.selector),
            details: compactPaths(task.details),
          })),
        },
  ];

  if (status.initialization) {
    sections.push({
      title: "Initialization",
      fields: compactPaths(
        initializationFields(status.initialization, status.type),
      ),
    });
  }

  if (status.guidance) {
    sections.push({
      title: "Guidance",
      fields: [{ label: "AGENTS.md", value: status.guidance }],
    });
  }

  sections.push({
    title: "Next steps",
    entries: status.nextSteps.map((step) => ({ title: step, tone: "info" })),
  });

  if (options.note) {
    sections.push({ title: "Note", note: options.note });
  }

  return renderReport({ title: "Change status", sections });
}

/** Maps a repository's working-tree state onto a status tone. */
function repositoryTone(state: RepositoryStatus["state"]): StatusTone {
  switch (state) {
    case "clean":
      return "success";
    case "dirty":
      return "warning";
    case "stale":
      return "cancelled";
  }
}

/** Maps a nested task's state onto a status tone. */
function taskTone(state: TaskStatus["state"]): StatusTone {
  switch (state) {
    case "ready":
      return "success";
    case "failed":
      return "error";
    case "stale":
      return "cancelled";
  }
}

/**
 * A repository/task one-liner is `"{name} - {summary}"`. The report renders the
 * name as the entry title and re-adds the " - " separator before the
 * description, so we hand back just the summary tail.
 */
function statusTail(line: string, name: string): string {
  const prefix = `${name} - `;
  return line.startsWith(prefix) ? line.slice(prefix.length) : line;
}

/** Path/Log values are absolute on disk; compact `$HOME` to `~` for display. */
function compactPaths(fields: readonly StatusDetail[]): ReportField[] {
  return fields.map((field) => ({
    label: field.label,
    value:
      field.label === "Path" || field.label === "Log"
        ? compactHome(field.value)
        : field.value,
  }));
}

async function workspaceGuidanceState(
  entry: InventoryEntry,
): Promise<TemplateAgentsMdState | undefined> {
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
  if (!template) return "missing";
  return (await getWorkspaceAgentsMdStatus(template, entry.path)).state;
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
        default_branch: "main",
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
        defaultBranch: repo.default_branch,
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

async function inferDefaultBranch(cwd: string): Promise<string> {
  const symbolic = await optionalGitLine(
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    cwd,
  );
  if (symbolic?.startsWith("origin/")) {
    return symbolic.slice("origin/".length);
  }
  return "main";
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
  defaultBranch: string | undefined,
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

function summaryFields(summary: StatusSummary): StatusDetail[] {
  return [
    { label: "Change", value: summary.change },
    { label: "Type", value: summary.type },
    ...(summary.repository
      ? [{ label: "Repository", value: summary.repository }]
      : []),
    ...(summary.template
      ? [{ label: "Template", value: summary.template }]
      : []),
    ...(summary.group ? [{ label: "Group", value: summary.group }] : []),
    ...(summary.repos !== undefined
      ? [{ label: "Repos", value: String(summary.repos) }]
      : []),
    ...(summary.branch ? [{ label: "Branch", value: summary.branch }] : []),
    { label: "Path", value: summary.path },
    { label: "Updated", value: summary.updated },
  ];
}

function initializationFields(
  initialization: InitializationStatus,
  type: InventoryEntry["type"],
): StatusDetail[] {
  return [
    ...(initialization.workspace
      ? [
          {
            label: type === "worktree" ? "Change" : "Workspace",
            value: initialization.workspace.status,
          },
        ]
      : []),
    ...(initialization.workspace?.error
      ? [{ label: "Error", value: initialization.workspace.error }]
      : []),
    ...(initialization.workspace?.current_hook
      ? [{ label: "Hook", value: initialization.workspace.current_hook }]
      : []),
    ...(initialization.workspace?.warnings?.length
      ? [
          {
            label: "Warnings",
            value: initialization.workspace.warnings.join(", "),
          },
        ]
      : []),
    ...(initialization.failedRepos.length > 0
      ? [{ label: "Failed", value: initialization.failedRepos.join(", ") }]
      : []),
    ...(initialization.runningRepos.length > 0
      ? [{ label: "Running", value: initialization.runningRepos.join(", ") }]
      : []),
    ...(initialization.cancelledRepos.length > 0
      ? [
          {
            label: "Cancelled",
            value: initialization.cancelledRepos.join(", "),
          },
        ]
      : []),
  ];
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
    steps.push("Commit or stash worktree changes before finishing.");
    steps.push("Run: git status");
  }
  if (tasks.some((task) => task.merged === false || task.state !== "ready")) {
    steps.push("Integrate or delete nested tasks before finishing.");
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
  const seconds = Math.max(0, Math.floor((now - modifiedAtMs) / 1000));
  if (seconds < 60) return "0m ago";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function compactHome(value: string): string {
  const home = os.homedir();
  return value === home
    ? "~"
    : value.startsWith(`${home}${path.sep}`)
      ? path.join("~", path.relative(home, value))
      : value;
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
