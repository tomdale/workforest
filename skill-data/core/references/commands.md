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

## Config

```sh
wf config show
wf config init
wf config edit
```

Global config controls `defaultDir`, `dirPrefix`, `branchPrefix`, and optional
Vercel linking behavior. Templates can override branch prefix behavior and
disable specific initializers.
