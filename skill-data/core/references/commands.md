# Workforest Command Reference

## Workspace Commands

```sh
wf new <template|repo...> -- <work>  # create a workspace
wf list                              # list known workspaces
wf add <repo...>                     # add repos to the current workspace
wf fork <name>                       # fork current workspace with new branches
wf clean [dir]                       # remove a workspace
```

## Worktree Commands

```sh
wf worktree <slug...>                # temp sibling worktrees inside a workspace repo
wf worktree list                     # list tracked temp worktrees
wf worktree rm <slug...>             # remove tracked temp worktrees
wf worktree <repo> <slug>            # standalone single-repo worktree
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
