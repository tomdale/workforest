import chalk from "chalk";
import { commandRegistry } from "./cli/commands.ts";
import type {
  Cardinality,
  CommandGroup,
  CommandLeaf,
  CommandNode,
  CommandRegistry,
  CommandShortcut,
  FlagDefinition,
} from "./cli/types.ts";
import { loadWorkspaceConfig } from "./config.ts";
import { getTemplatesDir, listTemplates } from "./templates/index.ts";
import { helpColor } from "./terminal/theme.ts";

export type RootHelpContext = Readonly<{
  configPath: string;
  templatesDir: string;
  templates: readonly string[];
}>;

export async function help(): Promise<string> {
  let configPath = "(unavailable)";
  try {
    configPath = (await loadWorkspaceConfig()).path;
  } catch {
    // Help remains available when configuration is missing or malformed.
  }

  const templatesDir = getTemplatesDir();
  const discoveredTemplates = await listTemplates();
  const templates =
    discoveredTemplates.length === 0
      ? ["(none)"]
      : discoveredTemplates.map(
          (template) =>
            `${template.id.padEnd(20)}  ${template.config.description ?? template.config.repos.join(", ")}`,
        );

  return rootHelp(commandRegistry, {
    configPath,
    templatesDir,
    templates,
  });
}

export function rootHelp(
  registry: CommandRegistry,
  context: RootHelpContext,
): string {
  const commands = registry.root.children.filter(isVisible).map((node) => ({
    key: rootCommandSyntax(node),
    description: node.summary,
  }));
  const shortcuts = registry.shortcuts.filter(isVisible).map((shortcut) => ({
    key: shortcut.name,
    description: `Shortcut for ${formatCommand(shortcut.target)}`,
  }));

  return renderHelp(`
Usage: wf <command> [options]

Start here (for AI agents):
  wf skills get core --full

Commands:
${formatRows([...commands, ...shortcuts])}

Examples:
  wf workspace create vercel/next.js -- "update docs"
  wf workspace create --like current -- "try another approach"
  wf workspace open --search
  wf task create fix-tests
  wf worktree create vercel/next.js fix-auth
  wf cache doctor
  wf review open vercel/omniagent
  wf review checkout vercel/omniagent#123
  wf template manage
  eval "$(wf shell init zsh)"

Templates:
  ${context.templates.join("\n  ")}

Config:     ${context.configPath}
Templates:  ${context.templatesDir}
`);
}

export function commandHelp(command: string): string | null {
  const shortcut = commandRegistry.shortcuts.find(
    (candidate) => candidate.name === command,
  );
  if (shortcut) {
    return shortcutHelp(commandRegistry, shortcut);
  }
  return commandPathHelp(commandRegistry, [command]);
}

export function nestedCommandHelp(
  command: string,
  subcommand: string,
): string | null {
  return commandPathHelp(commandRegistry, [command, subcommand]);
}

export function commandPathHelp(
  registry: CommandRegistry,
  path: readonly string[],
): string | null {
  const node = findNode(registry.root, path);
  if (!node) {
    return null;
  }
  return node.kind === "group" ? groupHelp(node) : leafHelp(node, node.path);
}

export function commandUsageLines(
  leaf: CommandLeaf,
  path: readonly string[] = leaf.path,
): string[] {
  const command = formatCommand(path);
  const options = leaf.flags.length > 0 ? " [options]" : "";
  const variants = leaf.operands.variants.map((variant) => {
    const before = formatCardinality(variant.beforeDoubleDash);
    const after = variant.afterDoubleDash
      ? formatCardinality(variant.afterDoubleDash)
      : "";
    const delimiter = variant.delimiter === "required" ? " --" : "";
    return `${command}${options}${before ? ` ${before}` : ""}${delimiter}${after ? ` ${after}` : ""}`;
  });
  return [...new Set(variants)];
}

function groupHelp(group: CommandGroup): string {
  const subcommand = group.default ? "[subcommand]" : "<subcommand>";
  const children = group.children.filter(isVisible).map((child) => ({
    key: nodeDisplayName(child),
    description: child.summary,
  }));

  return renderHelp(`Usage: ${formatCommand(group.path)} ${subcommand}

${group.summary}.

Subcommands:
${formatRows(children)}
`);
}

function leafHelp(leaf: CommandLeaf, path: readonly string[]): string {
  const usage = formatUsage(commandUsageLines(leaf, path));
  const options =
    leaf.flags.length === 0
      ? ""
      : `

Options:
${formatRows(
  leaf.flags.map((flag) => ({
    key: formatFlag(flag),
    description: flag.required ? "Required." : "Optional.",
  })),
)}`;

  return renderHelp(`${usage}

${leaf.summary}.${options}
`);
}

function shortcutHelp(
  registry: CommandRegistry,
  shortcut: CommandShortcut,
): string | null {
  const target = findNode(registry.root, shortcut.target);
  if (!target || target.kind !== "leaf") {
    return null;
  }
  const usage = formatUsage(commandUsageLines(target, [shortcut.name]));
  const options =
    target.flags.length === 0
      ? ""
      : `

Options:
${formatRows(
  target.flags.map((flag) => ({
    key: formatFlag(flag),
    description: flag.required ? "Required." : "Optional.",
  })),
)}`;

  return renderHelp(`${usage}

Shortcut for ${formatCommand(shortcut.target)}.${options}
`);
}

function findNode(
  root: CommandGroup,
  path: readonly string[],
): CommandNode | null {
  let node: CommandNode = root;
  for (const segment of path) {
    if (node.kind !== "group") {
      return null;
    }
    const child: CommandNode | undefined = node.children.find(
      (candidate) =>
        candidate.name === segment ||
        candidate.aliases.some((alias) => alias.name === segment),
    );
    if (!child) {
      return null;
    }
    node = child;
  }
  return node;
}

function rootCommandSyntax(node: CommandNode): string {
  if (node.kind !== "group") {
    return nodeDisplayName(node);
  }
  const children = node.children
    .filter(isVisible)
    .map((child) => nodeDisplayName(child));
  return children.length === 0
    ? nodeDisplayName(node)
    : `${nodeDisplayName(node)} ${children.join("|")}`;
}

function nodeDisplayName(node: CommandNode): string {
  const aliases = node.aliases
    .filter(isVisible)
    .map((alias) => alias.name)
    .join("|");
  return aliases ? `${node.name}|${aliases}` : node.name;
}

function formatUsage(lines: readonly string[]): string {
  return lines
    .map((line, index) => `${index === 0 ? "Usage:" : "      "} ${line}`)
    .join("\n");
}

function formatRows(
  rows: readonly Readonly<{ key: string; description: string }>[],
): string {
  const width = Math.max(0, ...rows.map((row) => row.key.length));
  return rows
    .map(
      ({ key, description }) =>
        `  ${key.padEnd(width)}  ${description.replace(/\.$/, "")}`,
    )
    .join("\n");
}

function formatFlag(flag: FlagDefinition): string {
  const names = flag.short ? `${flag.short}, ${flag.long}` : flag.long;
  return flag.kind === "string" ? `${names} <${flag.valueName}>` : names;
}

function formatCardinality(cardinality: Cardinality): string {
  if (cardinality.usage !== undefined) {
    return cardinality.usage;
  }
  if (cardinality.min === 0 && cardinality.max === 0) {
    return "";
  }
  const repeating = cardinality.max === null;
  const label = `<${cardinality.label}${repeating ? "..." : ""}>`;
  return cardinality.min === 0 ? `[${label.slice(1, -1)}]` : label;
}

function formatCommand(path: readonly string[]): string {
  return path.length === 0 ? "wf" : `wf ${path.join(" ")}`;
}

function isVisible(
  value: CommandNode | CommandShortcut | CommandNode["aliases"][number],
): boolean {
  return value.visibility === "visible";
}

export function renderHelp(content: string): string {
  const lines = content.trim().split("\n");
  let section = "";

  return lines
    .map((line) => {
      const usage = line.match(/^(\s*)(Usage:|\s{7})(.*)$/);
      if (usage) {
        const [, indent = "", label = "", syntax = ""] = usage;
        return `${indent}${label.trim() ? helpHeading(label) : " ".repeat(label.length)}${styleCommandSyntax(syntax)}`;
      }

      const heading = line.match(/^([^ ].*):$/);
      if (heading) {
        section = heading[1] ?? "";
        return helpHeading(line);
      }

      const row = line.match(/^(\s+)(.*?\S)(\s{2,})(\S.*)$/);
      if (row) {
        const [, indent = "", key = "", gap = "", description = ""] = row;
        return `${indent}${styleRowKey(key, section)}${gap}${styleDescription(description)}`;
      }

      if (
        line.startsWith("  ") &&
        ["Examples", "Start here (for AI agents)"].includes(section)
      ) {
        return `${line.slice(0, 2)}${styleExample(line.slice(2))}`;
      }

      const metadata = line.match(/^([A-Z][^:]+:)(\s+)(.+)$/);
      if (metadata) {
        const [, label = "", gap = "", value = ""] = metadata;
        return helpColor.metadata(`${label}${gap}${value}`);
      }

      const title = line.match(/^(wf(?:\s+\S+)*)(\s+-\s+)(.+)$/);
      if (title) {
        const [, command = "", separator = "", description = ""] = title;
        return `${styleCommandSyntax(command)}${helpColor.metadata(separator)}${styleDescription(description)}`;
      }

      return line;
    })
    .join("\n");
}

function helpHeading(value: string): string {
  return helpColor.heading(chalk.bold(value));
}

function styleCommandSyntax(value: string): string {
  return styleTokens(value, true);
}

function styleOptionSyntax(value: string): string {
  return styleTokens(value, false);
}

function styleTokens(value: string, colorBareWords: boolean): string {
  const tokens =
    /(?:^|[\s,])--?[a-z][\w-]*|\b(?:wf|workforest)\b|<[^>]+>|\[[^\]]+\]|(?:^|\s)[a-z][\w|.-]*(?=\s|$)/gi;

  return value.replace(tokens, (token) => {
    const normalized = token.trimStart();
    const prefix = token.slice(0, token.length - normalized.length);

    if (normalized === "wf" || normalized === "workforest") {
      return `${prefix}${helpColor.program(chalk.bold(normalized))}`;
    }
    if (normalized.startsWith("-")) {
      return `${prefix}${helpColor.option(normalized)}`;
    }
    if (normalized.startsWith("<") || normalized.startsWith("[")) {
      return `${prefix}${helpColor.argument(normalized)}`;
    }
    if (colorBareWords) {
      return `${prefix}${helpColor.command(normalized)}`;
    }
    return token;
  });
}

function styleRowKey(value: string, section: string): string {
  if (section === "Options") {
    return styleOptionSyntax(value);
  }
  if (["Examples", "Start here (for AI agents)"].includes(section)) {
    return styleExample(value);
  }
  return styleCommandSyntax(value);
}

function styleExample(value: string): string {
  return value.replace(
    /"[^"]*"|'[^']*'|(?:^|[\s,])--?[a-z][\w-]*|\b(?:wf|workforest)\b|(?:^|\s)(?:add-file|cache|checkout|clean|config|confetti|create|delete|dev|doctor|edit|eval|get|info|init|list|manage|new|open|path|prune|repair|review|shell|show|simulate|skills|status|task|template|update|version|worktree|workspace)(?=\s|$)|(?:^|\s)(?:\.{1,2}\/|[\w.-]+\/)\S+|\b\d+\b/gi,
    (token) => {
      const normalized = token.trimStart();
      const prefix = token.slice(0, token.length - normalized.length);

      if (normalized === "wf" || normalized === "workforest") {
        return `${prefix}${helpColor.program(chalk.bold(normalized))}`;
      }
      if (normalized.startsWith("-")) {
        return `${prefix}${helpColor.option(normalized)}`;
      }
      if (
        normalized.startsWith('"') ||
        normalized.startsWith("'") ||
        /^\d+$/.test(normalized) ||
        normalized.includes("/")
      ) {
        return `${prefix}${helpColor.argument(normalized)}`;
      }
      return `${prefix}${helpColor.command(normalized)}`;
    },
  );
}

function styleDescription(value: string): string {
  return value
    .split(/(\([^)]*(?:default|none|current)[^)]*\)|\$[A-Z][A-Z0-9_]*)/gi)
    .map((part, index) =>
      index % 2 === 1 ? helpColor.metadata(part) : helpColor.description(part),
    )
    .join("");
}
