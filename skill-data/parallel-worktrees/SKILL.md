---
name: parallel-worktrees
description: Workforest guidance for using nested task worktrees with parallel AI subagents. Use when delegating independent tasks, creating short-lived worktrees with `wf task start`, handing paths to subagents, reviewing and integrating task branches, listing tasks, finishing tasks, or force-deleting abandoned tasks safely.
---

# Workforest Parallel Worktrees

Use Workforest tasks when multiple agents need independent branches inside the
same repository or change. A task is a nested worktree under the parent change's
reserved `_tasks` directory. It starts from the parent repository's committed
`HEAD`, gets its own branch, and can be handed to one subagent.

## Before Creating Tasks

Start from an existing Workforest change:

```sh
wf switch workforest/cli-redesign
cd ~/Code/Repos/workforest/cli-redesign
```

Make the parent repository a clean integration checkout before creating tasks:

```sh
git status --short
```

Commit or stash parent edits first. Task branches start from committed `HEAD`,
so uncommitted parent changes are not a safe delegation boundary.

## Create Task Worktrees

From inside a repository change or a repository within a workspace:

```sh
wf task start fix-tests upgrade-deps
```

Expected shape:

```text
_tasks/workforest/fix-tests
_tasks/workforest/upgrade-deps
```

From a workspace root, provide the parent repo explicitly:

```sh
wf task start --repo front fix-tests
```

If there is exactly one task, shell integration changes into it. With multiple
tasks, inspect paths with:

```sh
wf task list
```

## Delegate To Subagents

Give each subagent:

- exactly one task worktree path
- exactly one task
- one verification command
- instruction not to touch other worktrees
- instruction not to revert unrelated edits or other agents' work

Example assignment:

```text
Worktree: ~/Code/Repos/workforest/cli-redesign/_tasks/workforest/fix-tests
Task: update failing parser tests for the final command surface
Verify: pnpm exec vitest run src/cli/parse-invocation.test.ts
Do not edit the parent checkout or any sibling _tasks worktree.
```

## Integrate Task Work

Review each task from its own worktree:

```sh
cd _tasks/workforest/fix-tests
git status --short
git diff
pnpm exec vitest run src/cli/parse-invocation.test.ts
git add .
git commit -m "Fix parser tests"
```

Then merge or cherry-pick with normal Git into the parent integration checkout.
Workforest creates and removes task lanes; it does not merge code for you.

## Finish Or Delete Tasks

Use `wf task finish` after the task branch is integrated into the parent branch:

```sh
wf task finish fix-tests
```

`finish` verifies the task is clean and reachable from the parent branch, then
removes the nested worktree and local task branch.

Use `wf task delete` for intentional abandonment or intentionally unmerged work:

```sh
wf task delete upgrade-deps --force
```

Without `--force`, deletion refuses dirty or unmerged task branches.

## Full Lifecycle Reference

Read `references/subagent-lifecycle.md` for the end-to-end sequence, including
parent checkpoints, subagent assignment, review, integration, and cleanup.
