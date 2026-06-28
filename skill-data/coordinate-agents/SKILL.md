---
name: coordinate-agents
description: Workforest guidance for delegating parallel subagents with task worktrees.
---

# Coordinate Agents

Use this skill when you want independent subagents to work inside the same
worktree or workspace without stepping on one another.

```sh
wf task new fix-tests upgrade-deps
wf task list
wf task delete fix-tests
wf task delete upgrade-deps --force
```

Use `wf task --help` for the exact task syntax.

## Delegate Narrowly

- Give each agent exactly one task worktree path.
- Give each agent exactly one task.
- Give each agent one verification command.
- Tell each agent not to edit sibling worktrees or the parent checkout.

## Keep The Parent Clean

- Create tasks from a committed parent `HEAD`.
- Commit or stash unrelated parent edits before you split work.
- Review task diffs from inside the task worktree, then integrate them with
  normal Git.

## Finish The Tasks

- Use `wf task delete` after the task branch is merged or cherry-picked.
- Use `wf task delete --force` only for intentional abandonment.
