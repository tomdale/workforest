---
name: integrate
description: Integrate queued Workforest branches into local main with conservative verification.
---

# Integrate

Use this skill when processing queued branches into local `main`.

## Requirements

1. Process queued refs one at a time from `refs/workforest/integration-ready/<timestamp>/<branch>`.
2. Detect stale queue entries before integration.
3. Compare incoming branch changes against the merge base with the current `main`.
4. Use the bundled integration auditor for read-only semantic risk review when the diff is non-trivial.
   When spawning or prompting the auditor, include this progress contract: after the
   initial diff scan, send a progress update with reviewed scope, remaining scope, and
   provisional blockers; if the final audit is not ready within 60 seconds after any
   update, send another update before continuing; repeat every 60 seconds while still
   running.
5. Preserve linear history where possible and resolve conflicts conservatively.
6. Integrate each queued entry in a dedicated worktree created and removed with
   `wf worktree`. Do not use raw `git worktree` commands for integration worktrees.
7. Run `pnpm check` before fast-forwarding `main`.
8. Hold `workforest-main.lock` while fast-forwarding local `main`.
9. Push `origin main:main` after a successful local integration.
10. After a successful push, update the original integrated branch worktree to
    the corresponding commit on `main` with the queue helper. This preserves
    the ancestry proof used by `wf finish`. The helper must skip dirty or
    missing source worktrees.
11. Do not run an extra queue-empty `pnpm check`. If the queue is empty at the
    start of the integration run, report that there is nothing to integrate and
    stop without running validation. After the final queued entry integrates, the
    lock-held check that immediately preceded the `main` fast-forward is the
    final verification for that run.

## Workflow

1. List queued entries with `.agents/plugins/wf/scripts/integration.mjs list`.
2. Pick the oldest ready entry that is not stale or already integrated.
3. Verify the queued SHA still matches the branch `HEAD`.
4. Inspect the change set relative to the current merge base and current `main`.
5. If the change is risky or broad, run the bundled auditor in read-only mode before editing.
   Paste the progress contract from the requirements into the auditor prompt. If the
   auditor stays silent past the first 60-second window, note the contract failure and
   proceed only when your own diff review shows the change is small and low risk;
   otherwise restart the auditor with the explicit contract before integrating.
6. Create a dedicated integration worktree from current `main` using the
   integration-worktree workflow below.
7. Cherry-pick the queued commits into the integration worktree in order.
8. Resolve conflicts narrowly. Do not discard unrelated local `main` changes.
9. Run `pnpm check` in the integration worktree.
10. Under the shared `workforest-main.lock`, rebase the integration branch onto
    the latest local `main`, rerun `pnpm check`, and fast-forward `main`.
11. Push `origin main:main` while holding the same shared lock.
12. Run `.agents/plugins/wf/scripts/integration.mjs sync-worktree <branch|id>`.
    If it reports `updated`, the source worktree now points at the integrated
    commit reachable from `main`. If it reports `skipped`, keep going but report
    the reason before offering `wf finish`.
13. Dequeue the integrated queue entry.
14. Remove the temporary integration worktree and delete its merged helper branch.
15. Repeat steps 2-14 until no ready queue entries remain. The lock-held
    `pnpm check` from step 10 is the final verification for the last integrated
    branch; do not rerun it solely because the queue is now empty.
16. If there were no ready queue entries when the run started, stop after
    reporting the empty queue. Do not run `pnpm check` for an empty queue.
17. After all queued integrations are complete, offer to run `wf finish` for
    every worktree integrated during this run. Run it only after the user
    confirms, and only for worktrees whose integration is verified in Git
    history.

## Integration Worktrees

Create one isolated integration worktree for every queue entry. Do not rebase a
queued branch in its existing worktree and do not disturb uncommitted changes
there. Use a unique timestamp or queue identifier in both the path and branch:

```sh
repository="$(git remote get-url origin)"
integration_path="/tmp/workforest-integrate-<queue-id>-<branch-slug>"
integration_branch="tomdale/integrate-<queue-id>-<branch-slug>"

wf worktree add "$repository" "$integration_path" "$integration_branch"
cd "$integration_path"
git merge --ff-only main
git cherry-pick <merge-base>..<queued-sha>
pnpm check
```

Before creating it, verify that the path and helper branch do not already
exist. `wf worktree add` creates a new branch from the cached repository's
current `HEAD`; `git merge --ff-only main` verifies that the helper branch is
based on the current integration base before queued commits are applied. If the
queue entry contains commits already integrated under different SHAs,
cherry-pick only the commits whose changes are not present on `main`.

For the integration commit point, hold `workforest-main.lock` continuously
while rebasing the helper branch onto the latest `main`, checking it, and
fast-forwarding the designated `main` worktree. Keep the same lock held while
pushing `origin main:main`.

After the push succeeds and the queue entry is dequeued, clean up the ephemeral
worktree with Workforest, then delete the merged helper branch:

```sh
wf worktree remove "$repository" "$integration_path"
git branch -d "$integration_branch"
```

Do not use `wf finish` for these ephemeral integration worktrees; they have no
Workforest workspace metadata. Reserve `wf finish` for the original integrated
worktrees, and only run it after user confirmation.

## Notes

- Skip or refresh stale entries before attempting to integrate them.
- Keep the integration branch linear and explicit.
- If check or merge verification fails, leave local `main` unchanged and fix the coordinator branch first.
- Keep a failed integration worktree intact for diagnosis; clean it up only after
  the entry integrates successfully or is deliberately abandoned.
- Do not offer worktree cleanup while queued integrations remain.
- Do not treat pre-lock integration-worktree checks as a substitute for the
  lock-held `pnpm check` that immediately precedes each fast-forward of `main`.
