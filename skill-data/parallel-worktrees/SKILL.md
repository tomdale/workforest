---
name: parallel-worktrees
description: Workforest guidance for using task worktrees with parallel AI subagents. Use when delegating independent tasks, creating short-lived worktrees with `wf task start`, handing paths to subagents, reviewing and merging subagent branches, listing tasks, or cleaning them up safely.
---

# Workforest Parallel Worktrees

Use Workforest tasks when multiple agents need to modify the same repository
without stepping on each other.

## Create Worktrees

Run from inside a repository in a normal Workforest workspace:

```sh
wf task start "fix-tests" "upgrade-dependencies"
```

Workforest creates nested directories like `_tasks/repo/fix-tests`, branches from the
primary repository's committed `HEAD`, and runs built-in repository setup
initializers.

From a workspace root, pass the parent repo:

```sh
wf task start --repo next.js "fix-tests"
```

Read `references/subagent-lifecycle.md` for the full lifecycle.

## Delegate

Give each subagent one worktree path and one task. Tell the subagent it is not
alone in the codebase and must not revert unrelated work.

## Integrate

Review a subagent's changes in its worktree, commit there, then merge or cherry
pick into the primary integration checkout with normal Git. Workforest does not
perform the merge.

## Clean Up

After integration:

```sh
wf task list
wf task delete "fix-tests"
```

Removal refuses dirty or unmerged worktrees unless `--force` is explicitly used.
