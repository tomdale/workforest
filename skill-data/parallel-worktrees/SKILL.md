---
name: parallel-worktrees
description: Workforest guidance for using workspace tasks with parallel AI subagents. Use when delegating independent tasks, creating task worktrees with `wf task create <slug...>`, handing paths to subagents, reviewing and merging task branches, listing tasks, or cleaning them up safely.
---

# Workforest Parallel Tasks

Use Workforest tasks when multiple agents need to modify the same repository
without stepping on each other.

## Create Worktrees

Run from inside a repository in a normal Workforest workspace:

```sh
wf task create "fix-tests" "upgrade-dependencies"
```

Workforest creates sibling directories like `repo-fix-tests`, branches from the
primary repo's committed `HEAD`, and runs built-in repo setup initializers.

From a workspace root, pass the parent repo:

```sh
wf task create --repo next.js "fix-tests"
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
