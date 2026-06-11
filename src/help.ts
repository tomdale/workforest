import chalk from "chalk";
import { loadWorkspaceConfig } from "./config.ts";
import { getTemplatesDir, listTemplates } from "./templates/index.ts";
import { helpColor } from "./terminal/theme.ts";

export async function help(): Promise<string> {
  let configPath = "(unavailable)";
  try {
    const loaded = await loadWorkspaceConfig();
    configPath = loaded.path;
  } catch {
    // Ignore errors
  }

  const templatesDir = getTemplatesDir();
  const templates = await listTemplates();
  const templateLines =
    templates.length === 0
      ? ["(none)"]
      : templates.map(
          (t) =>
            `${t.id.padEnd(20)}  ${t.config.description ?? t.config.repos.join(", ")}`,
        );

  return renderHelp(`
Usage: wf <command> [options]

Start here (for AI agents):
  wf skills get core --full

Commands:
  new <template|repo...> -- <work>  Create a workspace
  status                       Monitor background repository initialization
  worktree <slug...>           Create temporary worktree(s) in a workspace repo
  worktree new <repo> <name>   Create a managed single-repo worktree
  worktree promote             Promote a managed worktree to a workspace
  worktree list|delete         List or delete contextual worktrees
  review <target>              Create a review workspace or PR worktree
  review list|delete           List or delete PR review worktrees
  delete                       Infer and delete current tracked resource
  workspace delete [dir]       Delete a workspace
  wt                           Alias for worktree
  cd <name>                    Jump to a workspace in defaultDir
  find                         Fuzzy-find and jump to a workspace
  add <repo...>                Add repo(s) to an existing workspace
  fork <name>                  Fork current workspace with new branches
  clean [dir]                  Alias for workspace delete
  list                         List workspaces
  skills list|get|path         List and retrieve bundled agent skills
  init [shell]                 Print shell integration for auto-cd and completion
  templates                    Open the template manager TUI
  template list|show|info|...  Scriptable template subcommands
  repositories                 Open the cached repository manager TUI
  repository list|info|...     Scriptable cache management subcommands
  config [show|edit|init]      Manage configuration

Clean options:
  -r, --delete-remote-branches  Delete merged remote branches (prompts if not set)
  -f, --force                  Skip confirmation prompts
  -n, --dry-run                Preview without deleting
  --keep-mirrors               Keep cached git mirrors (default: true)

Examples:
  wf new vercel/next.js vercel/turbo -- "update docs build"
  wf status
  wf status retry front
  wf worktree "fix-tests" "upgrade-deps"
  wf worktree new next.js "fix-auth"
  wf worktree promote full-stack vercel/swr
  wf worktree list
  wf worktree delete "fix-tests"
  wf review vercel/omniagent 123
  wf review delete vercel/omniagent#123 --dry-run
  wf worktree next.js "fix-auth"
  wf wt next.js "fix-auth" --dir ../next.js-fix-auth
  wf new --dry-run my-template -- "fixing auth"
  wf cd fix-auth-bug                Jump into an existing workspace
  wf find                           Fuzzy-find a workspace to open
  wf add vercel/swr                Add a repo from inside a workspace
  wf add vercel/swr -w ./my-ws     Add a repo to a specific workspace
  wf fork "new approach"            Fork workspace with new branch names
  eval "$(wf init zsh)"            Auto-cd + zsh completion for workspace commands
  wf list                           Show all workspaces
  wf delete                         Infer and delete the current resource
  wf workspace delete               Delete current workspace (self-destruct)
  wf workspace delete ./my-workspace -r
  wf templates                      Open the template manager
  wf template new "oss-docs" vercel/next.js vercel/turbo
  wf repositories                   Open the cached repository manager
  wf repository doctor              Check every cached mirror
  wf repository clean --dry-run     Preview unused mirror cleanup

Templates:
  ${templateLines.join("\n  ")}

Config:     ${configPath}
Templates:  ${templatesDir}
`);
}

const COMMAND_HELP: Record<string, string> = {
  new: `Usage: wf new [options] <template|repo...> -- <name-or-description>

Create a workspace from one or more repositories or templates.
Repository arguments may be owner/repo slugs, git URLs, or unique names from
the repository cache.

Options:
  -n, --dry-run    Preview without creating a workspace
  -h, --help       Show this help

Examples:
  wf new vercel/next.js vercel/turbo -- "update docs build"
  wf new --dry-run my-template -- "fixing auth"
  wf new
`,

  status: `Usage: wf status [options]
       wf status cancel [repo...]
       wf status retry [repo...]

Show repository initialization progress for the current workspace. In an
interactive terminal, opens a live pane for each repository. Without repository
arguments, cancel and retry apply to every eligible repository.

Options:
  -w, --workspace <dir>  Inspect a workspace outside the current directory
  --json                  Print machine-readable status
  -h, --help              Show this help

Examples:
  wf status
  wf status --json
  wf status cancel front
  wf status retry front
`,

  worktree: `Usage: wf worktree <repo> <slug> [options]
       wf worktree <slug...> [options]
       wf worktree new <repo> <name> [options]
       wf worktree new <name> [options]
       wf worktree promote [template] [repo...] [options]
       wf worktree list [options]
       wf worktree delete [slug...] [options]

Create, list, or delete worktrees. Inside a workforest workspace, slug-only
creation makes temporary worktrees tracked in workspace metadata. Managed
single-repo worktrees live under defaultDir/<repo>/<name>; from one of those
checkouts, slug-only creation, list, and delete operate on its siblings.
Promotion converts the current managed checkout into a normal workspace.
Legacy standalone repository arguments may use unique cached names.

Options:
  --dir <path>     Target path for standalone worktree creation
  --repo <repo>    Workspace repo name for temporary worktree operations
  -n, --dry-run    Preview without changing files
  -f, --force      Skip confirmation prompts where supported
  -h, --help       Show this help

Examples:
  wf worktree next.js fix-auth --dir ../next.js-fix-auth
  wf worktree new next.js fix-auth
  wf worktree promote full-stack vercel/swr
  wf worktree fix-tests
  wf worktree list --repo front
  wf worktree delete fix-tests --dry-run
`,

  wt: `Usage: wf wt <repo> <slug> [options]
       wf wt <slug...> [options]
       wf wt new <repo> <name> [options]
       wf wt promote [template] [repo...] [options]
       wf wt list [options]
       wf wt delete [slug...] [options]

Alias for wf worktree.

Options:
  --dir <path>     Target path for standalone worktree creation
  --repo <repo>    Workspace repo name for temporary worktree operations
  -n, --dry-run    Preview without changing files
  -f, --force      Skip confirmation prompts where supported
  -h, --help       Show this help
`,

  review: `Usage: wf review <owner>/<repo>
       wf review <pr-number>
       wf review <owner>/<repo> <pr-number>
       wf review <owner>/<repo>#<pr-number>
       wf review <github-pr-url>
       wf review list [repo]
       wf review delete <target> [options]

Create, list, or remove GitHub review workspaces and PR worktrees. Numeric-only
PR targets infer the repo from the current review workspace. Repository targets
may use unique cached names instead of owner/repo.

Options:
  -n, --dry-run    Preview review removal without deleting
  -f, --force      Skip prompts and remove dirty review worktrees
  -h, --help       Show this help

Examples:
  wf review vercel/omniagent
  wf review 123
  wf review vercel/omniagent 123
  wf review vercel/omniagent#123
  wf review https://github.com/vercel/omniagent/pull/123
  wf review list omniagent
  wf review delete vercel/omniagent#123 --force
`,

  delete: `Usage: wf delete [options] [workspace-dir]

Infer and delete the current tracked resource.

From inside a temporary worktree, deletes that temporary worktree.
From inside a review worktree, deletes that review worktree.
From inside a standalone worktree, deletes that worktree.
From inside a workspace, deletes that workspace.
With a path argument, deletes that workspace path.

Options:
  -r, --delete-remote-branches  Delete merged remote branches for workspaces
  -f, --force                   Skip confirmation prompts
  -n, --dry-run                 Preview without deleting
  --keep-mirrors                Keep cached git mirrors for workspaces
  -h, --help                    Show this help
`,

  cd: `Usage: wf cd [name]

Jump to an existing workspace. With no name in an interactive terminal, opens a
workspace picker. Names resolve against defaultDir and dirPrefix.

Options:
  -h, --help       Show this help

Examples:
  wf cd fix-auth-bug
  wf cd
`,

  find: `Usage: wf find

Fuzzy-find and jump to a workspace from defaultDir.

Options:
  -h, --help       Show this help
`,

  add: `Usage: wf add [options] <repo...>

Add repositories to an existing workspace. Run from inside a workspace or pass
--workspace. Repositories may be owner/repo slugs, git URLs, or unique cached
names.

Options:
  -w, --workspace <dir>  Workspace directory to update
  -n, --dry-run          Preview without adding repositories
  -h, --help             Show this help

Examples:
  wf add vercel/swr
  wf add vercel/swr -w ./my-workspace
`,

  fork: `Usage: wf fork [options] <name-or-description>

Create a sibling workspace from the current workspace with new branch names.

Options:
  -d, --description <text>  Description to convert into a feature name
  -n, --dry-run             Preview without creating a workspace
  -h, --help                Show this help

Examples:
  wf fork new-approach
  wf fork --description "try a different cache strategy"
`,

  workspace: `Usage: wf workspace delete [options] [dir]

Manage workspaces.

Subcommands:
  delete, rm [dir]  Delete a workspace

Options:
  -h, --help        Show this help
`,

  clean: `Usage: wf clean [options] [dir]

Alias for wf workspace delete.

Options:
  -r, --delete-remote-branches  Delete merged remote branches
  -f, --force                   Skip confirmation prompts
  -n, --dry-run                 Preview without deleting
  --keep-mirrors                Keep cached git mirrors
  -h, --help                    Show this help

Examples:
  wf workspace delete
  wf workspace delete ./my-workspace --dry-run
  wf workspace delete ./my-workspace -r
`,

  list: `Usage: wf list

List workspaces in the configured defaultDir.

Aliases:
  wf ls

Options:
  -h, --help       Show this help
`,

  ls: `Usage: wf ls

Alias for wf list.

Options:
  -h, --help       Show this help
`,

  init: `Usage: wf init [shell]

Print shell integration for auto-cd and completion.

Arguments:
  shell            zsh or bash. Defaults to the current SHELL.

Options:
  -h, --help       Show this help

Examples:
  eval "$(wf init zsh)"
  eval "$(wf init bash)"
`,

  templates: `Usage: wf templates

Open the interactive template manager when running in a capable terminal.
In non-interactive output, prints the configured template list.

Shortcuts:
  j/k, arrows    Navigate templates
  enter, e       Edit selected template
  n              Create a template
  c              Copy selected template
  d              Delete selected template
  o              Jump to template directory
  /              Search
  r              Reload
  q              Quit

Options:
  -h, --help     Show this help
`,

  template: `Usage: wf template [subcommand]

Manage workspace templates.

With no subcommand in an interactive terminal, opens the template manager.

Subcommands:
  list, ls                  List templates
  show <name>               Jump to a template directory
  info <name>               Print template details
  new, create <name> <repo...>
                            Create a template
  edit <name>               Edit a template interactively
  add-file [options] <path...>
                            Add file(s) or directories to a template
  copy, cp <source> <dest>  Copy a template
  delete, rm <name>         Delete a template

Options:
  -h, --help                Show this help
`,

  config: `Usage: wf config [subcommand]

Manage workforest configuration.

Subcommands:
  show      Print configuration (default)
  init      Configure interactively
  edit      Open the config file in $EDITOR

Options:
  -h, --help  Show this help
`,

  dev: `Usage: wf dev simulate <flow> [options]

Development helpers for exercising workforest UI flows.

Flows:
  new       Run the synthetic wf new UI simulation
  confetti  Show the completion confetti modal

Options:
  -h, --help  Show this help
`,

  skills: `wf skills - List and retrieve bundled skill content

Usage: wf skills [subcommand] [options]

Subcommands:
  list                       List all available skills (default)
  get <name> [name...]       Output a skill's full content
  get --all                  Output every visible skill
  path [name]                Print filesystem path to skill directory

Options:
  --full                     Include references and templates for get
  --json                     Print machine-readable JSON
  -h, --help                 Show this help

Examples:
  wf skills
  wf skills get core
  wf skills get parallel-worktrees --full
  wf skills path core
`,

  repositories: `Usage: wf repositories

Open the interactive cached repository manager. Outside an interactive terminal,
prints the repository list instead.

Aliases:
  wf repos

Options:
  -h, --help  Show this help
`,

  repos: `Usage: wf repos

Alias for wf repositories.
`,

  repository: `Usage: wf repository <subcommand> [options]

Inspect and manage cached bare Git mirrors.

Subcommands:
  list                         List cached repositories and disk usage
  info <repo>                  Show mirror health, identity, and worktrees
  path [repo]                  Print the cache or mirror path
  add <repo...>                Warm the cache for repositories
  update [repo...]             Fetch one, many, or all cached repositories
  doctor [repo...]             Check cache health
  repair [repo...]             Prune stale metadata and verify objects
  delete <repo...>             Delete selected mirrors
  clean                        Delete mirrors with no active worktrees

Aliases:
  wf repo

Options:
  -h, --help  Show this help
`,

  repo: `Usage: wf repo <subcommand> [options]

Alias for wf repository.
`,

  version: `Usage: wf version

Print the workforest version.

Aliases:
  wf --version
  wf -V
`,
};

const NESTED_COMMAND_HELP: Record<string, Record<string, string>> = {
  status: {
    cancel: `Usage: wf status cancel [repo...]

Cancel selected background repository initializers. With no repositories,
cancels every initializer that is currently queued or running.
`,
    retry: `Usage: wf status retry [repo...]

Retry selected failed or cancelled repository initializers. With no
repositories, retries every eligible initializer.
`,
  },

  review: {
    list: `Usage: wf review list [repo]

List known review worktrees and stale entries.

Options:
  -h, --help     Show this help
`,
    delete: `Usage: wf review delete <target> [options]

Delete a PR review worktree.

Options:
  -n, --dry-run  Preview without deleting
  -f, --force    Skip prompts and remove dirty worktrees
  -h, --help     Show this help
`,
  },

  worktree: {
    new: `Usage: wf worktree new <repo> <name> [options]
       wf worktree new <name> [options]

Create a managed single-repository worktree at defaultDir/<repo>/<name>.
The contextual form uses the current managed worktree's repository. The new
branch starts from the remote default branch and built-in initializers run with
the checkout as both repository and workspace context.

Options:
  -n, --dry-run  Preview without changing files
  -h, --help     Show this help
`,
    promote: `Usage: wf worktree promote [template] [repo...] [options]

Promote the current managed single-repository worktree into a normal workspace.
The checkout moves to defaultDir/<dirPrefix><name>/<repo>, keeps its branch and
uncommitted changes, and becomes the first workspace repository. At most one
template may be supplied. Additional repositories use the current branch.

Options:
  -n, --dry-run  Preview without changing files
  -h, --help     Show this help
`,
    list: `Usage: wf worktree list [options]

List temporary worktrees tracked by the current workspace, or managed sibling
worktrees when run from a managed single-repository checkout.

Options:
  --repo <repo>  Limit results to one workspace repo
  -h, --help     Show this help
`,
    delete: `Usage: wf worktree delete [slug...] [options]

Delete temporary worktrees tracked by the current workspace, managed sibling
worktrees, or standalone worktrees outside those contexts.
When run inside a temporary worktree, the slug defaults to the current worktree.

Options:
  --repo <repo>  Remove worktrees for one workspace repo
  -n, --dry-run  Preview without deleting
  -f, --force    Skip confirmation prompts
  -h, --help     Show this help
`,
  },

  workspace: {
    delete: `Usage: wf workspace delete [options] [dir]

Delete a workspace. If run inside a workspace with no dir, deletes the current
workspace.

Options:
  -r, --delete-remote-branches  Delete merged remote branches
  -f, --force                   Skip confirmation prompts
  -n, --dry-run                 Preview without deleting
  --keep-mirrors                Keep cached git mirrors
  -h, --help                    Show this help
`,
  },

  template: {
    list: `Usage: wf template list

List configured templates.

Aliases:
  wf template ls
`,
    show: `Usage: wf template show <name>

Jump to a template directory.
`,
    info: `Usage: wf template info <name>

Print template details, repositories, hooks, branch prefix, and location.
`,
    new: `Usage: wf template new [options] <name> <repo...>

Create a template from repository slugs, git URLs, or unique cached names.

Aliases:
  wf template create

Options:
  -d, --description <text>  Template description
  -h, --help                Show this help
`,
    edit: `Usage: wf template edit <name>

Edit a template interactively.
`,
    "add-file": `Usage: wf template add-file [options] <path...>

Add a file or directory from the current workspace to the files/ directory of
the template that created the workspace. The path is copied at the same path
relative to the workspace root, so future workspaces from that template receive
it there.

When --template is passed, add files to that template instead. You may also pass
the template as the first positional argument: wf template add-file <template>
<path...>. Outside a workspace, paths are copied relative to the current
directory.

Options:
  -t, --template <name>  Template to update
  -h, --help             Show this help
`,
    copy: `Usage: wf template copy <source> <destination>

Copy an existing template to a new template id.

Aliases:
  wf template cp
`,
    delete: `Usage: wf template delete [options] <name>

Delete a template.

Aliases:
  wf template rm

Options:
  -f, --force  Skip confirmation prompts
  -h, --help   Show this help
`,
  },

  repository: {
    list: `Usage: wf repository list [--json]

List cached repositories, health, disk usage, and active worktree counts.
`,
    info: `Usage: wf repository info <repo> [--json]

Show a cached repository's identity, health, disk usage, and worktrees.
`,
    path: `Usage: wf repository path [repo]

Print the cache directory, or one cached mirror path. Output is undecorated for
shell composition.
`,
    add: `Usage: wf repository add <repo...>

Clone or update repositories in the cache without creating worktrees.
Existing repositories may be specified by a unique cached name.

Aliases:
  wf repository cache
`,
    update: `Usage: wf repository update [repo...]

Fetch and prune selected cached repositories. With no repositories, updates all.

Aliases:
  wf repository fetch
`,
    doctor: `Usage: wf repository doctor [repo...] [--json]

Inspect selected cached repositories, or all repositories when none are given.
Exits with status 1 when a mirror needs attention.

Aliases:
  wf repository check
`,
    repair: `Usage: wf repository repair [repo...]

Prune stale worktree registrations and verify object connectivity. With no
repositories, repairs all cached mirrors.
`,
    delete: `Usage: wf repository delete <repo...> [options]

Delete selected cached mirrors. Mirrors with active worktrees require --force.

Aliases:
  wf repository rm
  wf repository remove

Options:
  -n, --dry-run  Preview without deleting
  -f, --force    Skip confirmation and allow active worktrees
`,
    clean: `Usage: wf repository clean [options]

Delete every cached mirror with no active worktrees.

Aliases:
  wf repository prune

Options:
  -n, --dry-run  Preview without deleting
  -f, --force    Skip confirmation
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

Open the config file in $EDITOR.
`,
  },

  dev: {
    simulate: `Usage: wf dev simulate <flow> [options]

Run synthetic development UI simulations.

Flows:
  new       Run the synthetic wf new UI simulation
  confetti  Show the completion confetti modal
`,
  },

  skills: {
    list: `Usage: wf skills list [--json]

List all available skills.
`,
    get: `Usage: wf skills get [options] <name...>
       wf skills get --all [options]

Output skill content.

Options:
  --all      Output every visible skill
  --full     Include references and templates
  --json     Print machine-readable JSON
  -h, --help Show this help
`,
    path: `Usage: wf skills path [name] [--json]

Print the skills directory path, or one skill's directory.
`,
  },
};

type DevSimulationFlow = "simulate" | "new" | "confetti";

const DEV_SIMULATION_HELP: Record<DevSimulationFlow, string> = {
  simulate: `Usage: wf dev simulate <flow> [options]

Flows:
  new       Run the synthetic wf new UI simulation
  confetti  Show the completion confetti modal
`,
  new: `Usage: wf dev simulate new [options]

Options:
  --fail-repo <name>  Mark one synthetic repo setup as failed
  --speed <speed>     fast, normal, or slow (default: normal)
`,
  confetti: `Usage: wf dev simulate confetti [options]

Options:
  --workspace <path>  Workspace path to show in the modal
  --repos <names>     Comma-separated worktree names
`,
};

const NESTED_ALIASES: Record<string, Record<string, string>> = {
  worktree: {
    ls: "list",
    rm: "delete",
    remove: "delete",
  },
  review: {
    ls: "list",
    rm: "delete",
    remove: "delete",
  },
  workspace: {
    rm: "delete",
    remove: "delete",
  },
  template: {
    ls: "list",
    create: "new",
    rm: "delete",
    cp: "copy",
  },
  repository: {
    ls: "list",
    cache: "add",
    fetch: "update",
    check: "doctor",
    rm: "delete",
    remove: "delete",
    prune: "clean",
  },
  dev: {
    sim: "simulate",
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
  const canonical = NESTED_ALIASES[command]?.[subcommand] ?? subcommand;
  const content = NESTED_COMMAND_HELP[command]?.[canonical];
  return content ? renderHelp(content) : null;
}

export function devSimulationHelp(flow: DevSimulationFlow): string {
  return renderHelp(DEV_SIMULATION_HELP[flow]);
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
        ["Aliases", "Examples", "Start here (for AI agents)"].includes(section)
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
  if (section === "Options" || section.endsWith(" options")) {
    return styleOptionSyntax(value);
  }
  if (["Aliases", "Examples", "Start here (for AI agents)"].includes(section)) {
    return styleExample(value);
  }
  if (section === "Arguments") {
    return helpColor.argument(value);
  }
  if (section === "Shortcuts") {
    return helpColor.option(value);
  }
  return styleCommandSyntax(value);
}

function styleExample(value: string): string {
  return value.replace(
    /"[^"]*"|'[^']*'|(?:^|[\s,])--?[a-z][\w-]*|\b(?:wf|workforest)\b|(?:^|\s)(?:add|cd|clean|config|confetti|delete|dev|edit|eval|find|fork|get|info|init|list|new|path|review|show|simulate|skills|template|templates|worktree|workspace|wt)(?=\s|$)|(?:^|\s)(?:\.{1,2}\/|[\w.-]+\/)\S+|\b\d+\b/gi,
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
