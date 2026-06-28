import { realpath } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceConfig } from "../types.ts";
import { collectInventory, type InventoryEntry } from "./inventory.ts";
import { isPathInsideOrEqual } from "./paths.ts";

export type SelectorResolution =
  | Readonly<{
      kind: "resolved";
      entry: InventoryEntry;
    }>
  | Readonly<{
      kind: "outside";
    }>
  | Readonly<{
      kind: "missing";
      selector: string;
    }>
  | Readonly<{
      kind: "ambiguous";
      selector: string;
      matches: readonly string[];
      hint?: string;
    }>;

export async function resolveSelector(
  config: WorkspaceConfig,
  selector: string | undefined,
  cwd = process.cwd(),
): Promise<SelectorResolution> {
  const inventory = await collectInventory(config);
  const entries = [...inventory.workspaces, ...inventory.repositories];

  if (selector) {
    return resolveExplicitSelector(entries, selector);
  }

  return resolveCurrentEntry(entries, config, cwd);
}

function resolveExplicitSelector(
  entries: readonly InventoryEntry[],
  selector: string,
): SelectorResolution {
  if (selector.includes("/")) {
    const matches = entries.filter(
      (candidate) => candidate.selector === selector,
    );
    if (matches.length === 1) {
      const entry = matches[0];
      if (!entry) {
        return { kind: "missing", selector };
      }
      return { kind: "resolved", entry };
    }
    if (matches.length > 1) {
      return ambiguousSelectorResolution(selector, matches);
    }
    return { kind: "missing", selector };
  }

  const matches = entries.filter((entry) => entry.changeName === selector);
  if (matches.length === 1) {
    const entry = matches[0];
    if (!entry) {
      return { kind: "missing", selector };
    }
    return { kind: "resolved", entry };
  }
  if (matches.length > 1) {
    return ambiguousSelectorResolution(selector, matches);
  }
  return { kind: "missing", selector };
}

function ambiguousSelectorResolution(
  selector: string,
  matches: readonly InventoryEntry[],
): SelectorResolution {
  const selectorCounts = new Map<string, number>();
  for (const entry of matches) {
    selectorCounts.set(
      entry.selector,
      (selectorCounts.get(entry.selector) ?? 0) + 1,
    );
  }
  const hasDuplicateSelector = Array.from(selectorCounts.values()).some(
    (count) => count > 1,
  );

  return {
    kind: "ambiguous",
    selector,
    matches: hasDuplicateSelector
      ? matches.map(formatAmbiguousSelectorMatch).sort()
      : matches.map((entry) => entry.selector).sort(),
    ...(hasDuplicateSelector
      ? {
          hint: "This selector maps to more than one path; run from the intended path or choose it in the interactive switcher.",
        }
      : {}),
  };
}

function formatAmbiguousSelectorMatch(entry: InventoryEntry): string {
  return `${entry.selector} (${entry.type} at ${entry.path})`;
}

async function resolveCurrentEntry(
  entries: readonly InventoryEntry[],
  _config: WorkspaceConfig,
  cwd: string,
): Promise<SelectorResolution> {
  const resolvedCwd = await comparablePath(cwd);
  const comparableEntries = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      path: await comparablePath(entry.path),
    })),
  );
  const matches = comparableEntries
    .filter((candidate) => isPathInsideOrEqual(candidate.path, resolvedCwd))
    .map((candidate) => candidate.entry)
    .sort((left, right) => right.path.length - left.path.length);

  if (matches[0]) {
    return { kind: "resolved", entry: matches[0] };
  }

  return { kind: "outside" };
}

async function comparablePath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}
