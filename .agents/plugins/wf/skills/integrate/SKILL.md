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
   Tell the auditor to report progress after its initial diff scan and at least every
   60 seconds during long audits.
5. Preserve linear history where possible and resolve conflicts conservatively.
6. Run `pnpm build` before fast-forwarding `main`.
7. Hold `workforest-main.lock` while fast-forwarding local `main`.
8. Push `origin main:main` after a successful local integration.
9. After the integration queue is fully processed, always run `pnpm build` in the `main` worktree.

## Workflow

1. List queued entries with `.agents/plugins/wf/scripts/integration-queue.mjs list`.
2. Pick the oldest ready entry that is not stale or already integrated.
3. Verify the queued SHA still matches the branch `HEAD`.
4. Inspect the change set relative to the current merge base and current `main`.
5. If the change is risky or broad, run the bundled auditor in read-only mode before editing.
   Include an explicit progress contract in the auditor prompt: report files reviewed,
   remaining scope, and provisional blockers after the initial scan and every 60
   seconds while still running.
6. Rebase or cherry-pick the queued work onto the current integration base.
7. Resolve conflicts narrowly. Do not discard unrelated local `main` changes.
8. Run `pnpm build`.
9. Under the shared `workforest-main.lock`, fast-forward `main` to the integrated result.
10. Push `origin main:main`.
11. Dequeue the integrated queue entry.
12. Repeat steps 2-11 until no ready queue entries remain.
13. From the `main` worktree, run `pnpm build` once more after the queue is complete. Run this final build even when the queue was already empty and no entries were integrated.
14. After all queued integrations are complete, offer to run `wf finish` for
    every worktree integrated during this run. Run it only after the user
    confirms, and only for worktrees whose integration is verified in Git
    history.

## Notes

- Skip or refresh stale entries before attempting to integrate them.
- Keep the integration branch linear and explicit.
- If build or merge verification fails, leave local `main` unchanged and fix the coordinator branch first.
- Do not offer worktree cleanup while queued integrations remain.
- Do not treat per-entry builds as a substitute for the final build of the completed queue on `main`.
