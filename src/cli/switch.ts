import { loadWorkspaceConfig } from "../config.ts";
import { type Scope, sortEntriesByRecency } from "../entry/entries-data.ts";
import { reportShellCdTarget } from "../shell.ts";
import {
  CancelError,
  cancel,
  type PromptFuzzySelectOptions,
  promptFuzzySelect,
} from "../ui/prompts/index.ts";
import { compactHome } from "../utils/display-path.ts";
import {
  collectInventory,
  type InventoryEntry,
} from "../workspace/inventory.ts";
import { OperationalError, UsageError } from "./errors.ts";
import { success } from "./output.ts";
import type { CommandResult, ParsedInvocation } from "./types.ts";

export type SwitchPrompt = (
  message: string,
  options: PromptFuzzySelectOptions<InventoryEntry>,
) => Promise<InventoryEntry>;

export type SwitchSurface = (
  entries: readonly InventoryEntry[],
  scope: Scope | undefined,
  initialQuery?: string,
) => Promise<InventoryEntry | null>;

export type RunSwitchCommandOptions = Readonly<{
  interactive: boolean;
  fullscreen?: boolean;
  scope?: Scope;
  writeShellCdPath: (targetDir: string) => Promise<void>;
  prompt?: SwitchPrompt;
  surface?: SwitchSurface;
}>;

export async function runSwitchCommand(
  invocation: ParsedInvocation,
  options: RunSwitchCommandOptions,
): Promise<CommandResult> {
  const selector = invocation.beforeDoubleDash[0];
  const { config } = await loadWorkspaceConfig();
  if (!selector && !options.interactive) {
    throw new UsageError(
      "wf switch requires a selector without an interactive terminal.",
    );
  }

  const entries = await collectSwitchEntries(config);
  let entry: InventoryEntry | null;

  if (selector) {
    const resolution = resolveFuzzySwitchQuery(entries, selector);
    if (resolution.kind === "resolved") {
      entry = resolution.entry;
    } else {
      if (!options.interactive) {
        throw fuzzySwitchUsageError(selector, resolution.matches);
      }
      entry = await promptForSwitchTarget(entries, {
        fullscreen: options.fullscreen === true,
        initialQuery: selector,
        ...(options.scope ? { scope: options.scope } : {}),
        ...(options.prompt ? { prompt: options.prompt } : {}),
        ...(options.surface ? { surface: options.surface } : {}),
      });
      if (!entry) return success();
    }
  } else {
    entry = await promptForSwitchTarget(entries, {
      fullscreen: options.fullscreen === true,
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.prompt ? { prompt: options.prompt } : {}),
      ...(options.surface ? { surface: options.surface } : {}),
    });
    if (!entry) return success();
  }

  await reportShellCdTarget(entry.path, {
    writeShellCdPath: options.writeShellCdPath,
  });
  return success();
}

export function buildSwitchCandidates(entries: readonly InventoryEntry[]): {
  value: InventoryEntry;
  label: string;
  description: string;
}[] {
  return entries.map((entry) => ({
    value: entry,
    label: entry.selector,
    description: switchCandidateDescription(entry),
  }));
}

type FuzzySwitchResolution =
  | Readonly<{
      kind: "resolved";
      entry: InventoryEntry;
    }>
  | Readonly<{
      kind: "unresolved";
      matches: readonly InventoryEntry[];
    }>;

async function collectSwitchEntries(
  config: Awaited<ReturnType<typeof loadWorkspaceConfig>>["config"],
): Promise<InventoryEntry[]> {
  const inventory = await collectInventory(config);
  const entries = sortEntriesByRecency([
    ...inventory.workspaces,
    ...inventory.repositories,
  ]);
  if (entries.length === 0) {
    throw new OperationalError(
      "No worktrees or workspaces found.\nStart one: wf new <name> <repo|@template>",
    );
  }
  return entries;
}

function resolveFuzzySwitchQuery(
  entries: readonly InventoryEntry[],
  query: string,
): FuzzySwitchResolution {
  const matches = fuzzySwitchMatches(entries, query);
  // Prefer stronger tiers before broad subsequence matching so "cli" can pick
  // "cli-redesign" without also treating letters spread across "vercel ... fix"
  // as an equally strong match.
  const exact = matches.filter((entry) => matchesQueryExactly(entry, query));
  if (exact.length === 1) {
    return { kind: "resolved", entry: exact[0] as InventoryEntry };
  }
  if (exact.length > 1) {
    return { kind: "unresolved", matches: exact };
  }

  const contiguous = matches.filter((entry) =>
    matchesQueryContiguously(entry, query),
  );
  if (contiguous.length === 1) {
    return { kind: "resolved", entry: contiguous[0] as InventoryEntry };
  }
  if (contiguous.length > 1) {
    return { kind: "unresolved", matches: contiguous };
  }

  if (matches.length === 1) {
    return { kind: "resolved", entry: matches[0] as InventoryEntry };
  }
  return { kind: "unresolved", matches };
}

function fuzzySwitchMatches(
  entries: readonly InventoryEntry[],
  query: string,
): InventoryEntry[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return [...entries];
  }

  return entries.filter((entry) =>
    matchesSubsequence(`${entry.selector} ${entry.changeName}`, trimmed),
  );
}

function matchesQueryExactly(entry: InventoryEntry, query: string): boolean {
  const target = query.trim().toLocaleLowerCase();
  return (
    entry.selector.toLocaleLowerCase() === target ||
    entry.changeName.toLocaleLowerCase() === target
  );
}

function matchesQueryContiguously(
  entry: InventoryEntry,
  query: string,
): boolean {
  const target = query.trim().toLocaleLowerCase();
  return (
    entry.selector.toLocaleLowerCase().includes(target) ||
    entry.changeName.toLocaleLowerCase().includes(target)
  );
}

function fuzzySwitchUsageError(
  query: string,
  matches: readonly InventoryEntry[],
): UsageError {
  if (matches.length === 0) {
    return new UsageError(
      `No switch targets match "${query}". Run wf switch from an interactive terminal to choose from the picker.`,
    );
  }

  return new UsageError(
    [
      `Multiple switch targets match "${query}".`,
      "Matches:",
      ...matches.map((entry) => `  ${entry.selector}`),
      "Run wf switch from an interactive terminal to choose from the picker.",
    ].join("\n"),
  );
}

function matchesSubsequence(haystack: string, query: string): boolean {
  const target = haystack.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
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

async function promptForSwitchTarget(
  entries: readonly InventoryEntry[],
  options: {
    fullscreen: boolean;
    initialQuery?: string;
    scope?: Scope;
    prompt?: SwitchPrompt;
    surface?: SwitchSurface;
  },
): Promise<InventoryEntry | null> {
  if (options.fullscreen && !options.prompt) {
    const surface = options.surface ?? runDefaultSwitchSurface;
    return surface(entries, options.scope, options.initialQuery);
  }

  const prompt = options.prompt ?? promptFuzzySelect;
  try {
    return await prompt("Switch to change", {
      options: buildSwitchCandidates(entries),
      ...(options.initialQuery !== undefined
        ? { initialQuery: options.initialQuery }
        : {}),
      throwOnCancel: true,
    });
  } catch (error) {
    if (error instanceof CancelError) {
      cancel("Cancelled");
      return null;
    }
    throw error;
  }
}

async function runDefaultSwitchSurface(
  entries: readonly InventoryEntry[],
  scope: Scope | undefined,
  initialQuery?: string,
): Promise<InventoryEntry | null> {
  const { runSwitchSurface } = await import("../entry/switch-surface.ts");
  return runSwitchSurface(entries, scope, initialQuery);
}

function switchCandidateDescription(entry: InventoryEntry): string {
  const searchText =
    entry.type === "worktree"
      ? `${entry.repository} ${compactHome(entry.path)}`
      : `${entry.repos.join(", ")} ${compactHome(entry.path)}`;
  return [
    entry.type === "worktree" ? "repository" : entry.groupName,
    entry.changeName,
    searchText,
  ].join(" - ");
}
