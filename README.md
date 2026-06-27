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

In an interactive terminal, run `wf` with no arguments to open the change entry
surface — a single fullscreen front door that fuzzy-searches your existing
changes (Enter to jump straight into one) and, for a new name, walks you through
picking sources before handing off to the live setup grid. `wf start` with no
arguments opens the same surface in create-only mode. Both fall back to plain
output outside a TTY, and the explicit forms below stay fully scriptable.

The surface is aware of where you launch it. Run inside a workspace or
single-repo change and the change list defaults to that scope's changes; press
**Tab** to toggle between the current scope and all changes. When naming a new
change, the source picker is grouped into **Repo**, **Template**, and
**Multi-repo** modes — **Tab** cycles between them — and it opens in the mode
matching the container you started from (with that repo or template under the
cursor).

```sh
# Go to an existing change or create a new one (interactive front door).
wf

# Create a multi-repository workspace.
wf start fix-authentication vercel/front vercel/api

# Monitor background dependency installation and hooks.
wf status --watch

# Add another repository to the current workspace.
wf add vercel/docs

# Open an existing change.
wf switch _adhoc/fix-authentication

# Clean it up after the work is integrated.
wf finish _adhoc/fix-authentication
```

The main lifecycle is `wf start`, `wf switch`, `wf list`, `wf status`,
`wf add`, `wf finish`, and `wf delete`.

## Workspace Workflows

### Create A Workspace

Create a workspace from repositories:

```sh
wf start account-switching vercel/front vercel/api
```

The command creates a directory such as `add-account-switching/`, adds a
matching feature branch to each repository, and returns after the worktrees are
available. Initializers and template hooks continue in background workers.

Run the command with just a change name for the interactive creation flow:

```sh
wf start account-switching
```

### Create From The Current Workspace

Start a separate approach with the same repository set:

```sh
cd ~/Code/workspaces/fix-authentication
wf start try-token-refresh
```

The new workspace uses fresh branches from each repository's default branch.

### Add A Repository

From anywhere inside a workspace:

```sh
wf add vercel/docs
```

To add to another change, switch there first:

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
directory. Running it without a selector opens an interactive change picker.

### Monitor Setup

```sh
wf status --watch
```

Run status from anywhere inside the workspace to inspect repository setup and
hook progress. Detailed repository logs live under `.workforest/logs/`.

### Delete A Workspace

```sh
wf finish _adhoc/fix-authentication
wf delete _adhoc/fix-authentication --force
```

Use Workforest rather than deleting the directory manually so cached Git
worktree registrations are cleaned up with the workspace.

## Parallel Tasks

Use task worktrees when parallel agents need independent branches of a
repository in the same workspace:

```sh
cd ~/Code/workspaces/account-switching/front
wf task start fix-tests upgrade-dependencies
```

Each task starts from the primary repository's committed `HEAD`, receives a
branch derived from the configured branch prefix, and runs repository
initializers. Template files and workspace hooks are not reapplied.

From the workspace root, identify the parent repository explicitly:

```sh
wf task start --repo front fix-tests
```

Inspect and remove tasks after their branches are integrated:

```sh
wf task list
wf task finish fix-tests
```

Deletion refuses dirty or unmerged task worktrees unless `--force` is supplied.
Destructive commands require an explicit resource; Workforest does not infer a
task to delete from the current directory.

## Single-Repository Changes

Create a single-repository change without a multi-repo workspace:

```sh
wf start fix-auth vercel/front
```

The target uses the opinionated `Repos/<repo>/<change>` layout. Inspect or
remove these changes with the same lifecycle commands:

```sh
wf status workforest/fix-auth
wf finish workforest/fix-auth
```

## Cloud Workspaces

Provision a change as a remote, persistent [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox)
instead of local worktrees by adding `--cloud` to `wf start`. The cloud workspace
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
wf start auth-fix @vercel-agent --cloud

# Single repo, in the cloud.
wf start try-token-refresh vercel/front --cloud
```

The interactive front door (`wf` or `wf start` with no source) ends with a
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
wf review open vercel/omniagent
```

Check out a pull request into that review workspace:

```sh
wf review checkout vercel/omniagent#123
wf review checkout https://github.com/vercel/omniagent/pull/123
```

Review worktrees are stored below `directory.reviews`, which defaults to
`~/Code/Reviews`, and use the cached repository mirror.

## Templates

Templates capture repeated repository sets, branch prefixes, setup hooks, and
default files.

Open the templates dashboard to create, edit, copy, or delete templates:

```sh
wf templates
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
wf start user-avatars @full-stack
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
metadata, branch, or lifecycle rules; all registered Git worktrees are in scope:

```sh
wf worktree add vercel/front ~/Code/front-fix-auth tomdale/fix-auth
wf worktree add vercel/front ~/Code/front-cleanup
wf worktree list vercel/front
wf worktree move vercel/front ~/Code/front-fix-auth ~/Code/front-auth-fix
wf worktree remove vercel/front ~/Code/front-auth-fix
```

These commands accept no native Git flags. `add` creates a new branch from the
mirror's current `HEAD`; omit the branch to let Git derive it from the
destination directory name. `move` and `remove` retain Git's standard safety
checks. Workforest's `--json` envelope is intentionally unavailable.

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
optional `in`, optional `if`, and optional `continueOnError`.

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

The `cloud.vercel` key configures `wf start --cloud` workspaces (it is nested
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
wf start               Start a repository or workspace change
wf switch              Open or search for a change
wf list                List changes
wf status              Inspect change state or background setup
wf add                 Add repositories to the current change
wf finish              Clean up an integrated change
wf delete              Explicitly delete a change

wf task start          Create change-scoped task worktrees
wf task list           List task worktrees
wf task finish         Clean up integrated task worktrees
wf task delete         Delete explicit task worktrees

wf cache list          Inspect cached mirrors
wf cloud list          List cloud workspaces
wf cloud status        Show one cloud workspace
wf cloud attach        Resume and open a shell in a cloud workspace
wf cloud stop          Stop a cloud workspace (snapshot + halt)
wf cloud delete        Delete a cloud workspace
wf review open         Open a review workspace
wf review checkout     Check out a pull request
wf templates           Open the templates dashboard
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

## Troubleshooting

### Repository Access Fails

Verify SSH authentication and repository access:

```sh
ssh-add -l
ssh -T git@github.com
```

### Workspace Setup Fails

Run `wf status --watch` inside the change and inspect
`.workforest/logs/<repo>.log`.

### Cache Health Fails

Inspect before repairing or deleting data:

```sh
wf cache doctor
wf cache show <repo>
wf cache doctor <repo> --fix
```

### A Template Is Missing

Use `wf templates` to inspect saved templates or
`wf template show <name>` for a non-interactive lookup.
