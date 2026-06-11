# Workforest Command Reference

## Workspace Commands

```sh
wf workspace create <template|repo...> -- <work>
wf workspace create --like current -- <work>
wf workspace status
wf workspace list
wf workspace open [name] [--search]
wf workspace add <repo...>
wf workspace delete <workspace>
```

`wf workspace create` returns once repository worktrees are ready. Initializers
and template hooks continue in detached background workers and can be inspected
from anywhere inside the workspace with `wf workspace status`.

`wf new` is the shortcut for `wf workspace create`. `wf clean <workspace>` is
the temporary shortcut for `wf workspace delete <workspace>`.

## Task Commands

```sh
wf task create <slug...> [--repo <repo>]
wf task list [--repo <repo>]
wf task delete <slug...> [--repo <repo>]
```

## Standalone Worktree Commands

```sh
wf worktree create <repo> <slug> [--dir <path>]
wf worktree list [repo]
wf worktree delete <path>
```

## Template Commands

```sh
wf template manage
wf template show <name>
wf template open <name>
```

## Cached Repository Commands

```sh
wf cache manage
wf cache list [--json]
wf cache info <repo> [--json]
wf cache path [repo]
wf cache add <repo...>
wf cache update [repo...]
wf cache doctor [repo...]
wf cache repair [repo...]
wf cache delete <repo...>
wf cache prune
```

Repository specifiers accept `owner/repo`, git URLs, or unique repository names
already present in the cache. Bare names fail when multiple cached owners match.

Read `references/repository-cache.md` for the jobs, safety rules, and automation
contracts behind these commands.

## Review Commands

```sh
wf review open <repo>
wf review checkout <review-target...>
```

## Shell Integration

```sh
wf shell init zsh
wf shell init bash
```

## Config

```sh
wf config show
wf config init
wf config edit
```

Global config controls `defaultDir`, `dirPrefix`, `branchPrefix`, and optional
Vercel linking behavior. Templates can override branch prefix behavior and
disable specific initializers.
