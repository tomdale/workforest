import { loadWorkspaceConfig } from "../config.ts";
import { runGit } from "../services/git.ts";
import { reportShellCdTarget } from "../shell.ts";
import {
  collectInventory,
  type InventoryEntry,
} from "../workspace/inventory.ts";

/**
 * A single selectable existing change, flattened from the workspace + repository
 * inventory. This is the cheap, render-ready shape the entry surface
 * consumes for Phase 1 (go to an existing worktree or workspace). Expensive per-row details
 * (git dirty state) are intentionally excluded — fetch those lazily with
 * {@link dirtyHintFor} for the highlighted row only.
 */
export type Candidate = {
  selector: string;
  changeName: string;
  kind: "workspace" | "repository";
  /**
   * The parent the change lives under: a repository name for repository
   * changes, or a workspace group (template id or the adhoc group) for
   * workspaces. Used to scope the picker to the current directory.
   */
  groupName: string;
  statusHint: string;
  path: string;
};

/**
 * The Workforest container the user is currently inside, used to default the
 * change picker and the new-change source mode to the relevant subset:
 * - `repo`     — a worktree (matches worktrees / Repo mode)
 * - `template` — a template workspace (matches that group / Template mode)
 * - `adhoc`    — an ad-hoc multi-repo workspace (matches that group / Multi mode)
 */
export type Scope =
  | { kind: "repo"; name: string }
  | { kind: "template"; name: string }
  | { kind: "adhoc"; name: string };

/** Whether a candidate belongs to the given scope. */
export function candidateInScope(candidate: Candidate, scope: Scope): boolean {
  return scope.kind === "repo"
    ? candidate.kind === "repository" && candidate.groupName === scope.name
    : candidate.kind === "workspace" && candidate.groupName === scope.name;
}

/**
 * Load every existing change and flatten it into render-ready candidates,
 * sorted most-recently-modified first. `now` is injectable so relative-time
 * hints are deterministic in tests.
 */
export async function listCandidates(
  now: number = Date.now(),
): Promise<Candidate[]> {
  const { config } = await loadWorkspaceConfig();
  const inventory = await collectInventory(config);

  const entries: InventoryEntry[] = [
    ...inventory.workspaces,
    ...inventory.repositories,
  ];

  return sortEntriesByRecency(entries).map((entry) =>
    candidateFromInventoryEntry(entry, now),
  );
}

export function sortEntriesByRecency<Entry extends { modifiedAtMs: number }>(
  entries: readonly Entry[],
): Entry[] {
  return [...entries].sort(
    (left, right) => right.modifiedAtMs - left.modifiedAtMs,
  );
}

/**
 * Case-insensitive subsequence filter over each candidate's selector and change
 * name. Input order is preserved for matches so callers can rely on the
 * most-recently-modified ordering from {@link listCandidates}.
 */
export function filterCandidates(
  candidates: Candidate[],
  query: string,
): Candidate[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return [...candidates];
  }

  return candidates.filter((candidate) =>
    matchesSubsequence(
      `${candidate.selector} ${candidate.changeName}`,
      trimmed,
    ),
  );
}

/**
 * Hand the change's directory back to the shell wrapper so it can `cd` into it.
 * Prints a manual `cd` fallback when shell auto-cd is not enabled.
 */
export async function cdToEntry(candidate: Candidate): Promise<void> {
  await reportShellCdTarget(candidate.path);
}

/**
 * Lazily compute a cheap dirty-state hint for a single change directory, e.g.
 * "3 dirty". Returns null when the tree is clean or git cannot be queried.
 * Intended for the highlighted row only — running this for every candidate
 * would be expensive.
 */
export async function dirtyHintFor(path: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(["status", "--porcelain"], { cwd: path });
    const count = stdout.split("\n").filter((line) => line.trim()).length;
    return count > 0 ? `${count} dirty` : null;
  } catch {
    return null;
  }
}

export function candidateFromInventoryEntry(
  entry: InventoryEntry,
  now: number = Date.now(),
): Candidate {
  // Mark template-backed changes with the `@` prefix users already type
  // (`wf new <name> @template`) so a template name reads distinctly from the
  // plain repo names shown for single-repo and adhoc changes, and list the
  // template's repos in parens after the name. The full repo list is passed
  // through uncapped; the renderer truncates it to the column with "+ N more".
  const repoInfo =
    entry.type === "worktree"
      ? entry.repository
      : entry.type === "template-workspace"
        ? formatTemplateInfo(entry.groupName, entry.repos)
        : entry.repos.join(", ");
  return {
    selector: entry.selector,
    changeName: entry.changeName,
    kind: entry.type === "worktree" ? "repository" : "workspace",
    groupName: entry.groupName,
    statusHint: buildStatusHint({
      modifiedAtMs: entry.modifiedAtMs,
      now,
      repoInfo,
      state: entry.state,
    }),
    path: entry.path,
  };
}

/** `@template (repo, repo)`, dropping the parens when the repo list is empty. */
function formatTemplateInfo(
  groupName: string,
  repos: readonly string[],
): string {
  return repos.length > 0
    ? `@${groupName} (${repos.join(", ")})`
    : `@${groupName}`;
}

/**
 * The secondary line for a change row: relative last-modified time first, then
 * the repositories involved, and a `stale` marker only when the worktree is
 * missing (the common `ready` state is left implicit to reduce noise).
 */
function buildStatusHint(opts: {
  modifiedAtMs: number;
  now: number;
  repoInfo: string;
  state: string;
}): string {
  const parts = [formatRelativeTime(opts.modifiedAtMs, opts.now)];
  const detail = opts.repoInfo.trim();
  if (detail.length > 0) parts.push(detail);
  if (opts.state === "stale") parts.push("stale");
  return parts.join(" · ");
}

/** Compact relative time, e.g. "just now", "5m ago", "2h ago", "3d ago". */
function formatRelativeTime(modifiedAtMs: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - modifiedAtMs) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function matchesSubsequence(haystack: string, query: string): boolean {
  const target = haystack.toLowerCase();
  const needle = query.toLowerCase();
  let index = 0;
  for (const character of target) {
    if (character === needle[index]) {
      index += 1;
      if (index === needle.length) {
        return true;
      }
    }
  }
  return index === needle.length;
}
