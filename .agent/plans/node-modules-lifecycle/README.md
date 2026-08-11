# Node modules lifecycle + squash-aware delete

Plans for bounding Workforest install/disk cost and fixing delete safety under squash-merge policy.

## Files

| File | What |
|------|------|
| [`ops-reliability-plan.md`](./ops-reliability-plan.md) | Ops-biased plan (subagent `0b7d36c1`): live cap, `wf reclaim`, PR proof |
| [`systems-design-plan.md`](./systems-design-plan.md) | Systems-biased plan (subagent `7e73fdc4`): acquire/borrow ownership model, caps, proof |
| [`agreed-v1.md`](./agreed-v1.md) | **Locked decisions after grilling** — first-ship scope that supersedes conflicting bits of the two drafts |

## Status

- Planning artifacts only; no implementation from the planning pass.
- Execution should follow [`agreed-v1.md`](./agreed-v1.md), using the two drafts as background design detail.
