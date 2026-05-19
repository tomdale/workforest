# Subagent Worktree Lifecycle

## 1. Prepare The Primary Repo

The primary repo is the integration checkout. Commit or stash local changes
before creating temporary worktrees. Workforest refuses dirty primary repos by
default because subagent branches start from committed `HEAD`.

## 2. Create One Worktree Per Task

```sh
cd ~/Code/workspaces/my-feature/next.js
wf worktree "fix-tests" "upgrade-dependencies"
```

Expected shape:

```text
~/Code/workspaces/my-feature/next.js-fix-tests
~/Code/workspaces/my-feature/next.js-upgrade-dependencies
```

Branches use the current primary branch namespace:

```text
tomdale/fix-tests
tomdale/upgrade-dependencies
```

## 3. Delegate Carefully

Each subagent should get:

- its own worktree path
- a narrow task
- expected verification command
- instruction not to revert unrelated edits or other agents' work

## 4. Review And Merge

Inspect each worktree's diff and test output. Commit the subagent work on its
temporary branch, then merge or cherry-pick into the primary checkout using Git.

## 5. Remove Temporary Worktrees

```sh
wf worktree rm "fix-tests"
```

By default removal requires:

- clean subagent worktree
- temporary branch reachable from the current primary branch

Use `--force` only when work was intentionally squash-merged, cherry-picked, or
discarded.
