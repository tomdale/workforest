# workforest

A CLI for creating disposable development workspaces from cached Git
repositories and worktrees.

## Why Workforest?

[Git worktrees](https://git-scm.com/docs/git-worktree) make it practical to
work on several branches of one repository at the same time. Workforest extends
that model across repositories: one workspace can contain coordinated
checkouts for a frontend, API, documentation site, and any other repositories a
task needs.

Workforest creates consistently named branches, reuses cached bare mirrors,
runs repository setup in parallel, applies reusable templates, and records the
workspace so it can be opened or deleted safely later.

## Installation

```sh
npm install -g workforest
```

The package installs both `wf` and `workforest`. Usage text uses the shorter
`wf` executable.

Install the shell integration once to enable command handoff and generated
completion:

```sh
eval "$(wf shell init zsh)"
```

Use `bash` instead of `zsh` for Bash.

## Quick Start

```sh
# Create a multi-repository workspace.
wf workspace create vercel/front vercel/api -- "fix authentication"

# Monitor background dependency installation and hooks.
wf workspace status

# Add another repository to the current workspace.
wf workspace add vercel/docs

# Open an existing workspace.
wf workspace open fix-authentication

# Delete it after the work is merged.
wf workspace delete fix-authentication --dry-run
wf workspace delete fix-authentication --force
```

`wf new` is the documented shortcut for `wf workspace create`. `wf clean` is a
temporary shortcut for `wf workspace delete`. Other commands use their
resource-first canonical paths.

## Workspace Workflows

### Create A Workspace

Create a workspace from repositories:

```sh
wf workspace create vercel/front vercel/api -- "add account switching"
```

The command creates a directory such as `add-account-switching/`, adds a
matching feature branch to each repository, and returns after the worktrees are
available. Initializers and template hooks continue in background workers.

Run the command without repository arguments for the interactive creation
flow:

```sh
wf workspace create
```

### Create From The Current Workspace

Start a separate approach with the same repository set:

```sh
cd ~/Code/workspaces/fix-authentication
wf workspace create --like current -- "try token refresh"
```

The new workspace uses fresh branches from each repository's default branch.

### Add A Repository

From anywhere inside a workspace:

```sh
wf workspace add vercel/docs
```

Or target one explicitly:

```sh
wf workspace add vercel/docs --workspace ~/Code/workspaces/fix-authentication
```

Workforest checks out the repository on the workspace branch, runs its
initializers, and updates workspace metadata.

### Open And List Workspaces

```sh
wf workspace list
wf workspace open fix-authentication
wf workspace open --search
```

With shell integration installed, `workspace open` changes the current shell
directory. `--search` opens an interactive workspace picker.

### Monitor Setup

```sh
wf workspace status
```

Run status from anywhere inside the workspace to inspect repository setup and
hook progress. Detailed repository logs live under `.workforest/logs/`.

### Delete A Workspace

```sh
wf workspace delete fix-authentication --dry-run
wf workspace delete fix-authentication --force
```

Use Workforest rather than deleting the directory manually so cached Git
worktree registrations are cleaned up with the workspace.

## Parallel Tasks

Use task worktrees when parallel agents need independent branches of a
repository in the same workspace:

```sh
cd ~/Code/workspaces/account-switching/front
wf task create fix-tests upgrade-dependencies
```

Each task starts from the primary repository's committed `HEAD`, receives a
branch derived from the configured branch prefix, and runs repository
initializers. Template files and workspace hooks are not reapplied.

From the workspace root, identify the parent repository explicitly:

```sh
wf task create --repo front fix-tests
```

Inspect and remove tasks after their branches are integrated:

```sh
wf task list
wf task delete fix-tests
```

Deletion refuses dirty or unmerged task worktrees unless `--force` is supplied.
Destructive commands require an explicit resource; Workforest does not infer a
task to delete from the current directory.

## Standalone Worktrees

Create a single-repository worktree without workspace metadata, templates,
hooks, or a VS Code workspace:

```sh
wf worktree create vercel/front fix-auth
wf worktree create vercel/front fix-auth --dir ../front-fix-auth
```

The target defaults to `<defaultDir>/<repo>/<slug>`, for example
`~/Code/front/fix-auth` when `defaultDir` is `~/Code`. Pass `--dir` to choose
a different target path. Inspect or remove standalone worktrees with explicit
commands:

```sh
wf worktree list vercel/front
wf worktree delete ../front-fix-auth --dry-run
wf worktree delete ../front-fix-auth --force
```

## Code Review

Open a repository review workspace:

```sh
wf review open vercel/omniagent
```

Check out a pull request into that review workspace:

```sh
wf review checkout vercel/omniagent#123
wf review checkout https://github.com/vercel/omniagent/pull/123
```

On first use, Workforest prompts for `reviewsDir` and saves it to the global
configuration. Review worktrees are stored below that directory and use the
cached repository mirror.

## Templates

Templates capture repeated repository sets, branch prefixes, setup hooks, and
default files.

Open the interactive manager to create, edit, copy, or delete templates:

```sh
wf template manage
```

Inspect a template non-interactively:

```sh
wf template show full-stack
```

Open its directory in the current shell:

```sh
wf template open full-stack
```

Templates live at
`~/.config/workforest/templates/<name>/template.jsonc`:

```jsonc
{
  "repos": ["my-org/frontend", "my-org/api"],
  "description": "Full-stack development",
  "branchPrefix": "feature/",
  "hooks": [
    {
      "name": "Build project",
      "run": "pnpm build",
      "in": ["frontend"]
    }
  ]
}
```

Files under `~/.config/workforest/templates/<name>/files/` are copied into a
new workspace before initializers and hooks run.

Create a workspace from a template by passing its name:

```sh
wf workspace create full-stack -- "implement user avatars"
```

## Repository Cache

Workforest stores partial bare mirrors under `~/.cache/workforest/`. The first
use downloads repository metadata; later workspaces reuse it.

Common cache workflows:

```sh
wf cache list
wf cache info vercel/front
wf cache add vercel/front vercel/api
wf cache update
wf cache doctor
wf cache repair vercel/front
wf cache path vercel/front
```

Open the interactive cache manager:

```sh
wf cache manage
```

Preview unused mirror cleanup before deleting anything:

```sh
wf cache prune --dry-run
```

Delete a selected mirror explicitly:

```sh
wf cache delete vercel/front --dry-run
wf cache delete vercel/front --force
```

Deletion refuses mirrors with active worktrees unless `--force` is supplied.

## Automatic Initializers

Workforest detects repository configuration and runs setup in detached
background workers after each worktree is created.

Built-in initializers currently cover:

| Plugin | Initializer | Detects |
| --- | --- | --- |
| `@wf-plugin/package-managers` | `pnpm-install` | `pnpm-lock.yaml` or `pnpm-lock.yml` |
| `@wf-plugin/package-managers` | `yarn-install` | `yarn.lock` without a pnpm lockfile |
| `@wf-plugin/package-managers` | `npm-install` | `package-lock.json` without pnpm or Yarn |
| `@wf-plugin/vercel` | `vercel-link` | `vercel.json` or a Vercel dependency |
| `@wf-plugin/turbo` | `turbo-link` | `turbo.json` in a repository or workspace |

Templates can disable all initializers or selected initializer IDs:

```jsonc
{
  "repos": ["org/repo"],
  "disableInitializers": ["vercel-link", "turbo-link"]
}
```

Hooks run after repository initializers. Each hook supports `name`, `run`,
optional `in`, optional `if`, and optional `continueOnError`.

## Configuration

Global settings live in `~/.workforest/config.json` by default:

```jsonc
{
  "defaultDir": "~/Code/workspaces",
  "reviewsDir": "~/Code/reviews",
  "dirPrefix": "workspace-",
  "branchPrefix": "feature/",
  "vercelLink": {
    "teamByGitHubOwner": {
      "vercel": "vercel"
    }
  }
}
```

Manage configuration with:

```sh
wf config show
wf config init
wf config edit
```

## Command Map

This is a workflow map rather than an exhaustive flag reference:

```text
wf workspace create    Create a workspace
wf workspace delete    Delete an explicit workspace
wf workspace open      Open or search for a workspace
wf workspace list      List workspaces
wf workspace status    Inspect background setup
wf workspace add       Add repositories

wf task create         Create workspace-scoped task worktrees
wf task list           List task worktrees
wf task delete         Delete explicit task worktrees

wf worktree create     Create a standalone worktree
wf worktree list       List standalone worktrees
wf worktree delete     Delete an explicit standalone worktree

wf cache manage        Open the cache manager
wf review open         Open a review workspace
wf review checkout     Check out a pull request
wf template manage     Open the template manager
wf template show       Show template details
wf template open       Open a template directory
wf shell init          Print shell integration
```

The only command shortcuts are:

```text
wf new                 Shortcut for wf workspace create
wf clean <workspace>   Shortcut for wf workspace delete <workspace>
```

## Building From Source

Requires Node.js 25+ and pnpm:

```sh
git clone https://github.com/your-org/workforest
cd workforest
pnpm install
pnpm build
```

## Troubleshooting

### Repository Access Fails

Verify SSH authentication and repository access:

```sh
ssh-add -l
ssh -T git@github.com
```

### Workspace Setup Fails

Run `wf workspace status` inside the workspace and inspect
`.workforest/logs/<repo>.log`.

### Cache Health Fails

Inspect before repairing or deleting data:

```sh
wf cache doctor
wf cache info <repo>
wf cache repair <repo>
```

### A Template Is Missing

Use `wf template manage` to inspect saved templates or
`wf template show <name>` for a non-interactive lookup.
