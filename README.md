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

Install the shell integration once so that any command which lands you in a new
workspace also moves your shell there (including bare `wf`), and to enable
generated completion:

```sh
eval "$(wf shell init zsh)"
```

Use `bash` instead of `zsh` for Bash.

## Quick Start

In an interactive terminal, run `wf` with no arguments to open the entry
surface — a single fullscreen view that fuzzy-searches your existing
changes (Enter to jump straight into one) and, for a new name, walks you through
picking sources before handing off to the live setup grid. `wf new` with no
arguments opens the same surface in create-only mode. Both fall back to plain
output outside a TTY, and the explicit forms below stay fully scriptable.

On very large terminals the interactive chrome renders centered at a capped
size instead of stretching edge-to-edge; the output-heavy split-pane setup grid
keeps using the full width.

The surface is aware of where you launch it. Run inside a workspace or
worktree and the list defaults to that scope's entries; press
**Tab** to toggle between the current scope and everything. When naming a new
one, the source picker is grouped into **Repo**, **Template**, and
**Multi-repo** modes — **Tab** cycles forward and **Shift-Tab** cycles backward
between them — and it opens in the mode matching the container you started from
(with that repo or template under the cursor).

```sh
# Go to an existing worktree or workspace, or create a new one (interactive entry surface).
wf

# Create a multi-repository workspace.
wf new fix-authentication vercel/front vercel/api

# Monitor background dependency installation and hooks.
wf status --watch

# Add another repository to the current workspace.
wf add vercel/docs

# Open an existing worktree or workspace.
wf switch _adhoc/fix-authentication

# Clean it up after the work is integrated.
wf delete _adhoc/fix-authentication
```

The main lifecycle is `wf new`, `wf switch`, `wf list`, `wf status`,
`wf add`, and `wf delete`.

## Workspace Workflows

### Create A Workspace

Create a workspace from repositories:

```sh
wf new account-switching vercel/front vercel/api
```

The command creates a directory such as `add-account-switching/`, adds a
matching feature branch to each repository, and returns after the worktrees are
available. Initializers and template hooks continue in background workers.

Run the command with just a name for the interactive creation flow:

```sh
wf new account-switching
```

### Create From The Current Workspace

Start a separate approach with the same repository set:

```sh
cd ~/Code/workspaces/fix-authentication
wf new try-token-refresh
```

The new workspace uses fresh branches from each repository's default branch.

### Add A Repository

From anywhere inside a workspace:

```sh
wf add vercel/docs
```

To add to another worktree or workspace, switch there first:

```sh
wf switch _adhoc/fix-authentication
wf add vercel/docs
```

Workforest checks out the repository on the workspace branch, runs its
initializers, and updates workspace metadata.

### Open And List Workspaces

```sh
wf list
wf switch _adhoc/fix-authentication
wf switch
```

With shell integration installed, `wf switch` changes the current shell
directory. Running it without a selector opens an interactive picker.

### Inspect Status

```sh
wf status
wf status workforest/cli-redesign
```

Run from anywhere inside a worktree or workspace (or pass a selector) to print a
compact report: an identity header (`name`, type/template, repo count, age), a
dim path line, then one aligned row per repository:

```
myspace   next-forge · 4 repos · 3h ago
~/Code/workforest/myspace
!  AGENTS.md out of date by 3h

  ✔︎ web    main          synced  clean
  ● api    cli-redesign  ↑2 ↓1   3 modified · 2 untracked
      ● rate-limit  rate-limit  unmerged  ready
  ↻ docs   main          ↑1      installing…
  ✗ infra  —             —       setup failed: pnpm install failed
      ~/Code/workforest/myspace/.workforest/init/infra.log
```

Each row shows the working-tree state (leading glyph), current branch, sync vs.
the default branch (`↑ahead ↓behind`), and a one-line summary. Nested tasks are
indented beneath their parent repository. A failed setup stays terse — the error
heads the row and the log path follows on a dim line; open it for the full
output. Add `--json` for the complete machine-readable status.

### Monitor Setup

```sh
wf status --watch
wf status --wait --timeout 600
```

Watch live repository setup and hook progress as a workspace initializes.
Outside a terminal (CI, pipes), `--watch` degrades to the `--wait` behavior:
one plain line per repository transition, blocking until initialization
finishes. `--wait` is the scripting primitive; it exits `0` when ready, `1`
on failure, `130` when cancelled, and `124` if `--timeout` elapses.

### Inspect, Retry, And Cancel Setup

```sh
wf init logs                 # render the latest setup run
wf init logs --list          # list retained runs and their outcomes
wf init logs --repo api --step init:pnpm-install
wf init logs --follow        # tail a run in progress
wf init retry                # relaunch failed repositories and follow them
wf init cancel               # stop in-flight background initializers
```

Every setup run is recorded as a structured event log under
`.workforest/initialization/runs/<run-id>/`, kept for successful runs too
(the newest five runs, up to fourteen days). `wf init logs` renders each
step per repository with durations, retries, and the captured command
output, so a finished setup stays inspectable after the fact.

Re-running `wf new` with the same name and repositories resumes an
interrupted workspace: repositories that are already ready are left alone
and only the unfinished ones run again.

### Delete A Workspace

```sh
wf delete _adhoc/fix-authentication
wf delete _adhoc/fix-authentication --force
```

Use Workforest rather than deleting the directory manually so cached Git
worktree registrations are cleaned up with the workspace.

## Parallel Tasks

Use task worktrees when parallel agents need independent branches of a
repository in the same workspace:

```sh
cd ~/Code/workspaces/account-switching/front
wf task new fix-tests upgrade-dependencies
```

Each task starts from the primary repository's committed `HEAD`, receives a
branch derived from the configured branch prefix, and runs repository
initializers. Template files and workspace hooks are not reapplied.

From the workspace root, identify the parent repository explicitly:

```sh
wf task new --repo front fix-tests
```

Inspect and remove tasks after their branches are integrated:

```sh
wf task list
wf task delete fix-tests
```

Deletion refuses dirty or unmerged task worktrees unless `--force` is supplied.
Destructive commands require an explicit resource; Workforest does not infer a
task to delete from the current directory.

## Single-Repository Changes

Create a worktree (single repository) without a multi-repo workspace:

```sh
wf new fix-auth vercel/front
```

The target uses the opinionated `Repos/<repo>/<name>` layout. Inspect or
remove these changes with the same lifecycle commands:

```sh
wf status workforest/fix-auth
wf delete workforest/fix-auth
```

## Cloud Workspaces

Provision a worktree or workspace as a remote, persistent [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox)
instead of local worktrees by adding `--cloud` to `wf new`. The cloud workspace
behaves like a local one — one or more repositories, each checked out on a new
branch, with dependencies installed and `vercel env pull` run — but the
environment lives in the cloud, so it does not depend on your machine staying
online and is not bounded by local resources.

Cloud commands talk to Vercel through the `@vercel/sandbox` SDK (the only
exception is `wf cloud attach`, which shells out to the `sandbox` CLI for an
interactive PTY). Before using them, configure a **team and project** (Vercel
slugs) and provide a token:

```jsonc
// ~/.workforest/config.json
{ "cloud": { "vercel": { "team": "<team-slug>", "project": "<project-slug>" } } }
```

The token is inherited automatically from your `vercel login` (the access token
the Vercel CLI stores on disk). To use a different credential, set `VERCEL_TOKEN`
(or a team-scoped `VERCEL_OIDC_TOKEN`), which take precedence:

```sh
vercel login            # or: export VERCEL_TOKEN=…
```

Both `cloud.team` and `cloud.project` are required; every cloud command errors
early until they are set. The team and project are passed to the SDK as the
scope, so provisioning is deterministic regardless of any ambient Vercel state.

```sh
# Provision a template's repos as a cloud workspace.
wf new auth-fix @vercel-agent --cloud

# Single repo, in the cloud.
wf new try-token-refresh vercel/front --cloud
```

The interactive entry surface (`wf` or `wf new` with no source) ends with a
**Local / Cloud** prompt, so the same flow can target either.

Spin-up is near-instant after the first run: workforest maintains a per-template
**base snapshot** (repos cloned, dependencies installed) and forks it, then
fetches and branches on top. The snapshot is rebuilt when it ages past its TTL
(`cloud.snapshotTtlMs`, default 24h).

Credentials are **brokered by the sandbox firewall**: a GitHub token (from
`gh auth token`) and a Vercel token (`VERCEL_TOKEN`) are injected into outbound
requests to `github.com` and `api.vercel.com` in transit, so they never live
inside the sandbox and cannot be read or exfiltrated by code running there.

Inspect and tear down cloud workspaces — state is read from the sandboxes' tags,
so these work from any machine:

```sh
wf cloud list
wf cloud status auth-fix
wf cloud attach auth-fix    # resume if stopped + open an interactive shell
wf cloud stop auth-fix      # snapshot + halt; resumes on next use
wf cloud delete auth-fix
```

`wf cloud attach` resumes the workspace (via the SDK) and opens an interactive
shell. This one command shells out to the [`sandbox` CLI](https://vercel.com/docs/vercel-sandbox)
(required on `PATH`) for the PTY; it passes the configured `cloud.team` and
`cloud.project` as explicit scope and your token via the environment, so it
targets exactly where the workspace was provisioned regardless of the CLI's own
default scope.

A running workspace also exposes its dev-server ports as preview URLs (printed
when provisioning finishes and shown by `wf cloud status`). Cloud defaults (team,
project, vCPUs, timeout, exposed ports, runtime) live under the `cloud` key in
`config.json`; the sandbox runtime timeout defaults to 45 minutes.

## Code Review

Open a repository review workspace:

```sh
wf review vercel/omniagent
```

Check out a pull request into that review workspace:

```sh
wf review vercel/omniagent#123
wf review https://github.com/vercel/omniagent/pull/123
```

Review worktrees are stored below `directory.reviews`, which defaults to
`~/Code/Reviews`, and use the cached repository mirror.

## Templates

Templates capture repeated repository sets, branch prefixes, setup hooks, and
default files. For a conceptual overview of what templates are and how to build
them, run `wf help templates`.

Use the template subcommands to create, edit, copy, or delete templates:

```sh
wf template list
wf template new full-stack vercel/front vercel/api
wf template edit full-stack
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
      "name": "Validate project",
      "run": "pnpm check",
      "in": ["frontend"]
    }
  ]
}
```

Files under `~/.config/workforest/templates/<name>/files/` are copied into a
new workspace before initializers and hooks run.

Create a workspace from a template by passing its name:

```sh
wf new user-avatars @full-stack
```

## Repository Cache

Workforest stores partial bare mirrors under `~/.cache/workforest/`. The first
use downloads repository metadata; later workspaces reuse it.

Common cache workflows:

```sh
wf cache list
wf cache show vercel/front
wf cache show vercel/front --path
wf cache sync vercel/front vercel/api
wf cache sync
wf cache doctor
wf cache doctor vercel/front --fix
```

For basic Git worktree operations against an existing mirror, use the fixed
worktree commands. They do not sync a missing mirror or apply Workforest setup,
metadata, branch, or lifecycle rules, and they refuse a path inside a managed
Workforest directory — use `wf new`, `wf add`, or `wf delete` for managed
worktrees:

```sh
wf cache worktree add vercel/front ~/Code/front-fix-auth tomdale/fix-auth
wf cache worktree add vercel/front ~/Code/front-cleanup
wf cache worktree list vercel/front
wf cache worktree move vercel/front ~/Code/front-fix-auth ~/Code/front-auth-fix
wf cache worktree remove vercel/front ~/Code/front-auth-fix
```

These commands accept no native Git flags. `add` branches from the mirror's
default branch (`origin/<default>`); with an explicit branch it creates that
branch, and omitting the branch checks out a detached HEAD at `origin/<default>`.
`move` and `remove` retain Git's standard safety checks. Workforest's `--json`
envelope is intentionally unavailable.

Preview unused mirror cleanup before deleting anything:

```sh
wf cache clean --dry-run
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
optional `in`, optional `if`, optional `continueOnError`, and optional
`timeoutMs` (fail the hook if it runs longer than this).

## Configuration

Global settings live in `~/.workforest/config.json` by default:

```jsonc
{
  "directory": {
    "base": "~/Code",
    "repos": "Repos",
    "workspaces": "Workspaces",
    "reviews": "Reviews"
  },
  "branchPrefix": "feature/",
  "setup": {
    // Repositories set up concurrently (clones, checkouts, installs).
    // 0 removes the limit; WORKFOREST_MAX_CONCURRENT overrides per run.
    "maxConcurrent": 4
  },
  "vercelLink": {
    "teamByGitHubOwner": {
      "vercel": "vercel"
    }
  },
  "cloud": {
    "vercel": {
      "team": "vercel",
      "project": "my-app",
      "vcpus": 4,
      "ports": [3000],
      "snapshotTtlMs": 86400000
    }
  }
}
```

The `cloud.vercel` key configures `wf new --cloud` workspaces (it is nested
under a provider name so other providers can be added later). `team` and
`project` (Vercel slugs) are **required** for any cloud command; the rest (vCPUs,
sandbox timeout, base-snapshot TTL, exposed ports, runtime) are optional and fall
back to sensible defaults.

Manage configuration with:

```sh
wf config show
wf config init
wf config edit
```

## Command Map

This is a workflow map rather than an exhaustive flag reference:

```text
wf new                 Create a worktree or workspace
wf switch              Open or search for a worktree or workspace
wf list                List worktrees and workspaces
wf status              Inspect status or background setup (--wait to block)
wf add                 Add repositories to the current worktree or workspace
wf delete              Delete a worktree or workspace (verified; --force to abandon)

wf init logs           Render or tail recorded setup run logs
wf init retry          Retry failed repository setup
wf init cancel         Cancel in-flight background setup

wf task new            Create nested task worktrees
wf task list           List task worktrees
wf task delete         Delete task worktrees (verified; --force to abandon)

wf cache list          Inspect cached mirrors
wf cache worktree list List raw git worktrees in a cached mirror
wf cloud list          List cloud workspaces
wf cloud status        Show one cloud workspace
wf cloud attach        Resume and open a shell in a cloud workspace
wf cloud stop          Stop a cloud workspace (snapshot + halt)
wf cloud delete        Delete a cloud workspace
wf review              Open a review workspace or check out a pull request
wf template list       List templates
wf template show       Show template details
wf template open       Open a template directory
wf shell init          Print shell integration
```

## Building From Source

Requires Node.js 25+ and pnpm:

```sh
git clone https://github.com/your-org/workforest
cd workforest
pnpm install
pnpm check
pnpm build
```

To exercise the CLI from the current checkout, use `pnpm wf ...`. `pnpm exec wf`
can resolve a globally installed `wf` because pnpm does not link the root
package's own bins into `node_modules/.bin`.

## Troubleshooting

### Repository Access Fails

Verify SSH authentication and repository access:

```sh
ssh-add -l
ssh -T git@github.com
```

### Workspace Setup Fails

Run `wf init logs` inside the worktree or workspace to see every setup step
with its captured output, then `wf init retry` to relaunch the failed
repositories. `wf status --watch` follows setup that is still running.

### Cache Health Fails

Inspect before repairing or deleting data:

```sh
wf cache doctor
wf cache show <repo>
wf cache doctor <repo> --fix
```

### A Template Is Missing

Use `wf template list` to inspect saved templates or
`wf template show <name>` for a non-interactive lookup.
