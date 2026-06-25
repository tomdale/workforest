---
name: core
description: Core Workforest usage guide for AI agents. Use when creating, switching to, listing, extending, inspecting, finishing, or deleting Workforest changes; understanding the change lifecycle; or deciding which specialized Workforest skill to load.
---

# Workforest Core

Workforest creates disposable Git worktrees from cached bare mirrors. The
command layer is change-oriented: a change is one piece of work, either a
single-repository change or a multi-repository workspace.

Use the core lifecycle for almost every task:

```sh
wf start <change> <repo...|@template>
wf switch [selector]
wf add <repo...|@template>
wf list
wf status [selector] [--watch]
wf finish [selector]
wf delete <selector> --force
```

For exact syntax, run:

```sh
wf skills get core --full
```

## Mental Model

Human-facing checkout layout:

```text
~/Code/Repos/<repo>/<change>
~/Code/Workspaces/<template>/<change>/<repo>
~/Code/Workspaces/_adhoc/<change>/<repo>
~/Code/Reviews/<repo>/...
```

Git storage layout:

```text
~/.cache/workforest/<repo>.git
```

Every managed checkout is a worktree backed by the cache. Do not remove managed
directories by hand; use `wf finish`, `wf delete`, or `wf task delete` so Git
worktree registrations are cleaned up.

## Single-Repository Change

Use this when the work belongs to one repository.

```sh
wf start cli-redesign tomdale/workforest
wf status
cd ~/Code/Repos/workforest/cli-redesign

# Run normal project commands in the worktree.
pnpm test

# After the change is integrated:
wf finish workforest/cli-redesign
```

Selectors use `<group>/<change>`. For repository changes, the group is the
repository name, for example `workforest/cli-redesign`.

## Template Workspace

Use a template when a repeated multi-repo workflow is already defined.

```sh
wf start auth-fix @vercel-agent
wf status --watch
cd ~/Code/Workspaces/vercel-agent/auth-fix

# Work in individual repos.
cd agents
pnpm test

wf finish vercel-agent/auth-fix
```

Template workspace selectors use the template name as the group.

## Dynamic `_adhoc` Workspace

Use `_adhoc` for a one-off multi-repo set.

```sh
wf start billing vercel/front vercel/api
wf status --watch
cd ~/Code/Workspaces/_adhoc/billing

wf add vercel/docs
wf list --group _adhoc --paths

wf finish _adhoc/billing
```

`wf add` runs from inside the current change. To add repositories to a different
change, switch there first:

```sh
wf switch _adhoc/billing
wf add vercel/docs
```

## Promote A Repo Change

When a single-repo change grows into multi-repo work, promote it with `wf add`.

```sh
wf switch workforest/cli-redesign
wf add tomdale/workforest-docs --yes
```

Workforest moves the existing repo worktree into an `_adhoc` workspace and
creates worktrees for the added repos. In an interactive terminal it asks before
moving; scripts must pass `--yes`.

If the current repository belongs to a template, you can promote with that
template:

```sh
wf add @vercel-agent --yes
```

## Source-Less Starts

`wf start <change>` without sources repeats the current Workforest-managed
context:

- from a repository change: start another change for the same repo
- from a repository home: start a change for that repo
- from a template workspace: start another workspace from that template
- from an `_adhoc` workspace: start another workspace with the same repo set

Use it for alternate approaches:

```sh
wf start try-token-refresh
```

It is only valid from a Workforest-managed location. In an arbitrary checkout,
pass explicit sources.

## Switching And Inventory

Use `wf switch` to move around:

```sh
wf switch
wf switch workforest/cli-redesign
wf switch vercel-agent/auth-fix
```

Bare `wf switch` opens a fuzzy finder over known changes. If a selector maps to
more than one path, run from inside the intended change or use the interactive
switcher. There is no rename command in the public workflow.

Use `wf list` for a compact inventory:

```sh
wf list
wf list --repo workforest
wf list --group _adhoc --paths
```

Use `wf status` for details:

```sh
wf status
wf status workforest/cli-redesign
wf status --watch
wf status _adhoc/billing --json
```

`--watch` is for initialization progress. Without recorded initialization,
Workforest shows the static status report.

## Cleanup

Use `wf finish` after integration. It refuses cleanup when Workforest cannot
prove the change is integrated unless you explicitly pass `--force`.

```sh
wf finish workforest/cli-redesign
wf finish _adhoc/billing
```

Use `wf delete` for explicit abandonment or cleanup that is not an integrated
finish path:

```sh
wf delete _adhoc/experiment --force
```

Destructive commands require explicit selectors; Workforest does not infer a
change to delete from the current directory.

## Parallel Tasks

For parallel agents inside an existing change, create nested task worktrees:

```sh
wf task start fix-tests upgrade-deps
wf task list
wf task finish fix-tests
wf task delete upgrade-deps --force
```

Load the task-specific guide for delegation details:

```sh
wf skills get parallel-worktrees --full
```

## Cache And Reviews

The cache stores bare mirrors and powers fast starts:

```sh
wf cache list
wf cache info workforest
wf cache doctor
wf cache prune --dry-run
```

Review workspaces are separate from normal changes:

```sh
wf review open vercel/omniagent
wf review checkout vercel/omniagent#123
```

## Safety Rules

- Commit or stash unrelated local edits before starting task worktrees.
- Do not manually delete Workforest-managed directories.
- Prefer `wf finish <selector>` after integration.
- Use `wf delete <selector> --force` only for intentional abandonment.
- Use `wf cache prune --dry-run` before reclaiming cached mirrors.
- Do not force-delete a mirror with active worktrees unless those worktrees are
  intentionally abandoned.

## Related Skills

- Parallel subagents and nested task worktrees: `wf skills get parallel-worktrees --full`.
- Config, templates, hooks, and default files: `wf skills get setup-and-configuration --full`.
