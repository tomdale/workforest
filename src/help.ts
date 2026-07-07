import { commandRegistry } from "./cli/commands.ts";
import { commandFlags } from "./cli/effective-flags.ts";
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
import { annotateCommand, tokenize } from "./terminal/command-annotate.ts";
import { renderMarkdown } from "./terminal/markdown.ts";
import { compactHomePath } from "./terminal/paths.ts";
import {
  renderTerminalDocInline,
  type TerminalDoc,
  type TerminalLineInput,
  type TerminalSpan,
  terminalDoc,
  terminalSpan,
} from "./terminal/render-model.ts";

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
      term: "worktree",
      summary:
        "One repository on its own branch in its own directory — what you cd into and edit",
    },
    {
      term: "workspace",
      summary:
        "Several repositories branched and set up together under one piece of work",
    },
    {
      term: "task",
      summary:
        "A short-lived nested worktree inside a worktree or workspace, on its own branch",
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
  "workforest creates isolated worktrees and workspaces from cached repositories, so a feature can move one repo or several together without juggling branches in a single checkout.";

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
    configPath: compactHomePath(configPath),
    templatesDir: compactHomePath(templatesDir),
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
  wf skills get core

Commands:
${formatRows([...commands, ...shortcuts])}

Examples:
  wf new billing vercel/front vercel/api vercel/docs
  wf new docs vercel/next.js
  wf new follow-up
  wf switch
  wf status --watch
  wf task new fix-tests
  wf delete workforest/cli-redesign
  wf cache doctor
  wf review vercel/omniagent
  wf review vercel/omniagent#123
  wf template list
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
  worktree             One repository on its own branch in its own directory, under
                       \`Repos/<repo>/<name>\`. Created with \`wf new <name> <repo>\` — the thing
                       you cd into and edit. Entered with \`wf switch\`, inspected with \`wf list\`
                       and \`wf status\`, and removed with \`wf delete\`.

  workspace            Several repositories branched and set up together under one piece of work,
                       at \`Workspaces/<template>/<name>\` or \`Workspaces/_adhoc/<name>\`, with
                       metadata at \`.workforest/workspace.json\`. Created with
                       \`wf new <name> @<template>\` or \`wf new <name> <repo> <repo>\`.

  task                 A short-lived nested worktree inside a worktree or workspace, on its own
                       branch. Created with \`wf task new\` from inside one. Tasks skip setup by
                       default for fast handoff; pass \`--setup\` when dependencies and repository
                       initializers should run before use. Remove with
                       \`wf task delete\` (pass --force to abandon unmerged work).

  template             A saved workspace recipe: a list of repositories plus optional hooks, extra
                       files, and a branch prefix. Stored under
                       \`~/.config/workforest/templates/<name>/template.jsonc\`.
                       Create and edit with \`wf template\` subcommands.

  cached mirror        A bare local clone of a remote repository kept under \`~/.cache/workforest/\`.
                       All worktrees are built from these mirrors, so creation works offline after
                       the first clone, and is fast on every subsequent call.
                       Inspect and repair with \`wf cache list\` and \`wf cache doctor\`.

  review workspace     A persistent bare workspace for reviewing pull requests from one repository.
                       Created with \`wf review <repo>\`; individual PRs are added as worktrees
                       with \`wf review <repo>#<number>\`.

  shell integration    A wrapper function installed by \`eval "$(wf shell init zsh)"\` that intercepts
                       directory-changing commands and changes your shell's working directory, so
                       \`wf new\`, \`wf switch\`, and \`wf delete\` update the current shell
                       automatically.

Git model:
  Creating a worktree or workspace follows this sequence for each repository:
    1. Clone the remote as a bare mirror into \`~/.cache/workforest/\` if one does not exist.
       The clone uses \`--filter=blob:none\` to skip file blobs (fetched on demand).
    2. Create a git worktree from the mirror onto a new branch whose name is derived
       from the name you gave.
    3. Run \`pnpm install\` (or the configured installer) inside the worktree.
    4. Run the template hooks in the order they are defined.
  Steps 1-4 run in parallel across all repositories; \`wf status --watch\` shows progress.

See also:
  wf --help            Overview of all commands and examples
  wf help workflow     Recommended workflows for users and agents
  wf help templates    What templates are and how to build them
  wf skills get core   Agent skill covering the full workspace lifecycle
`);
}

export function templatesPage(): string {
  return renderHelp(`
wf help templates - What templates are, and how to create and use them.

Overview:
  A template is a saved recipe for a workspace: the repositories to check out,
  plus any hooks, branch prefix, and files they should start with. Save that
  setup once, then create a ready-to-work workspace from it with a single
  command, \`wf new <name> @<template>\`, instead of cloning several repositories
  and wiring them together by hand. Reach for a template whenever you keep coming
  back to the same group of repositories.

What a template holds:
  repositories         The repositories the workspace is built from. The only required part.
  hooks                Optional commands run after each repository is set up, for dependency
                       installs, codegen, and other one-time setup.
  branch prefix        An optional prefix for the branch created in each repository,
                       overriding the global \`branchPrefix\`.
  bundled files        Optional files copied into every new workspace, added with
                       \`wf template add-file\`.

  Each template is stored as JSONC at
  \`~/.config/workforest/templates/<name>/template.jsonc\` and can also be edited by hand.

Creating and maintaining templates:
  wf template new       Save a template from a name and one or more repositories.
  wf template suggest   Propose templates from your recent GitHub pull request activity.
  wf template edit      Change a template's repositories, hooks, and branch prefix.
  wf template add-file  Bundle files that every new workspace should start with.
  wf template variant   Derive a variant that overrides only part of a parent template.

Inspecting templates:
  wf template list      List saved templates and where they live on disk.
  wf template show      Print one template's repositories, hooks, and branch prefix.
  wf template open      Open a template's directory to edit its files directly.

See also:
  wf template --help              Every template subcommand, with flags and examples
  wf skills get create-templates  Step-by-step guidance for authoring a good template
  wf help concepts                Where templates fit among workforest's core concepts
`);
}

export function workflowPage(): string {
  return renderHelp(`
wf help workflow - Recommended workflows for users and agents.

Interactive user workflows:

  Create a worktree (single repo):
    wf new cli-redesign tomdale/workforest
    wf status
    cd ~/Code/Repos/workforest/cli-redesign
    # ... make changes, commit, open PR ...
    wf delete workforest/cli-redesign   # after it merges

  Create a workspace from a template:
    wf new auth-fix @vercel-agent
    wf status --watch                   # monitor background setup
    cd ~/Code/Workspaces/vercel-agent/auth-fix
    # ... work in the repos ...
    wf delete vercel-agent/auth-fix

  Create an _adhoc workspace:
    wf new update-docs-build vercel/next.js vercel/turbo
    wf status --watch           # monitor background setup; wait for READY
    cd ~/Code/Workspaces/_adhoc/update-docs-build/next.js
    # ... make changes, commit, open PRs ...
    wf delete _adhoc/update-docs-build

  Promote a worktree into a workspace when it grows:
    wf switch workforest/cli-redesign
    wf add tomdale/workforest-docs --yes

  Try a second approach without losing the first:
    wf new try-different-approach

  Switch and inspect:
    wf switch [query]                   # fuzzy-find a worktree or workspace
    wf switch workforest/cli-redesign
    wf list --group _adhoc --paths
    wf status workforest/cli-redesign

  Review a pull request:
    wf review vercel/next.js            # one-time setup for this repo
    wf review vercel/next.js#1234

  Add an isolated task inside an existing worktree or workspace:
    wf task new fix-auth                # new branch, setup skipped
    wf task new --setup fix-auth        # new branch with full setup
    cd _tasks/next.js/fix-auth          # or let shell integration cd there
    # ... experiment ...
    wf task delete fix-auth             # after it merges

  Create a workspace from a saved template:
    wf template list                      # browse templates
    wf new feature-description @my-template

Agent workflows:

  Orientation (do this first in every new session):
    wf skills get core                  # complete lifecycle reference for agents

  Typical lifecycle:
    wf new <name> <repo...|@template>
    wf status --watch                   # confirm all repos are READY
    # work inside the worktrees using normal project tooling
    wf delete [selector]                # clean up after integration

  Adding to an existing workspace:
    wf switch <query>
    wf add vercel/swr                   # add another repo mid-session

  Parallel work:
    wf task new <task>
    wf task list
    wf task delete <task>               # after integration
    wf task delete <task> --force       # abandoned or intentionally unmerged

  Inspection:
    wf list                             # list worktrees and workspaces
    wf switch [query]                   # fuzzy-find one (interactive)
    wf cache list                       # inspect cached mirrors
    wf cache doctor                     # diagnose mirror health

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
  const options = commandFlags(leaf).length > 0 ? " [options]" : "";
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
  // The Usage line already names the command, so the body opens with the
  // Markdown description; the summary (used in the root command list) is only a
  // fallback when a group has no description.
  const description = group.description ?? `${group.summary}.`;
  const examples = formatExamplesSection(group.examples ?? []);

  return joinBlocks([
    renderHelp(`Usage: ${formatCommand(group.path)} ${subcommand}`),
    renderMarkdownInline(description),
    renderHelp(`Subcommands:\n${formatRows(children)}${examples}`),
  ]);
}

function leafHelp(leaf: CommandLeaf, path: readonly string[]): string {
  const usage = formatUsage(commandUsageLines(leaf, path));
  const description = leaf.description ?? `${leaf.summary}.`;
  const argumentsSection = formatArgumentsSection(collectOperands(leaf));
  const flags = commandFlags(leaf);
  const options =
    flags.length === 0
      ? ""
      : `

Options:
${formatRows(
  flags.map((flag) => ({
    key: formatFlag(flag),
    description: flagDescription(flag),
  })),
)}`;
  const examples = formatExamplesSection(leaf.examples);

  return joinBlocks([
    renderHelp(usage),
    renderMarkdownInline(description),
    renderHelp(`${argumentsSection}${options}${examples}`),
  ]);
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
  const flags = commandFlags(target);
  const options =
    flags.length === 0
      ? ""
      : `

Options:
${formatRows(
  flags.map((flag) => ({
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
  return stripMarkdownCodeDelimiters(renderInlineDoc(helpDoc(content)));
}

export function helpDoc(content: string): TerminalDoc {
  const lines = content.trim().split("\n");
  let section = "";

  return terminalDoc(
    lines.map((line) => {
      const usage = line.match(/^(\s*)(Usage:|\s{7})(.*)$/);
      if (usage) {
        const [, indent = "", label = "", syntax = ""] = usage;
        return [
          indent,
          ...(label.trim()
            ? helpHeading(label)
            : [terminalSpan(" ".repeat(label.length))]),
          ...styleCommandSyntax(syntax),
        ];
      }

      // A left-aligned line ending in a colon is a section heading
      // ("Subcommands:", "See also:"). A prose sentence that happens to end in
      // a colon — a list lead-in like "... It bundles:" — is not; those contain
      // a period, which section labels never do.
      const heading = line.match(/^([^ ].*):$/);
      if (heading && !line.includes(".")) {
        section = heading[1] ?? "";
        return helpHeading(line);
      }

      const continuation = line.match(/^(\s{4,})(\S.*)$/);
      if (
        continuation &&
        !["Examples", "Start here (for AI agents)"].includes(section)
      ) {
        const [, indent = "", rest = ""] = continuation;
        return [indent, ...styleDescription(rest)];
      }

      const row = line.match(/^(\s+)(.*?\S)(\s{2,})(\S.*)$/);
      if (row) {
        const [, indent = "", key = "", gap = "", description = ""] = row;
        return [
          indent,
          ...styleRowKey(key, section),
          gap,
          ...styleDescription(description),
        ];
      }

      if (["Examples", "Start here (for AI agents)"].includes(section)) {
        const indented = line.match(/^(\s+)(\S.*)$/);
        if (indented) {
          const [, indent = "", rest = ""] = indented;
          // Command lines are indented two spaces; example outcome prose is
          // indented deeper and reads as a sentence, not a command.
          return indent.length >= 4
            ? [indent, ...styleDescription(rest)]
            : [indent, ...styleExample(rest)];
        }
      }

      const metadata = line.match(/^([A-Z][^:]+:)(\s+)(.+)$/);
      if (metadata) {
        const [, label = "", gap = "", value = ""] = metadata;
        return [terminalSpan(`${label}${gap}${value}`, { role: "muted" })];
      }

      const title = line.match(/^(wf(?:\s+\S+)*)(\s+-\s+)(.+)$/);
      if (title) {
        const [, command = "", separator = "", description = ""] = title;
        return [
          ...styleCommandSyntax(command),
          terminalSpan(separator, { role: "muted" }),
          ...styleDescription(description),
        ];
      }

      const indentedText = line.match(/^(\s+)(.*)$/);
      if (indentedText) {
        const [, indent = "", rest = ""] = indentedText;
        return [indent, ...styleDescription(rest)];
      }

      return styleDescription(line);
    }),
  );
}

function helpHeading(value: string): TerminalSpan[] {
  return [terminalSpan(value, { role: "accent", emphasis: "bold" })];
}

function styleCommandSyntax(value: string): TerminalLineInput {
  return annotateCommand(value);
}

function styleOptionSyntax(value: string): TerminalLineInput {
  return annotateCommand(value, { colorBareWords: false });
}

function styleRowKey(value: string, section: string): TerminalLineInput {
  if (value.includes("`")) {
    return styleDescription(value);
  }
  if (section === "Options") {
    return styleOptionSyntax(value);
  }
  if (["Examples", "Start here (for AI agents)"].includes(section)) {
    return styleExample(value);
  }
  return styleCommandSyntax(value);
}

function styleExample(value: string): TerminalLineInput {
  return tokenize(
    value,
    /"[^"]*"|'[^']*'|(?:^|[\s,])--?[a-z][\w-]*|\b(?:wf|workforest)\b|(?:^|\s)(?:add|add-file|cache|checkout|config|confetti|copy|delete|dev|doctor|edit|eval|get|info|init|list|manage|new|open|path|prune|repair|review|shell|show|simulate|skills|status|switch|task|template|update|version|worktree)(?=\s|$)|(?:^|\s)(?:\.{1,2}\/|[\w.-]+\/)\S+|\b\d+\b/gi,
    (token) => {
      const normalized = token.trimStart();
      const prefix = token.slice(0, token.length - normalized.length);

      if (normalized === "wf" || normalized === "workforest") {
        return [prefix, terminalSpan(normalized, { role: "command" })];
      }
      if (normalized.startsWith("-")) {
        return [prefix, terminalSpan(normalized, { role: "warning" })];
      }
      if (
        normalized.startsWith('"') ||
        normalized.startsWith("'") ||
        /^\d+$/.test(normalized) ||
        normalized.includes("/")
      ) {
        return [prefix, terminalSpan(normalized, { role: "accent" })];
      }
      return [prefix, terminalSpan(normalized, { role: "subcommand" })];
    },
  );
}

function styleDescription(value: string): TerminalLineInput {
  return tokenize(
    value,
    /\\?`[^`]+\\?`|\([^)]*(?:default|none|current)[^)]*\)|\$[A-Z][A-Z0-9_]*/gi,
    (token) => {
      if (token.includes("`")) {
        return styleInlineCode(token.replace(/^\\?`|\\?`$/g, ""));
      }
      return [terminalSpan(token, { role: "muted" })];
    },
  );
}

function styleInlineCode(value: string): TerminalLineInput {
  if (/^(?:wf|workforest)(?:\s|$)/.test(value)) {
    return styleCommandSyntax(value);
  }
  return [terminalSpan(value, { role: "accent" })];
}

function renderInlineDoc(doc: TerminalDoc): string {
  return renderTerminalDocInline(doc);
}

/** Render a Markdown `description` to a themed, inline (non-fullscreen) string. */
function renderMarkdownInline(markdown: string): string {
  return renderInlineDoc(renderMarkdown(markdown));
}

/** Join already-rendered help sections with a blank line, dropping empties. */
function joinBlocks(blocks: readonly string[]): string {
  return blocks.filter((block) => block.trim().length > 0).join("\n\n");
}

function stripMarkdownCodeDelimiters(value: string): string {
  return value.replace(/\\?`([^`]+)\\?`/g, "$1");
}
