import chalk from "chalk";
import { commandRegistry } from "./cli/commands.ts";
import type {
  Cardinality,
  CommandExample,
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

/** One-line definitions of workforest's core nouns, shared by the root help
 * page and the generated command reference so both stay in sync. */
export const CONCEPTS: readonly Readonly<{ term: string; summary: string }>[] =
  [
    {
      term: "change",
      summary:
        "A repository or workspace lane managed by Workforest for one piece of work",
    },
    {
      term: "workspace",
      summary:
        "A multi-repository change directory, branched and set up together",
    },
    {
      term: "task",
      summary:
        "A short-lived nested worktree inside a managed change, on its own branch",
    },
    {
      term: "template",
      summary:
        "A saved repository set, plus hooks and files, to start workspaces from",
    },
    {
      term: "cached mirror",
      summary:
        "A local bare clone each worktree is built from, kept for fast offline setup",
    },
    {
      term: "review workspace",
      summary: "A workspace for reviewing someone's pull request (wf review)",
    },
  ];

export const ROOT_OVERVIEW =
  "workforest creates isolated changes from cached repositories, so a feature can move one repo or several together without juggling branches in a single checkout.";

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
  const concepts = CONCEPTS.map(({ term, summary }) => ({
    key: term,
    description: summary,
  }));

  return renderHelp(`
Usage: wf <command> [options]

${wrapText(ROOT_OVERVIEW, 80)}

Start here (for AI agents):
  wf skills get core --full

Commands:
${formatRows([...commands, ...shortcuts])}

Examples:
  wf start billing vercel/front vercel/api vercel/docs
  wf start docs vercel/next.js
  wf start follow-up
  wf switch
  wf status --watch
  wf task start fix-tests
  wf finish workforest/cli-redesign
  wf cache check
  wf review open vercel/omniagent
  wf review checkout vercel/omniagent#123
  wf template manage
  eval "$(wf shell init zsh)"

Concepts:
${formatRows(concepts)}

Templates:
  ${context.templates.join("\n  ")}

Config:     ${context.configPath}
Templates:  ${context.templatesDir}
`);
}

export function conceptsPage(): string {
  return renderHelp(`
wf help concepts - Core concepts and the git model behind workforest.

Nouns:
  change               A repository or workspace lane for one piece of work. Created with
                       \`wf start\`, entered with \`wf switch\`, inspected with \`wf list\` and
                       \`wf status\`, and cleaned up with \`wf finish\` or \`wf delete\`.

  repository change    A single repository worktree under \`Repos/<repo>/<change>\`.
                       Created with \`wf start <change> <repo>\`.

  workspace            A multi-repository change under \`Workspaces/<template>/<change>\` or
                       \`Workspaces/_adhoc/<change>\`, with metadata at
                       \`.workforest/workspace.json\`.

  task                 A short-lived nested worktree inside a change, on its own branch.
                       Created with \`wf task start\` from inside a managed change. Because tasks
                       reuse the parent repository's cached mirror, setup is instant. Finish integrated work
                       with \`wf task finish\`, or abandon explicitly with \`wf task delete\`.

  template             A saved workspace recipe: a list of repositories plus optional hooks, extra
                       files, and a branch prefix. Stored under
                       \`~/.config/workforest/templates/<name>/template.jsonc\`.
                       Create and edit with \`wf template manage\`.

  cached mirror        A bare local clone of a remote repository kept under \`~/.cache/workforest/\`.
                       All worktrees are built from these mirrors, so workspace creation works
                       offline after the first clone, and is fast on every subsequent call.
                       Inspect and repair with \`wf cache\`.

  review workspace     A persistent bare workspace for reviewing pull requests from one repository.
                       Created once with \`wf review open\`; individual PRs are added as worktrees
                       with \`wf review checkout\`.

  shell integration    A wrapper function installed by \`eval "$(wf shell init zsh)"\` that intercepts
                       directory-changing commands and changes your shell's working directory, so
                       \`wf start\`, \`wf switch\`, \`wf finish\`, and \`wf delete\` update the
                       current shell automatically.

Git model:
  Change creation follows this sequence for each repository:
    1. Clone the remote as a bare mirror into \`~/.cache/workforest/\` if one does not exist.
       The clone uses \`--filter=blob:none\` to skip file blobs (fetched on demand).
    2. Create a git worktree from the mirror onto a new branch whose name is derived
       from the change name.
    3. Run \`pnpm install\` (or the configured installer) inside the worktree.
    4. Run the template hooks in the order they are defined.
  Steps 1-4 run in parallel across all repositories; \`wf status --watch\` shows progress.

See also:
  wf --help            Overview of all commands and examples
  wf help workflow     Recommended workflows for users and agents
  wf skills get core   Agent skill covering the full workspace lifecycle
`);
}

export function workflowPage(): string {
  return renderHelp(`
wf help workflow - Recommended workflows for users and agents.

Interactive user workflows:

  Start a single-repo change:
    wf start cli-redesign tomdale/workforest
    wf status
    cd ~/Code/Repos/workforest/cli-redesign
    # ... make changes, commit, open PR ...
    wf finish workforest/cli-redesign

  Start a template workspace:
    wf start auth-fix @vercel-agent
    wf status --watch                   # monitor background setup
    cd ~/Code/Workspaces/vercel-agent/auth-fix
    # ... work in the repos ...
    wf finish vercel-agent/auth-fix

  Start an _adhoc workspace:
    wf start update-docs-build vercel/next.js vercel/turbo
    wf status --watch           # monitor background setup; wait for READY
    cd ~/Code/Workspaces/_adhoc/update-docs-build/next.js
    # ... make changes, commit, open PRs ...
    wf finish _adhoc/update-docs-build

  Promote a repo change when it grows:
    wf switch workforest/cli-redesign
    wf add tomdale/workforest-docs --yes

  Try a second approach without losing the first:
    wf start try-different-approach

  Switch and inspect:
    wf switch                           # fuzzy-find a change
    wf switch workforest/cli-redesign
    wf list --group _adhoc --paths
    wf status workforest/cli-redesign

  Review a pull request:
    wf review open vercel/next.js       # one-time setup for this repo
    wf review checkout vercel/next.js#1234

  Add an isolated task inside an existing change:
    wf task start fix-auth              # new branch, instant setup
    cd _tasks/next.js/fix-auth          # or let shell integration cd there
    # ... experiment ...
    wf task finish fix-auth

  Create a workspace from a saved template:
    wf template manage                  # browse and edit templates
    wf start feature-description @my-template

Agent workflows:

  Orientation (do this first in every new session):
    wf skills get core --full           # complete lifecycle reference for agents

  Typical lifecycle:
    wf start <change> <repo...|@template>
    wf status --watch                   # confirm all repos are READY
    # work inside the worktrees using normal project tooling
    wf finish [selector]                # clean up after integration

  Adding to an existing change:
    wf switch <selector>
    wf add vercel/swr                   # add another repo mid-session

  Parallel work:
    wf task start <task>
    wf task list
    wf task finish <task>               # after integration
    wf task delete <task> --force       # abandoned or intentionally unmerged

  Inspection:
    wf list                             # list known changes
    wf switch                           # fuzzy-find a change (interactive)
    wf cache list                       # inspect cached mirrors
    wf cache check                      # diagnose mirror health

See also:
  wf --help            Overview of all commands and examples
  wf help concepts     The git model and glossary behind these commands
  wf skills get core   Full agent skill with annotated examples
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
  const description = group.description ? ` ${group.description}` : "";

  return renderHelp(`Usage: ${formatCommand(group.path)} ${subcommand}

${group.summary}.${description}

Subcommands:
${formatRows(children)}
`);
}

function leafHelp(leaf: CommandLeaf, path: readonly string[]): string {
  const usage = formatUsage(commandUsageLines(leaf, path));
  const description = leaf.description ? ` ${leaf.description}` : "";
  const argumentsSection = formatArgumentsSection(collectOperands(leaf));
  const options =
    leaf.flags.length === 0
      ? ""
      : `

Options:
${formatRows(
  leaf.flags.map((flag) => ({
    key: formatFlag(flag),
    description: flagDescription(flag),
  })),
)}`;
  const examples = formatExamplesSection(leaf.examples);

  return renderHelp(`${usage}

${leaf.summary}.${description}${argumentsSection}${options}${examples}
`);
}

function flagDescription(flag: FlagDefinition): string {
  if (flag.description) {
    return flag.description;
  }
  return flag.required ? "Required." : "Optional.";
}

/**
 * Collects the distinct described operands across all variants, in first-seen
 * order, so the Arguments section explains each positional argument once even
 * when it appears in several operand variants.
 */
function collectOperands(
  leaf: CommandLeaf,
): readonly Readonly<{ label: string; description: string }>[] {
  const described = new Map<string, string>();
  for (const variant of leaf.operands.variants) {
    for (const card of [variant.beforeDoubleDash, variant.afterDoubleDash]) {
      if (card?.description && !described.has(card.label)) {
        described.set(card.label, card.description);
      }
    }
  }
  return [...described].map(([label, description]) => ({ label, description }));
}

function formatArgumentsSection(
  args: readonly Readonly<{ label: string; description: string }>[],
): string {
  if (args.length === 0) {
    return "";
  }
  return `

Arguments:
${formatRows(
  args.map((arg) => ({ key: `<${arg.label}>`, description: arg.description })),
)}`;
}

function formatExamplesSection(examples: readonly CommandExample[]): string {
  if (examples.length === 0) {
    return "";
  }
  const body = examples
    .map((example) =>
      example.description
        ? `  ${example.command}\n      ${example.description}`
        : `  ${example.command}`,
    )
    .join("\n");
  return `

Examples:
${body}`;
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
    description: flagDescription(flag),
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

function wrapText(text: string, width: number): string {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current === "") {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") {
    lines.push(current);
  }
  return lines.join("\n");
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

      if (["Examples", "Start here (for AI agents)"].includes(section)) {
        const indented = line.match(/^(\s+)(\S.*)$/);
        if (indented) {
          const [, indent = "", rest = ""] = indented;
          // Command lines are indented two spaces; example outcome prose is
          // indented deeper and reads as a sentence, not a command.
          return indent.length >= 4
            ? `${indent}${styleDescription(rest)}`
            : `${indent}${styleExample(rest)}`;
        }
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
    /"[^"]*"|'[^']*'|(?:^|[\s,])--?[a-z][\w-]*|\b(?:wf|workforest)\b|(?:^|\s)(?:add|add-file|cache|checkout|config|confetti|copy|delete|dev|doctor|edit|eval|finish|get|info|init|list|manage|open|path|prune|repair|review|shell|show|simulate|skills|start|status|switch|task|template|update|version)(?=\s|$)|(?:^|\s)(?:\.{1,2}\/|[\w.-]+\/)\S+|\b\d+\b/gi,
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
