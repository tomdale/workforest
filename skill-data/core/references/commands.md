# Workforest Command Reference

## Workspace Commands

```sh
wf new <template|repo...> -- <work>  # create a workspace
wf workspace create <repos...> -- <work>
wf workspace create --like current -- <work>
wf workspace status                 # monitor background repo initialization
wf workspace list                   # list known workspaces
wf workspace open [name] [--search] # open a workspace
wf workspace add <repo...>          # add repos to the current workspace
wf workspace delete <workspace>     # remove an explicit workspace
wf clean <workspace>                # temporary delete shortcut
```

`wf new` returns once repository worktrees are ready. Initializers and template
hooks continue in detached background workers and can be inspected from anywhere
inside the workspace with `wf workspace status`.

## Task Commands

```sh
wf task create <slug...>             # workspace task worktrees
wf task list                         # list tracked tasks
wf task delete <slug...>             # remove explicit tasks
```

## Standalone Worktree Commands

```sh
wf worktree create <repo> <slug>
wf worktree list [repo]
wf worktree delete <path>
```

## Template Commands

```sh
wf template list
wf template info <name>
wf template new <name> [repo...]
wf template edit <name>
wf template copy <source> <dest>
wf template rm <name>
```

## Cached Repository Commands

```sh
wf repositories                        # interactive cache manager
wf repository list [--json]            # inventory mirrors
wf repository info <repo> [--json]     # inspect identity, health, and worktrees
wf repository path [repo]              # print cache or mirror path
wf repository add <repo...>            # warm the cache
wf repository update [repo...]         # fetch selected mirrors, or all
wf repository doctor [repo...]         # check health
wf repository repair [repo...]         # prune metadata and verify objects
wf repository delete <repo...>         # delete selected mirrors
wf repository clean                    # delete mirrors without active worktrees
```

Repository specifiers accept `owner/repo`, git URLs, or unique repository names
already present in the cache. Bare names fail when multiple cached owners match.

Read `references/repository-cache.md` for the jobs, safety rules, and automation
contracts behind these commands.

## Config

```sh
wf config show
wf config init
wf config edit
```

Global config controls `defaultDir`, `dirPrefix`, `branchPrefix`, and optional
Vercel linking behavior. Templates can override branch prefix behavior and
disable specific initializers.
