---
name: parallel-worktrees
description: Workforest guidance for using temporary sibling worktrees with parallel AI subagents. Use when delegating independent tasks, creating short-lived worktrees with `wf worktree <slug...>`, handing paths to subagents, reviewing and merging subagent branches, listing temp worktrees, or cleaning them up safely.
---

# Workforest Parallel Worktrees

Use temporary Workforest worktrees when multiple agents need to modify the same
repo without stepping on each other.

## Create Worktrees

Run from inside a repository in a normal Workforest workspace:

```sh
wf worktree "fix-tests" "upgrade-dependencies"
```

Workforest creates sibling directories like `repo-fix-tests`, branches from the
primary repo's committed `HEAD`, and runs built-in repo setup initializers.

Managed single-repo checkouts use a different contextual workflow:

```sh
wf worktree new "fix-tests"
# shorthand: wf worktree "fix-tests"
```

Those siblings live under `defaultDir/<repo>/<name>` and start from the remote
default branch. Use `wf worktree promote` when one should become a normal
workspace.

From a workspace root, pass the parent repo:

```sh
wf worktree --repo next.js "fix-tests"
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
wf worktree list
wf worktree rm "fix-tests"
```

Removal refuses dirty or unmerged worktrees unless `--force` is explicitly used.
