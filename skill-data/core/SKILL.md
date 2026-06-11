---
name: core
description: Core Workforest usage guide for AI agents. Use when creating, opening, listing, extending, or deleting Workforest workspaces; understanding workspace metadata; or deciding which specialized Workforest skill to load.
---

# Workforest Core

Workforest creates disposable multi-repo workspaces using cached Git mirrors and
worktrees. Use it when an agent needs isolated checkouts with setup commands run
for each repo.

## Start Here

Use these commands for the usual workspace lifecycle:

```sh
wf workspace create vercel/next.js vercel/turbo -- "update docs build"
wf workspace status                               # monitor background setup
wf workspace list                                 # list workspaces
wf workspace add vercel/swr                       # add a repository
wf workspace create --like current -- "new approach"
wf workspace delete update-docs-build --dry-run  # preview cleanup
wf workspace delete update-docs-build --force    # remove the workspace
wf cache list                                     # inspect cached repositories
```

For exact command syntax, read `references/commands.md` with:

```sh
wf skills get core --full
```

## Example Workflow

User request:

> Create a workspace for updating docs build behavior across Next.js and Turbo.

Agent workflow:

```sh
# Create a named workspace with both repos on matching feature branches.
wf workspace create vercel/next.js vercel/turbo -- "update docs build"

cd ~/Code/workspaces/update-docs-build

# Inspect what Workforest created.
wf workspace status
wf workspace list
ls

# Work in the repos using normal project commands.
cd next.js
pnpm test
cd ../turbo
pnpm test

# Add another repo later if the investigation needs it.
cd ..
wf workspace add vercel/swr

# When the workspace is no longer needed, preview and clean it.
wf workspace delete update-docs-build --dry-run
wf workspace delete update-docs-build --force
```

Expected shape:

```text
~/Code/workspaces/update-docs-build/
  next.js/
  turbo/
  swr/
  .workforest/workspace.json
```

Use `wf workspace create --like current -- "try token refresh"` from inside the
workspace when the user wants a separate approach with the same repositories
but fresh branches.

Use `wf worktree create <repo> <name>` for a standalone single-repository
checkout. Use `wf task create <name...>` inside a workspace repository when
parallel agents need short-lived sibling worktrees.

## Safety Rules

- Do not manually delete a workspace before `wf workspace delete`; Workforest
  removes Git worktree registrations as well as directories.
- Prefer `wf workspace delete <workspace> --dry-run` before destructive
  cleanup.
- Prefer `wf cache prune --dry-run` before deleting unused cached mirrors.
- Do not force-delete a mirror with active worktrees unless those worktrees are
  intentionally being abandoned.

## Related Skills

- Parallel subagents and temporary repo worktrees: `wf skills get parallel-worktrees`.
- Setup, templates, hooks, and default files: `wf skills get setup-and-configuration`.
