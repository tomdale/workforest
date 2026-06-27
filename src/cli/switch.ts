import path from "node:path";
import { loadWorkspaceConfig } from "../config.ts";
import { log } from "../logger.ts";
import { isShellAutoCdEnabled } from "../shell.ts";
import { maintainWorkspaceAgentsMd } from "../templates/agents-md.ts";
import { loadTemplate } from "../templates/index.ts";
import {
  CancelError,
  cancel,
  type PromptFuzzySelectOptions,
  promptFuzzySelect,
} from "../ui/prompts/index.ts";
import {
  type ChangeInventoryEntry,
  collectChangeInventory,
} from "../workspace/change-inventory.ts";
import { readWorkspaceMetadata } from "../workspace/metadata.ts";
import { resolveChangeSelector } from "../workspace/selectors.ts";
import { OperationalError, UsageError } from "./errors.ts";
import { success } from "./output.ts";
import type { CommandResult, ParsedInvocation } from "./types.ts";

export type SwitchPrompt = (
  message: string,
  options: PromptFuzzySelectOptions<ChangeInventoryEntry>,
) => Promise<ChangeInventoryEntry>;

export type RunSwitchCommandOptions = Readonly<{
  interactive: boolean;
  writeShellCdPath: (targetDir: string) => Promise<void>;
  prompt?: SwitchPrompt;
}>;

export async function runSwitchCommand(
  invocation: ParsedInvocation,
  options: RunSwitchCommandOptions,
): Promise<CommandResult> {
  const selector = invocation.beforeDoubleDash[0];
  const { config } = await loadWorkspaceConfig();
  let entry: ChangeInventoryEntry | null;

  if (selector) {
    entry = await resolveSwitchSelector(config, selector);
  } else {
    if (!options.interactive) {
      throw new UsageError(
        "wf switch requires a selector without an interactive terminal.",
      );
    }
    entry = await promptForSwitchTarget(config, options.prompt);
    if (!entry) return success();
  }

  if (entry.type !== "repository-change") {
    const metadata = await readWorkspaceMetadata(entry.path).catch(() => null);
    const templateId = metadata?.workspace.template_id;
    const template = templateId ? await loadTemplate(templateId) : null;
    if (template) await maintainWorkspaceAgentsMd(template, entry.path);
  }
  await options.writeShellCdPath(entry.path);
  if (!isShellAutoCdEnabled()) {
    log.info(`Run: cd ${entry.path}`);
  }
  return success();
}

export function buildSwitchCandidates(
  entries: readonly ChangeInventoryEntry[],
): {
  value: ChangeInventoryEntry;
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
): Promise<ChangeInventoryEntry> {
  const resolution = await resolveChangeSelector(config, selector);
  if (resolution.kind === "resolved") {
    return resolution.entry;
  }
  if (resolution.kind === "missing") {
    throw new UsageError(`Unknown change selector: ${resolution.selector}`);
  }
  if (resolution.kind === "ambiguous") {
    throw new UsageError(
      [
        `Ambiguous change selector "${resolution.selector}".`,
        "Matches:",
        ...resolution.matches.map((match) => `  ${match}`),
        resolution.hint ?? "Use <group>/<change>.",
      ].join("\n"),
    );
  }

  throw new OperationalError("Not in a Workforest change.");
}

async function promptForSwitchTarget(
  config: Awaited<ReturnType<typeof loadWorkspaceConfig>>["config"],
  prompt: SwitchPrompt = promptFuzzySelect,
): Promise<ChangeInventoryEntry | null> {
  const inventory = await collectChangeInventory(config);
  const entries = [...inventory.workspaces, ...inventory.repositories];
  if (entries.length === 0) {
    throw new OperationalError(
      "No Workforest changes found.\nStart one: wf start <change> <repo|@template>",
    );
  }

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

function switchCandidateDescription(entry: ChangeInventoryEntry): string {
  const searchText =
    entry.type === "repository-change"
      ? `${entry.repository} ${entry.path}`
      : `${entry.repos.join(", ")} ${entry.path}`;
  return [
    entry.type === "repository-change" ? "repository" : entry.groupName,
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
