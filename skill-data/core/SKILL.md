---
name: core
description: Core Workforest usage guide for AI agents. Use when creating, listing, adding to, forking, or cleaning Workforest workspaces; understanding workspace metadata; or deciding which specialized Workforest skill to load.
---

# Workforest Core

Workforest creates disposable multi-repo workspaces using cached Git mirrors and
worktrees. Use it when an agent needs isolated checkouts with setup commands run
for each repo.

## Start Here

Use these commands for the usual workspace lifecycle:

```sh
wf new vercel/next.js vercel/turbo -- "update docs build" # create a workspace
wf status                                          # monitor background setup
wf list                                            # list workspaces
wf add vercel/swr                                  # add repo from inside a workspace
wf fork "new approach"                             # try another approach
wf clean --dry-run                                 # preview cleanup
wf clean --force                                   # remove workspace after review
wf repository list                                # inspect cached repositories
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
wf new vercel/next.js vercel/turbo -- "update docs build"

cd ~/Code/workspaces/update-docs-build

# Inspect what Workforest created.
wf status
wf list
ls

# Work in the repos using normal project commands.
cd next.js
pnpm test
cd ../turbo
pnpm test

# Add another repo later if the investigation needs it.
cd ..
wf add vercel/swr

# When the workspace is no longer needed, preview and clean it.
wf clean --dry-run
wf clean --force
```

Expected shape:

```text
~/Code/workspaces/update-docs-build/
  next.js/
  turbo/
  swr/
  .workforest/workspace.json
```

Use `wf fork "try token refresh"` from inside the workspace when the user wants a
separate approach with the same repos but fresh branches.

## Safety Rules

- Do not manually delete a workspace before `wf clean`; Workforest removes Git
  worktree registrations as well as directories.
- Prefer `wf clean --dry-run` before destructive cleanup.
- Prefer `wf repository clean --dry-run` before deleting cached mirrors.
- Do not force-delete a mirror with active worktrees unless those worktrees are
  intentionally being abandoned.

## Related Skills

- Parallel subagents and temporary repo worktrees: `wf skills get parallel-worktrees`.
- Setup, templates, hooks, and default files: `wf skills get setup-and-configuration`.
