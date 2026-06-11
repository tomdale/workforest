import chalk from "chalk";
import { loadWorkspaceConfig } from "./config.ts";
import { getTemplatesDir, listTemplates } from "./templates/index.ts";
import { helpColor } from "./terminal/theme.ts";

export async function help(): Promise<string> {
  let configPath = "(unavailable)";
  try {
    configPath = (await loadWorkspaceConfig()).path;
  } catch {
    // Help remains available when configuration is missing or malformed.
  }

  const templatesDir = getTemplatesDir();
  const templates = await listTemplates();
  const templateLines =
    templates.length === 0
      ? ["(none)"]
      : templates.map(
          (template) =>
            `${template.id.padEnd(20)}  ${template.config.description ?? template.config.repos.join(", ")}`,
        );

  return renderHelp(`
Usage: wf <command> [options]

Start here (for AI agents):
  wf skills get core --full

Commands:
  workspace create|delete|open|list|status|add
                                Manage workspaces
  task create|list|delete       Manage workspace task worktrees
  worktree create|list|delete   Manage standalone worktrees
  cache list|info|path|add|update|doctor|repair|delete|prune|manage
                                Manage cached repositories
  review open|checkout          Open review repositories and pull requests
  template list|open|show|manage|new|edit|add-file|copy|delete
                                Manage workspace templates
  shell init                    Print shell integration
  config show|init|edit         Manage configuration
  skills list|get|path          Inspect bundled agent skills
  version                       Print the workforest version
  new                           Shortcut for workspace create
  clean                         Shortcut for workspace delete

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
  ${templateLines.join("\n  ")}

Config:     ${configPath}
Templates:  ${templatesDir}
`);
}

const COMMAND_HELP: Record<string, string> = {
  new: `Usage: wf new [options] <template|repo...> -- <work>

Shortcut for wf workspace create.
`,
  clean: `Usage: wf clean [options] <workspace>

Shortcut for wf workspace delete.
`,
  workspace: `Usage: wf workspace <subcommand>

Subcommands:
  create    Create a workspace
  delete    Delete an explicit workspace
  open      Open or search for a workspace
  list      List workspaces
  status    Show repository initialization status
  add       Add repositories to a workspace
`,
  task: `Usage: wf task <subcommand>

Subcommands:
  create    Create task worktrees
  list      List task worktrees
  delete    Delete explicit task worktrees
`,
  worktree: `Usage: wf worktree <subcommand>

Subcommands:
  create    Create a standalone worktree
  list      List standalone worktrees
  delete    Delete an explicit standalone worktree
`,
  cache: `Usage: wf cache <subcommand>

Subcommands:
  list      List cached repositories
  info      Show cached repository information
  path      Print a cache or mirror path
  add       Cache repositories
  update    Update cached repositories
  doctor    Check cache health
  repair    Repair cached repositories
  delete    Delete selected cached repositories
  prune     Delete unused cached repositories
  manage    Open the cache manager
`,
  review: `Usage: wf review <subcommand>

Subcommands:
  open <repo>           Open a review repository
  checkout <target...>  Check out a pull request
`,
  template: `Usage: wf template <subcommand>

Subcommands:
  list                 List templates
  open <name>          Open a template directory
  show <name>          Show template information
  manage               Open the template manager
  new <name> <repo...> Create a template
  edit <name>          Edit a template
  add-file <path...>   Add files to a template
  copy <source> <dest> Copy a template
  delete <name>        Delete a template
`,
  shell: `Usage: wf shell <subcommand>

Subcommands:
  init [shell]  Print shell integration for zsh or bash
`,
  config: `Usage: wf config [subcommand]

Subcommands:
  show  Print configuration
  init  Configure interactively
  edit  Open the configuration file
`,
  skills: `Usage: wf skills [subcommand] [options]

Subcommands:
  list                 List bundled skills
  get <name...>        Print skill content
  get --all            Print every visible skill
  path [name]          Print a skill path
`,
  version: `Usage: wf version

Print the workforest version.
`,
};

const NESTED_COMMAND_HELP: Record<string, Record<string, string>> = {
  workspace: {
    create: `Usage: wf workspace create [options] <template|repo...> -- <work>
       wf workspace create --like current [options] -- <work>

Options:
  --like current  Reuse the current workspace repositories and template
  -n, --dry-run   Preview without creating
`,
    delete: `Usage: wf workspace delete [options] <workspace>

Options:
  -r, --delete-remote-branches  Delete merged remote branches
  --delete-mirrors             Delete cached git mirrors
  -f, --force                  Skip confirmation
  -n, --dry-run                Preview without deleting
`,
    open: `Usage: wf workspace open [name] [--search]

Open a workspace by name or search interactively.
`,
    list: `Usage: wf workspace list

List workspaces in the configured default directory.
`,
    status: `Usage: wf workspace status [options]

Options:
  -w, --workspace <dir>  Inspect another workspace
  --json                 Print machine-readable status
`,
    add: `Usage: wf workspace add [options] <repo...>

Options:
  -w, --workspace <dir>  Workspace directory to update
  -n, --dry-run          Preview without adding repositories
`,
  },
  task: {
    create: `Usage: wf task create <slug...> [options]

Options:
  --repo <repo>  Owning workspace repository
  -n, --dry-run  Preview without changing files
  -f, --force    Allow a dirty source repository
`,
    list: `Usage: wf task list [options]

Options:
  --repo <repo>  Limit results to one workspace repository
`,
    delete: `Usage: wf task delete <slug...> [options]

Options:
  --repo <repo>  Owning workspace repository
  -n, --dry-run  Preview without deleting
  -f, --force    Skip confirmation
`,
  },
  worktree: {
    create: `Usage: wf worktree create <repo> <slug> [options]

Options:
  --dir <path>   Exact target path
  -n, --dry-run  Preview without changing files
`,
    list: `Usage: wf worktree list [repo]

List standalone worktrees.
`,
    delete: `Usage: wf worktree delete <path> [options]

Options:
  -n, --dry-run  Preview without deleting
  -f, --force    Skip confirmation
`,
  },
  cache: {
    list: `Usage: wf cache list [--json]

List cached repositories.
`,
    info: `Usage: wf cache info <repo> [--json]

Show cached repository information.
`,
    path: `Usage: wf cache path [repo]

Print the cache directory or one mirror path.
`,
    add: `Usage: wf cache add <repo...>

Cache repositories without creating worktrees.
`,
    update: `Usage: wf cache update [repo...]

Update selected repositories, or every cached repository.
`,
    doctor: `Usage: wf cache doctor [repo...] [--json]

Check cached repository health.
`,
    repair: `Usage: wf cache repair [repo...]

Repair selected repositories, or every cached repository.
`,
    delete: `Usage: wf cache delete <repo...> [options]

Options:
  -n, --dry-run  Preview without deleting
  -f, --force    Skip confirmation and allow active worktrees
`,
    prune: `Usage: wf cache prune [options]

Options:
  -n, --dry-run  Preview without deleting
  -f, --force    Skip confirmation
`,
    manage: `Usage: wf cache manage

Open the interactive cache manager.
`,
  },
  review: {
    open: `Usage: wf review open <repo>

Open a repository in the review workspace root.
`,
    checkout: `Usage: wf review checkout <target...>

Targets:
  <pr-number>
  <owner>/<repo> <pr-number>
  <owner>/<repo>#<pr-number>
  <github-pr-url>
`,
  },
  template: {
    list: `Usage: wf template list

List configured templates.
`,
    open: `Usage: wf template open <name>

Open a template directory.
`,
    show: `Usage: wf template show <name>

Show template information.
`,
    manage: `Usage: wf template manage

Open the interactive template manager.
`,
    new: `Usage: wf template new [options] <name> <repo...>

Options:
  -d, --description <text>  Template description
`,
    edit: `Usage: wf template edit <name>

Edit a template interactively.
`,
    "add-file": `Usage: wf template add-file [options] <path...>

Options:
  -t, --template <name>  Template to update
`,
    copy: `Usage: wf template copy <source> <destination>

Copy a template.
`,
    delete: `Usage: wf template delete [options] <name>

Options:
  -f, --force  Skip confirmation
`,
  },
  shell: {
    init: `Usage: wf shell init [shell]

Print shell integration for zsh or bash.
`,
  },
  config: {
    show: `Usage: wf config show

Print workforest configuration.
`,
    init: `Usage: wf config init

Configure workforest interactively.
`,
    edit: `Usage: wf config edit

Open the configuration file in $EDITOR.
`,
  },
  skills: {
    list: `Usage: wf skills list [--json]

List bundled skills.
`,
    get: `Usage: wf skills get [options] <name...>
       wf skills get --all [options]

Options:
  --all       Print every visible skill
  --full      Include references and templates
  --json      Print machine-readable JSON
`,
    path: `Usage: wf skills path [name] [--json]

Print the skills directory or one skill directory.
`,
  },
};

export function commandHelp(command: string): string | null {
  const content = COMMAND_HELP[command];
  return content ? renderHelp(content) : null;
}

export function nestedCommandHelp(
  command: string,
  subcommand: string,
): string | null {
  const content = NESTED_COMMAND_HELP[command]?.[subcommand];
  return content ? renderHelp(content) : null;
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
