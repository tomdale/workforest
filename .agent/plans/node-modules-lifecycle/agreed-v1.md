# Agreed v1 (post-grill)

Locked product decisions from the planning + grilling session. Where this conflicts with `ops-reliability-plan.md` or `systems-design-plan.md`, **this file wins**.

## Problem (one line)

Bound machine cost of Workforest checkouts by reaping existing pnpm `node_modules` into new worktrees and by proving squash-merged work is integrated so `wf delete` works without `--force`.

## First ship (option A only)

Ship **only**:

1. **Squash-aware integration proof** for delete / status / tasks
2. **Create-time acquire/reap** of pnpm `node_modules`

**Explicitly out of v1:**

- Numeric `maxLivePerRepo` cap
- `wf reclaim` / proactive soft reclaim command
- Hard-delete of idle worktrees
- `target/` or other non-`node_modules` artifact reuse
- Daemon GC
- patch-id / tree-equality integration proof
- Copying `node_modules` on cross-device (`EXDEV`)

Proactive cleanup and caps can follow once create-time reap + delete hygiene are real.

## Integration proof (`wf delete` without `--force`)

Worktree must be **clean**, and integrated if any of:

1. On default branch
2. `git merge-base --is-ancestor HEAD origin/<default>` (ancestry; try first, offline)
3. GitHub merged PR proof via `gh` (only if ancestry fails):
   - merged PR for this **branch**, or
   - merged PR whose **head SHA == local HEAD**
   - **Rule C:** if matched by branch name only, **refuse** when local `HEAD` is **strictly ahead** of that PR’s head SHA (continued commits after merge)

Otherwise **unproven** → require `--force`.  
`--force` copy is for abandoned/unproven work, not “always for squash.”

## Acquire order (create/setup needing deps)

```
present
  → reap/borrow evictable live   # FIRST among missing cases
  → pool restore
  → fresh install (pnpm install)
```

- **Direct borrow**: one `rename` from donor worktree → target (not pool bounce).
- Per **repo-identity** lock around decide + rename only; release before `pnpm install`.
- After acquire, run normal install/initializers so lockfile drift is repaired.
- Progress/events name source: `present` / `borrowed from <selector>` / `restored pooled` / `fresh install`.
- On `EXDEV` or race: skip that candidate; do **not** copy whole trees.

**Note:** Both planner drafts preferred pool-before-borrow. **Grilling flipped this** so new worktrees reap old lives first and create natural downward pressure on concurrent live installs without a numeric cap.

## Evictable donor (soft move of `node_modules` only)

All of:

- Eligible pnpm install (existing rules: lockfile + `node_modules/.pnpm-lockfile-hash`)
- Git clean (no porcelain)
- Not cwd / active setup target
- **Source-tree mtime ≥ 7 days**
  - Newest mtime under checkout **excluding** generated roots (`node_modules`, and cheap known dirs like `target`, `.next`, `dist` as needed)
  - **Do not** use `node_modules` mtime as activity (costly, low signal)

**Ordering among donors:**

1. Proven integrated, oldest source activity first
2. Else any other evictable (including unproven idle), oldest source activity first

Soft-evict/borrow never deletes git state. Unmerged-but-idle trees may donate installs; they must not be hard-deleted by auto paths.

## Pressure model (no live cap in v1)

- No `maxLivePerRepo` in first ship.
- Downward pressure on disk/storms:
  - **Reap on create** transfers an install instead of adding one when a donor exists
  - **Squash-aware delete** makes preserve-to-pool + whole-tree cleanup actually usable again
- Same-day agent fan-out (`wf task new` without `--setup`) remains install-free; tasks with `--setup` may temporarily add lives (acceptable without a cap).

## Scope of artifacts

- **v1 reap/borrow:** pnpm `node_modules` only.
- **`target/` and friends:** not reusable like `node_modules` (path/fingerprint coupling, weak repair story). Leave for a later **explicit cleanup** phase that frees disk without promising create-time reuse.

## Parallel implementation split (when executing)

| Lane | Scope | Seam |
|------|--------|------|
| **1. Integration proof** | `integration-proof` (+ thin `gh` helper); wire delete-safety, status, tasks; tests; help copy | No dependency on acquire |
| **2. Create-time reap** | live inventory, acquire/borrow, source-mtime eligibility, per-identity lock, pipeline + task setup call sites, tests | May prefer integrated donors via ancestry until lane 1 merges; then full proof |

Suggested execution: two Workforest task worktrees + two implementation subagents.

## Non-goals (repeat)

Live cap, reclaim CLI, hard idle-GC, multi-ecosystem borrow, daemon, EXDEV copy fallback, requiring network for the local reap/pool happy path.

## Supersedes in the drafts

| Draft idea | Agreed v1 |
|------------|-----------|
| Pool before borrow on create | **Reap live before pool** |
| `maxLivePerRepo` in first ship | **Punt** |
| Soft reclaim command in first ship | **Later** |
| ~2h hot grace / nm mtime | **7d source-tree mtime** (exclude generated) |
| Merged PR + clean ⇒ integrated | **Rule C** (branch match must not be ahead of PR head) |
| `target/` as possible heavy artifact | **Cleanup later, not borrow** |
