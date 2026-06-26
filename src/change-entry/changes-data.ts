import { loadWorkspaceConfig } from "../config.ts";
import { runGit } from "../services/git.ts";
import { writeShellCdPath } from "../shell.ts";
import {
  type ChangeInventoryEntry,
  collectChangeInventory,
} from "../workspace/change-inventory.ts";

/**
 * A single selectable existing change, flattened from the workspace + repository
 * inventory. This is the cheap, render-ready shape the change-entry surface
 * consumes for Phase 1 (go to an existing change). Expensive per-row details
 * (git dirty state) are intentionally excluded — fetch those lazily with
 * {@link dirtyHintFor} for the highlighted row only.
 */
export type ChangeCandidate = {
  selector: string;
  changeName: string;
  kind: "workspace" | "repository";
  statusHint: string;
  path: string;
};

/**
 * Load every existing change and flatten it into render-ready candidates,
 * sorted most-recently-modified first.
 */
export async function listChangeCandidates(): Promise<ChangeCandidate[]> {
  const { config } = await loadWorkspaceConfig();
  const inventory = await collectChangeInventory(config);

  const entries: ChangeInventoryEntry[] = [
    ...inventory.workspaces,
    ...inventory.repositories,
  ];
  entries.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);

  return entries.map(toChangeCandidate);
}

/**
 * Case-insensitive subsequence filter over each candidate's selector and change
 * name. Input order is preserved for matches so callers can rely on the
 * most-recently-modified ordering from {@link listChangeCandidates}.
 */
export function filterChangeCandidates(
  candidates: ChangeCandidate[],
  query: string,
): ChangeCandidate[] {
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
 * A no-op when shell auto-cd is not enabled (see {@link writeShellCdPath}).
 */
export async function cdToChange(candidate: ChangeCandidate): Promise<void> {
  await writeShellCdPath(candidate.path);
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

function toChangeCandidate(entry: ChangeInventoryEntry): ChangeCandidate {
  if (entry.type === "repository-change") {
    return {
      selector: entry.selector,
      changeName: entry.changeName,
      kind: "repository",
      statusHint: buildStatusHint(entry.state, entry.repository),
      path: entry.path,
    };
  }

  return {
    selector: entry.selector,
    changeName: entry.changeName,
    kind: "workspace",
    statusHint: buildStatusHint(entry.state, entry.repoSummary),
    path: entry.path,
  };
}

function buildStatusHint(state: string, repoInfo: string): string {
  const detail = repoInfo.trim();
  return detail.length > 0 ? `${state} · ${detail}` : state;
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
