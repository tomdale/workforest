import { realpath } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceConfig } from "../types.ts";
import {
  type ChangeInventoryEntry,
  collectChangeInventory,
} from "./change-inventory.ts";
import { isPathInsideOrEqual } from "./paths.ts";

export type ChangeSelectorResolution =
  | Readonly<{
      kind: "resolved";
      entry: ChangeInventoryEntry;
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
    }>;

export async function resolveChangeSelector(
  config: WorkspaceConfig,
  selector: string | undefined,
  cwd = process.cwd(),
): Promise<ChangeSelectorResolution> {
  const inventory = await collectChangeInventory(config);
  const entries = [...inventory.workspaces, ...inventory.repositories];

  if (selector) {
    return resolveExplicitSelector(entries, selector);
  }

  return resolveCurrentChange(entries, config, cwd);
}

function resolveExplicitSelector(
  entries: readonly ChangeInventoryEntry[],
  selector: string,
): ChangeSelectorResolution {
  if (selector.includes("/")) {
    const entry = entries.find((candidate) => candidate.selector === selector);
    return entry ? { kind: "resolved", entry } : { kind: "missing", selector };
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
    return {
      kind: "ambiguous",
      selector,
      matches: matches.map((entry) => entry.selector).sort(),
    };
  }
  return { kind: "missing", selector };
}

async function resolveCurrentChange(
  entries: readonly ChangeInventoryEntry[],
  _config: WorkspaceConfig,
  cwd: string,
): Promise<ChangeSelectorResolution> {
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
