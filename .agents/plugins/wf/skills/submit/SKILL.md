---
name: submit
description: Queue a finished Workforest feature branch for integration.
---

# Submit

Use this skill when a feature branch is done and should be queued for the local integration flow.

## Requirements

1. Confirm the current branch is not `main`.
2. Confirm the branch name starts with `tomdale/`.
3. Require a clean working tree and committed changes before enqueueing.
   If the checkout is dirty, delegate committing to the registered
   `commit` subagent before enqueueing.
4. Run `pnpm check` from the project root before handing the branch off.
5. Record the exact current `HEAD` SHA and enqueue that SHA with the bundled queue helper.

## Workflow

1. Check the branch:
   - `git branch --show-current`
   - `git status --short`
   - `git rev-parse HEAD`
2. If the branch is `main` or does not start with `tomdale/`, stop and report the branch requirement.
3. If the worktree is dirty:
   - Inspect the pending changes enough to identify what would be committed.
   - Ask whether the user wants the pending changes committed before enqueueing, unless they already asked to commit or submit the current dirty work.
   - If the user approves or already requested commit-and-submit, delegate to the registered `commit` subagent. Include the worktree path, branch name, intended scope, and `pnpm check` requirement.
   - After the subagent returns, review its reported commit SHA and remaining dirty state, then re-run `git status --short` and `git rev-parse HEAD`.
   - If the user declines, the subagent refuses because the changes are unrelated/ambiguous, or `git status --short` remains non-empty, stop and ask the user to clean, commit, or stash the remaining changes before enqueueing.
4. Require `git status --short` to be empty before continuing.
5. Run `pnpm check`.
6. Enqueue the current branch with `.agents/plugins/wf/scripts/integration-queue.mjs enqueue`.
7. Report:
   - branch name
   - queued SHA
   - queue ref path
   - stale-entry guidance if the branch is updated after enqueueing

## Notes

- The queue stores the exact commit that was validated.
- If the branch advances after enqueueing, refresh or re-enqueue before integration.
- Do not enqueue `main`.
