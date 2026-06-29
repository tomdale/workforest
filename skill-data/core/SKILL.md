---
name: core
description: Workforest core lifecycle guidance for AI agents. Use when you need the main worktree, workspace, task, template, cache, review, or cleanup workflow.
---

# Workforest Core

Use this skill when you need the main Workforest lifecycle in one place.

## Start Work

```sh
wf new <name> <repo...|@template>
wf status --watch
wf switch <selector>
```

Create a worktree, a workspace from a template, or a follow-up
in the current managed context. Use `wf new --help` for the source forms.

## Work The Change

```sh
wf list
wf status [selector]
wf add <repo...|@template>
```

Use `wf list` for inventory, `wf status` for progress, and `wf add` when a
worktree needs to grow. Use `wf add --help` for the exact cases.

## Finish Cleanly

```sh
wf delete [selector]
wf delete <selector> --force
```

Finish only after the work is integrated. Delete only when you are intentionally
abandoning a worktree or workspace. Use `wf delete --help` and `wf delete --help` for the
selector rules.

## Tasks, Templates, Reviews

```sh
wf task new <task>
wf task list
wf template list
wf review open <repo>
wf review checkout <repo>#<pr>
```

Use tasks for parallel subagents, templates for repeatable workspace setups,
and review workspaces for pull requests. For command syntax, load the scoped
help pages with `wf task --help`, `wf template --help`, and `wf review --help`.

## Cache And Config

```sh
wf cache list
wf cache doctor
wf config show
wf config edit
```

Use the cache commands to inspect or repair bare mirrors, and the config
commands to inspect or change directory and branch settings. Use
`wf cache --help` and `wf config --help` for details.

## Load Special Skills

```sh
wf skills list
wf skills get start-work coordinate-agents finish-work
wf skills get create-templates configure-workforest keep-cache-healthy review-prs
```

Start with `core`, then load the narrower skill that matches the job.
