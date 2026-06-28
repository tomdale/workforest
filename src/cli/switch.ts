import path from "node:path";
import { loadWorkspaceConfig } from "../config.ts";
import { log } from "../logger.ts";
import { isShellAutoCdEnabled } from "../shell.ts";
import {
  CancelError,
  cancel,
  type PromptFuzzySelectOptions,
  promptFuzzySelect,
} from "../ui/prompts/index.ts";
import {
  collectInventory,
  type InventoryEntry,
} from "../workspace/inventory.ts";
import { resolveSelector } from "../workspace/selectors.ts";
import { OperationalError, UsageError } from "./errors.ts";
import { success } from "./output.ts";
import type { CommandResult, ParsedInvocation } from "./types.ts";

export type SwitchPrompt = (
  message: string,
  options: PromptFuzzySelectOptions<InventoryEntry>,
) => Promise<InventoryEntry>;

export type SwitchSurface = (
  entries: readonly InventoryEntry[],
) => Promise<InventoryEntry | null>;

export type RunSwitchCommandOptions = Readonly<{
  interactive: boolean;
  fullscreen?: boolean;
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
  let entry: InventoryEntry | null;

  if (selector) {
    entry = await resolveSwitchSelector(config, selector);
  } else {
    if (!options.interactive) {
      throw new UsageError(
        "wf switch requires a selector without an interactive terminal.",
      );
    }
    entry = await promptForSwitchTarget(config, {
      fullscreen: options.fullscreen === true,
      ...(options.prompt ? { prompt: options.prompt } : {}),
      ...(options.surface ? { surface: options.surface } : {}),
    });
    if (!entry) return success();
  }

  await options.writeShellCdPath(entry.path);
  if (!isShellAutoCdEnabled()) {
    log.info(`Run: cd ${entry.path}`);
  }
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

async function resolveSwitchSelector(
  config: Awaited<ReturnType<typeof loadWorkspaceConfig>>["config"],
  selector: string,
): Promise<InventoryEntry> {
  const resolution = await resolveSelector(config, selector);
  if (resolution.kind === "resolved") {
    return resolution.entry;
  }
  if (resolution.kind === "missing") {
    throw new UsageError(`Unknown selector: ${resolution.selector}`);
  }
  if (resolution.kind === "ambiguous") {
    throw new UsageError(
      [
        `Ambiguous selector "${resolution.selector}".`,
        "Matches:",
        ...resolution.matches.map((match) => `  ${match}`),
        resolution.hint ?? "Use <group>/<name>.",
      ].join("\n"),
    );
  }

  throw new OperationalError("Not in a Workforest worktree or workspace.");
}

async function promptForSwitchTarget(
  config: Awaited<ReturnType<typeof loadWorkspaceConfig>>["config"],
  options: {
    fullscreen: boolean;
    prompt?: SwitchPrompt;
    surface?: SwitchSurface;
  },
): Promise<InventoryEntry | null> {
  const inventory = await collectInventory(config);
  const entries = [...inventory.workspaces, ...inventory.repositories];
  if (entries.length === 0) {
    throw new OperationalError(
      "No worktrees or workspaces found.\nStart one: wf new <name> <repo|@template>",
    );
  }

  if (options.fullscreen && !options.prompt) {
    const surface = options.surface ?? runDefaultSwitchSurface;
    return surface(entries);
  }

  const prompt = options.prompt ?? promptFuzzySelect;
  try {
    return await prompt("Switch to change", {
      options: buildSwitchCandidates(entries),
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
): Promise<InventoryEntry | null> {
  const { runSwitchSurface } = await import("../entry/switch-surface.ts");
  return runSwitchSurface(entries);
}

function switchCandidateDescription(entry: InventoryEntry): string {
  const searchText =
    entry.type === "worktree"
      ? `${entry.repository} ${entry.path}`
      : `${entry.repos.join(", ")} ${entry.path}`;
  return [
    entry.type === "worktree" ? "repository" : entry.groupName,
    entry.changeName,
    compactHome(searchText),
  ].join(" - ");
}

function compactHome(value: string): string {
  const home = process.env["HOME"];
  if (!home) return value;
  const resolved = path.resolve(value);
  const resolvedHome = path.resolve(home);
  return resolved === resolvedHome
    ? "~"
    : resolved.startsWith(`${resolvedHome}${path.sep}`)
      ? `~/${path.relative(resolvedHome, resolved)}`
      : value;
}
