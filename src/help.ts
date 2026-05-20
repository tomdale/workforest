import chalk from "chalk";
import { loadWorkspaceConfig } from "./config.ts";
import { getTemplatesDir, listTemplates } from "./templates/index.ts";

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
      ? [chalk.dim("(none)")]
      : templates.map(
          (t) =>
            `${t.id.padEnd(16)}${chalk.dim(t.config.description ?? t.config.repos.join(", "))}`,
        );

  return `
${chalk.bold("Usage:")} wf <command> [options]

${chalk.bold("Start here (for AI agents):")}
  wf skills get core --full

${chalk.bold("Commands:")}
  new <work> -- <template|repo...> Create a workspace
  worktree <slug...>           Create temporary worktree(s) in a workspace repo
  worktree list|delete         List or delete temporary worktrees
  review <target>              Create a disposable PR review worktree
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
  template list|show|info|...  Manage templates
  config [show|edit|init]      Manage configuration

${chalk.bold("Clean options:")}
  -r, --delete-remote-branches Delete merged remote branches (prompts if not set)
  -f, --force                  Skip confirmation prompts
  -n, --dry-run                Preview without deleting
  --keep-mirrors               Keep cached git mirrors (default: true)

${chalk.bold("Examples:")}
  wf new "update docs build" -- vercel/next.js vercel/turbo
  wf worktree "fix-tests" "upgrade-deps"
  wf worktree list
  wf worktree delete "fix-tests"
  wf review vercel/omniagent 123
  wf review delete vercel/omniagent#123 --dry-run
  wf worktree next.js "fix-auth"
  wf wt next.js "fix-auth" --dir ../next.js-fix-auth
  wf new --dry-run "fixing auth" -- my-template
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
  wf template new "oss-docs" vercel/next.js vercel/turbo

${chalk.bold("Templates:")}
  ${templateLines.join("\n  ")}

${chalk.dim(`Config:     ${configPath}`)}
${chalk.dim(`Templates:  ${templatesDir}`)}
`;
}

const COMMAND_HELP: Record<string, string> = {
  new: `Usage: wf new [options] <name-or-description> -- <template|repo...>

Create a workspace from one or more repositories or templates.

Options:
  -n, --dry-run    Preview without creating a workspace
  -h, --help       Show this help

Examples:
  wf new "update docs build" -- vercel/next.js vercel/turbo
  wf new --dry-run "fixing auth" -- my-template
  wf new
`,

  worktree: `Usage: wf worktree <repo> <slug> [options]
       wf worktree <slug...> [options]
       wf worktree list [options]
       wf worktree delete [slug...] [options]

Create, list, or delete worktrees. Inside a workforest workspace, slug-only
creation makes temporary worktrees tracked in workspace metadata. Outside a
workspace, slug-only creation uses the current git repo's origin remote when
available.

Options:
  --dir <path>     Target path for standalone worktree creation
  --repo <repo>    Workspace repo name for temporary worktree operations
  -n, --dry-run    Preview without changing files
  -f, --force      Skip confirmation prompts where supported
  -h, --help       Show this help

Examples:
  wf worktree next.js fix-auth --dir ../next.js-fix-auth
  wf worktree fix-tests
  wf worktree list --repo front
  wf worktree delete fix-tests --dry-run
`,

  wt: `Usage: wf wt <repo> <slug> [options]
       wf wt <slug...> [options]
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

  review: `Usage: wf review <owner>/<repo> <pr-number>
       wf review <owner>/<repo>#<pr-number>
       wf review <github-pr-url>
       wf review list [repo]
       wf review delete <target> [options]

Create, list, or remove disposable GitHub PR review worktrees.

Options:
  -n, --dry-run    Preview review removal without deleting
  -f, --force      Remove dirty review worktrees
  -h, --help       Show this help

Examples:
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
--workspace.

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

  template: `Usage: wf template [subcommand]

Manage workspace templates.

Subcommands:
  list, ls                  List templates
  show <name>               Jump to a template directory
  info <name>               Print template details
  new, create <name> <repo...>
                            Create a template
  edit <name>               Edit a template interactively
  add-file <path>           Add a workspace file or directory to the source template
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

  version: `Usage: wf version

Print the workforest version.

Aliases:
  wf --version
  wf -V
`,
};

const NESTED_COMMAND_HELP: Record<string, Record<string, string>> = {
  review: {
    list: `Usage: wf review list [repo]

List known review worktrees and stale entries.

Options:
  -h, --help     Show this help
`,
    delete: `Usage: wf review delete <target> [options]

Delete a disposable PR review worktree.

Options:
  -n, --dry-run  Preview without deleting
  -f, --force    Remove even when the worktree is dirty
  -h, --help     Show this help
`,
  },

  worktree: {
    list: `Usage: wf worktree list [options]

List temporary worktrees tracked by the current workspace.

Options:
  --repo <repo>  Limit results to one workspace repo
  -h, --help     Show this help
`,
    delete: `Usage: wf worktree delete [slug...] [options]

Delete temporary worktrees tracked by the current workspace, or standalone
worktrees outside a workspace.
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

Create a template from repository slugs or git URLs.

Aliases:
  wf template create

Options:
  -d, --description <text>  Template description
  -h, --help                Show this help
`,
    edit: `Usage: wf template edit <name>

Edit a template interactively.
`,
    "add-file": `Usage: wf template add-file <path>

Add a file or directory from the current workspace to the files/ directory of
the template that created the workspace. The path is copied at the same path
relative to the workspace root, so future workspaces from that template receive
it there.
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
    simulate: `Usage: wf dev simulate new [options]

Run synthetic development UI simulations.

Flows:
  new       Run the synthetic wf new UI simulation
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
  dev: {
    sim: "simulate",
  },
};

export function commandHelp(command: string): string | null {
  return COMMAND_HELP[command] ?? null;
}

export function nestedCommandHelp(
  command: string,
  subcommand: string,
): string | null {
  const canonical = NESTED_ALIASES[command]?.[subcommand] ?? subcommand;
  return NESTED_COMMAND_HELP[command]?.[canonical] ?? null;
}
