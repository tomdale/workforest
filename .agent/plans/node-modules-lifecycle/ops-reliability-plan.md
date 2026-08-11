# Alternative Plan: Bounded Live Cost + Squash-Aware Reclaim

Bias: **operational reliability, automatic reclaim, squash-merge-aware delete safety** — not maximum architectural elegance.

Source: plan-architect subagent `0b7d36c1` (gpt-5.6-sol). Planning only; not an approved execution packet.

---

## 1. Problem restatement

Workforest is good at minting isolated checkouts and bad at keeping a laptop usable afterward.

Three coupled failures:

1. **Create path is install-bound.**  
   `wf new` / workspace+task setup restores pooled `node_modules` when lucky (`src/workspace/pipeline.ts`, `src/workspace/tasks.ts` → `restoreNodeModules`), then runs initializers. Concurrent stamps still often cold-install. On large monorepos that is thousands of new files and endpoint-security write storms. There is **no live-install budget** and no eviction of idle installs before creating another.

2. **Disk is unbounded unless the human remembers delete.**  
   Pooling only runs on successful preserve paths in delete/cleanup (`src/workspace/cleanup.ts` → `preserveNodeModules`). Pool retention is capped (`maxRetainedPerRepo` default 3 in `src/node-modules-cache.ts`), but **live** worktrees keep full trees forever. `wf cache clean` reclaims unused mirrors + the pool (`src/repository-cli.ts`), not live installs. Forgetting `wf delete` is catastrophic (100s of GB).

3. **“Integrated” is ancestry-only, so squash merges always force.**  
   Delete safety and status both use `merge-base --is-ancestor HEAD origin/<default>` (`src/workspace/delete-safety.ts`, `src/workspace/status.ts`). Tasks use the same idea against parent `HEAD` (`src/workspace/tasks.ts`). Squash/rebase integration destroys ancestry; docs/CLI already punt to `--force` (`src/cli/delete.ts`). That makes safe reclaim socially hard: people either keep garbage or force-delete and hope.

Existing machinery is enough to build on: rename pool, inventory mtimes, setup concurrency cap, `gh` already used elsewhere. Missing pieces are **live budget + reclaim loop + PR-aware integration**.

---

## 2. Target end-state UX / behavior

### `wf new` / task create

- Still creates the worktree and runs setup.
- Before install:
  1. Try pool restore (existing).
  2. If this repo identity is at/over **live `node_modules` cap**, **soft-evict** oldest *idle, clean, unprotected* live installs into the pool (rename preserve), then restore newest eligible pool entry into the new tree.
  3. Only then run `pnpm install` (ideally closer to incremental/up-to-date than cold tree).
- Emit explicit progress: `reclaimed node_modules from <selector>`, `restored pooled node_modules`, `install`.
- Never touches dirty/pinned/in-use trees during auto soft-evict.
- Does **not** auto-delete whole worktrees on create (too surprising).

### `wf delete`

- Safety uses a **layered integration verdict**, not ancestry alone:
  - **local-positive:** on default branch, or `HEAD` ancestor of `origin/<default>`
  - **github-positive:** associated PR is merged (branch and/or head SHA)
  - **unknown / negative:** residual `--force` with clearer copy
- Dry-run / blocker text names the proof (`integrated via ancestry` vs `integrated via merged PR #123`) so squash stops feeling like a special case.
- Preserve-to-pool behavior unchanged and remains the default on delete.

### Idle reclaim

- New operator command, e.g. **`wf reclaim`**:
  - default: plan + execute **soft** reclaim (strip/`preserve` live `node_modules` over budget / past idle TTL)
  - `--dry-run`: full plan, no FS changes
  - `--delete-integrated`: also remove clean, integrated, idle, unpinned worktrees/workspaces via existing cleanup path
  - optional hooks: run soft reclaim automatically when create exceeds budget; optional “after successful operations” best-effort pass
- Two intensities:
  - **Soft:** only `node_modules` → pool (worktree stays; git history stays)
  - **Hard:** full delete through existing cleanup (integrated + clean + idle + not protected only)

### Status / list

- `wf status` shows integration **reason** and reclaim eligibility, not just `integrated` / `not integrated`.
- Global or list footers surface: live installs per repo, pool size, reclaim candidates (e.g. `3 live nm · 2 idle · 1 integrated reclaimable`).
- Pin affordance: `wf pin <selector>` / `wf unpin` (or metadata flag) so automatic soft/hard reclaim skips favorites.

### What “forgetting cleanup” feels like

- Soft budget makes create self-limiting: oldest idle installs fall back into the pool.
- Periodic/manual `wf reclaim` (and optional auto soft pass) keeps disk from being a land fill.
- Squash-merged branches become first-class delete/reclaim targets without `--force`.

---

## 3. Design options considered

### Option A — Live install budget + soft eviction + PR-aware integration *(recommended)*

**Shape:** Cap live `node_modules` per repo identity; evict oldest idle installs into the existing rename pool; add `wf reclaim`; unify integration detection (ancestry fast-path + `gh` merged PR).

| Pros | Cons |
|---|---|
| Reuses `preserve`/`restore` and cleanup delete path | Soft-evict can surprise if “idle” is wrong (mitigate with dirty/pin/in-use/TTL) |
| 80% disk + install-storm relief without exotic FS | PR lookup needs `gh` auth; must degrade cleanly |
| Incremental: integration and reclaim ship independently | Doesn’t eliminate install cost when lockfile changed a lot |
| Observable CLI (`--dry-run`, status reasons) | Hard delete still opt-in at first |

### Option B — Aggressive auto-GC of whole worktrees (TTL daemon / every command)

**Shape:** Background or frequent auto-delete of integrated (and maybe any clean idle) worktrees.

| Pros | Cons |
|---|---|
| Strongest disk bound | Highest surprise / data-loss risk |
| Matches “forgettable cleanup” literally | Needs robust in-use + pin from day one |
| | Still needs PR integration or squash remains stuck |
| | More product surface before core budget exists |

### Option C — Shared content-addressed / hardlinked `node_modules` store

**Shape:** One physical install tree, many worktrees via links or virtual store tricks beyond pnpm’s own store.

| Pros | Cons |
|---|---|
| Best theoretical create cost | Exotic FS, plugin/initializer coupling, hard to reason about |
| | Large rewrite; doesn’t fix delete/squash UX |
| | Easy to over-engineer past the operational win |

### Recommendation

**Option A**, with a **thin Option B hard-delete mode behind an explicit flag/config**, not a daemon.

Why: the repo already has the hard parts of A (pool rename, inventory, delete cleanup, `gh`). Soft eviction bounds live cost even when humans never delete. PR-merged detection unblocks both manual delete and hard reclaim under squash. Fancy shared stores can wait until A’s metrics still hurt.

---

## 4. Concrete module / API changes (against current code)

### 4.1 Shared integration verdict

**New:** `src/workspace/integration.ts` (name flexible)

```ts
type IntegrationProof =
  | { status: true; via: "default-branch" | "ancestry" | "github-pr"; detail?: string }
  | { status: false; via: "ancestry"; detail?: string }
  | { status: null; via: "unavailable"; detail?: string }; // indeterminate

isRepoIntegrated({ cwd, branch, defaultBranch, headSha? }): Promise<IntegrationProof>
isBranchIntegrated({ repoDir, branch, baseRef }): Promise<IntegrationProof>
```

**Algorithm (ordered):**

1. `branch === defaultBranch` → true (`default-branch`)
2. `git merge-base --is-ancestor <ref> origin/<default>` → true (`ancestry`) — keep as **fast local positive only**
3. If still false/unknown and GitHub remote + `gh` available:
   - `gh pr list --repo <owner/name> --head <branch> --state merged --json number,url,mergedAt,headRefOid`
     and/or match current HEAD OID to a merged PR head
   - merged PR → true (`github-pr`, include `#N`)
4. Else false (ancestry negative, no PR proof) or null if remote/default/gh cannot be evaluated

**Wire into:**

- `src/workspace/delete-safety.ts` (replace private `isIntegrated`)
- `src/workspace/status.ts` (same; extend `RepositoryStatus` / task status with `integration?: IntegrationProof`)
- `src/workspace/tasks.ts` (`isBranchMerged` / delete task gates)
- Prefer also `src/workspace/cleanup.ts` remote-branch “merged” check (today `git log origin/main..origin/branch` — also squash-blind)

**GitHub helper:** small wrapper near existing usage

- Reuse patterns from `src/services/template-suggestions.ts` (`gh pr view --json …mergedAt`) and `src/review.ts`
- Prefer `src/services/github.ts` (new) over bloating template-suggestions

### 4.2 Live install inventory + budget

**Extend:** `src/node-modules-cache.ts` and/or new `src/workspace/node-modules-live.ts`

```ts
listLiveNodeModulesInstalls(inventory): Promise<LiveInstall[]>
// LiveInstall: { selector, repoIdentity, repoDir, mtimeMs, sizeBytes? }

countLiveByRepoIdentity(...)
enforceLiveNodeModulesBudget({
  repo,
  maxLivePerRepo,
  protect: (install) => boolean, // dirty/pin/in-use/current target
}): Promise<BudgetEnforcementResult> // preserves excess into pool (oldest idle first)
```

Eligibility for soft-evict target (to strip):

- has eligible pnpm install (same rules as preserve: lockfile + `.pnpm-lockfile-hash`)
- clean git worktree (or at least no need to run install while dirty — **require clean** for auto paths)
- not pinned
- not in-use
- idle by `modifiedAtMs` / optional `lastAccessedAt` ≥ TTL **or** over hard cap (cap can ignore TTL when create must proceed; still never dirty/pinned/in-use)

**Call sites:**

- `src/workspace/pipeline.ts` before `restoreNodeModules` / initializers
- `src/workspace/tasks.ts` task setup path (same)
- `wf reclaim` soft mode

Keep pool prune as-is (`maxRetainedPerRepo`).

### 4.3 Reclaim planner / executor

**New:** `src/workspace/reclaim.ts`

```ts
planReclaim(options) -> ReclaimPlan
executeReclaim(plan, { dryRun }) -> ReclaimResult
```

Plan rows:

- `soft-node-modules` → `preserveNodeModules`
- `hard-delete` → existing `cleanupWorktree` / `cleanupWorkspace` (only if integration true + clean + idle + unpinned + not in-use)

**CLI:** `src/cli/reclaim.ts` + registry in `src/cli/commands.ts`  
Flags: `--dry-run`, `--node-modules-only` (default intent), `--delete-integrated`, maybe `--selector`, `--force` **does not** bypass dirty for hard delete unless we explicitly document abandon (prefer refuse; force already exists on `wf delete`).

### 4.4 Protection / activity signals

**Minimal v1 (no new daemon):**

- **Dirty:** existing porcelain checks in delete-safety/status
- **Pinned:** workspace/worktree metadata flag in `src/workspace/metadata.ts` + `wf pin`/`unpin` or `wf reclaim --pin` later; file marker `.workforest/keep` is acceptable if metadata change is heavier
- **In-use:**
  - selector path is cwd or ancestor of cwd
  - optional: current shell cd target if already known
  - skip trees with git/index locks
  - do **not** require `lsof` in v1
- **Idle:** inventory `modifiedAtMs` (`src/workspace/inventory.ts` newest mtime) + optional touch on `wf switch` / successful setup completion later

### 4.5 Config surface

Types in `src/types.ts`, defaults/normalization in `src/configuration-registry.ts`, tests in `src/config.test.ts`.

### 4.6 Observability

- `src/workspace/status.ts` / render: integration via + “reclaim: soft|hard|protected”
- `src/cli/delete.ts` blocker copy: drop “use --force only for squash…” as primary guidance; mention PR auth / `--force` for true unknowns
- `src/repository-cli.ts` cache summary: live vs pooled counts if cheap
- README / command help updates in the same checkpoints as behavior

### 4.7 Tests (anchor to existing suites)

- `src/cli.delete.test.ts` — squash-merged PR allows delete without `--force`
- `src/cli.status.test.ts` — proof labels
- `src/node-modules-cache.test.ts` — live budget eviction order
- new `src/workspace/integration.test.ts`, `src/workspace/reclaim.test.ts`
- `src/cli.reclaim.test.ts` dry-run / protect dirty / pin
- task merge gates in `src/workspace/tasks.ts` tests

---

## 5. Safety model

### Never auto soft-evict (`node_modules` → pool)

- Dirty worktree
- Pinned / keep marker
- In-use (cwd / active target / index lock)
- Ineligible install (no marker / not pnpm) — skip, don’t half-delete
- Target of the in-flight create (never evict the tree we’re setting up)

Soft-evict **may** run on clean unintegrated idle trees when over **hard live cap** (disk/install storm control). Git objects stay; cost is reinstall on return. This is intentional and must be visible in logs.

### Never auto hard-delete (full worktree/workspace)

- Anything soft rules would block
- Integration not **proven true** (ancestry or merged PR)
- Nested unmerged tasks (reuse delete blockers)
- `autoDeleteIntegrated` false / flag not passed
- Indeterminate integration (`null`) — no silent delete; surface “couldn’t prove”

### How squash-merged work becomes safely reclaimable

1. User merges PR via squash on GitHub.
2. Local ancestry fails (today’s false “not integrated”).
3. New detector finds merged PR for branch/head → `integrated via github-pr #N`.
4. `wf delete` and `wf reclaim --delete-integrated` treat it like a merge commit integration.
5. Cleanup still preserves `node_modules` into the pool.
6. Residual true unknowns (merged without PR, pure cherry-pick, gh missing) keep **`--force`** with tighter messaging.

### Operator transparency

- Every reclaim path supports `--dry-run` plan first.
- Status shows *why* protected vs reclaimable.
- No background daemon in v1 (surprise minimization).

---

## 6. Config surface

Extend existing cache config; add a small reclaim block (avoid over-nesting).

```ts
// types.ts (additive)
NodeModulesCacheConfig {
  enabled?: boolean;
  maxRetainedPerRepo?: number; // pool, default 3 (existing)
  maxLivePerRepo?: number;     // NEW, default 4 (or 3)
}

ReclaimConfig {
  /** Idle age before TTL-based soft reclaim considers a tree. Default 7d. */
  idleAfterDays?: number;
  /** Soft-evict automatically when create exceeds maxLivePerRepo. Default true. */
  evictOnCreate?: boolean;
  /** Allow hard-delete of proven-integrated idle trees via `wf reclaim --delete-integrated`. Default true for flag enablement; auto hard-delete default false. */
  allowDeleteIntegrated?: boolean;
  /** If true, `wf reclaim` without flags may hard-delete; default false. */
  autoDeleteIntegrated?: boolean;
}

WorkspaceConfig {
  cache?: CacheConfig;
  reclaim?: ReclaimConfig;
  // ...
}
```

**Registry defaults (`configuration-registry.ts`):**

- `cache.nodeModules.maxLivePerRepo: 4`
- `reclaim.idleAfterDays: 7`
- `reclaim.evictOnCreate: true`
- `reclaim.allowDeleteIntegrated: true`
- `reclaim.autoDeleteIntegrated: false`

Env overrides optional later (`WORKFOREST_MAX_LIVE_NODE_MODULES`); not required for v1 if config + flags suffice. Setup concurrency (`setup.maxConcurrent`, default 4 in `setup-limits.ts`) stays as a separate storm control.

---

## 7. Sequenced checkpoints (independently verifiable)

### CP1 — Shared integration detector + delete/status/task wiring

**Goal:** Squash-merged PRs delete without `--force`; ancestry still short-circuits.  
**Touch:** `integration.ts`, `github` helper, `delete-safety.ts`, `status.ts`, `tasks.ts`, delete/status tests, help copy.  
**Verify:** unit tests with mocked `gh` + git; `pnpm test` focused suites; manual mental cases: ancestry yes; squash PR yes; no PR no; gh down → false/null with force remaining.  
**Ship value:** immediate human relief on delete.

### CP2 — Live install listing + create-time budget soft-evict

**Goal:** Creating beyond `maxLivePerRepo` preserves oldest idle clean installs into pool before restore/install.  
**Touch:** live inventory helper, `node-modules-cache`/`pipeline`/`tasks`, config fields, tests.  
**Verify:** fixture with N live installs; create N+1; assert oldest preserved + new restore/install path; dirty/pinned skipped.  
**Ship value:** reduces install storms and live disk growth even without reclaim command.

### CP3 — `wf reclaim --dry-run` + soft execute

**Goal:** Operator-visible plan; soft reclaim by idle TTL and/or over-cap.  
**Touch:** `reclaim.ts`, `cli/reclaim.ts`, commands/help, tests.  
**Verify:** dry-run JSON/human plan stable; execute only soft rows; pool entry count/size moves.  
**Ship value:** forgetful cleanup becomes a one-command habit / scriptable cron.

### CP4 — Hard delete integrated idle (explicit flag)

**Goal:** `wf reclaim --delete-integrated` uses same safety as delete + idle/pin/in-use.  
**Touch:** reclaim planner → `cleanupWorktree`/`cleanupWorkspace`; reuse delete blockers.  
**Verify:** integrated clean idle deleted; dirty/unintegrated/pinned refused; node_modules preserved.  
**Ship value:** full disk reclaim without remembering each selector.

### CP5 — Observability + pin

**Goal:** status/list show live nm pressure, integration via, reclaim eligibility; pin/unpin.  
**Touch:** status render, inventory/list footer, metadata pin, tiny CLI.  
**Verify:** render tests; pin blocks reclaim tests.  
**Ship value:** no surprising silent loss; operable without reading code.

### CP6 — Polish / optional auto hooks

**Goal:** touch `lastAccessed` on switch; optional post-command soft reclaim; cleanup remote-branch squash parity; docs.  
**Verify:** switch updates activity; remote branch delete accepts PR-merged.  
**Ship value:** smoother defaults; not required for first relief.

**Parallelization:** CP1 ∥ early CP2 scaffolding after config types land; CP3 depends on CP2 helpers; CP4 depends on CP1+CP3; CP5 can follow CP1 partially in parallel with CP3.

---

## 8. Risks, open questions, non-goals

### Risks

- **`gh` latency/auth flakiness** on every status/delete → cache proof per branch short TTL; ancestry first; status may show “checking” only when needed; delete should try PR when ancestry false.
- **Wrong idle signal (mtime)** → recent read-only use may look idle; pin + in-use cwd + conservative TTL; later touch on switch.
- **Soft-evict during agent run in another worktree** → in-use detection incomplete without process scan; document pin; refuse if index lock.
- **Multi-repo workspaces** → budget is **per repo identity** (remote hash), not per workspace folder; one workspace can hold multiple identities.
- **Pool churn** → evict-to-pool then prune `maxRetainedPerRepo` may drop useful trees; consider slightly raising default pool retain when live cap ships, or prefer restore of matching lock hash (today restore is “newest entry”, not lock-hash match — **pre-existing gap**).
- **Lock-hash mismatch after restore** → install still runs (OK); storm reduced only when deps similar.

### Open questions

1. Default `maxLivePerRepo`: **3 vs 4 vs 6** for monorepo agents? (Recommend **4** live + **3** pooled.)
2. Should over-cap soft-evict ignore idle TTL on create? (**Yes**, else create cannot bound storms.)
3. Task worktrees: count each task install toward live cap? (**Yes** — they are real trees.)
4. PR match key: branch name only vs head SHA vs either? (**Either**; SHA helps renamed branches.)
5. Offline mode: integration null vs false for delete? (**false with message “cannot verify; use --force if sure”** keeps current refuse-by-default.)
6. Pin UX: metadata vs `.workforest/keep`? (Prefer metadata if list/status already read it; file marker is fine MVP.)
7. Should `wf cache clean` mention live reclaim and defer to `wf reclaim`?

### Non-goals

- Content-addressed or hardlinked global `node_modules` FS tricks
- Replacing pnpm’s content store
- Background GC daemon / launchd agent
- Auto-hard-delete by default
- Perfect cross-host locking
- Guaranteeing zero `pnpm install` after restore
- Non-pnpm package managers in the pool (keep current eligibility)
- Changing mirror blobless clone design

---

## 9. Rough effort and what ships first

| Checkpoint | Rough effort | Relief |
|---|---|---|
| CP1 integration + delete/status | **1–2 days** | Stops squash `--force` tax; enables safe hard reclaim later |
| CP2 live budget on create | **2–3 days** | Biggest anti-storm + live disk win |
| CP3 `wf reclaim` soft | **1–2 days** | Operable bound without remembering each delete |
| CP4 hard reclaim flag | **1 day** | Full cleanup automation |
| CP5 status/pin polish | **1 day** | Trust / observability |
| CP6 niceties | **0.5–1 day** | Quality |

**Total to strong v1 (CP1–CP4):** ~1–1.5 weeks focused.  
**Max relief first ship:** **CP1 + CP2** in one release slice, then CP3 immediately after.

That order is deliberate under this bias:

1. Make integrated-or-not *true* under squash (otherwise reclaim/delete stay socially broken).
2. Bound live installs on the create path (fixes pain without depending on human cleanup).
3. Give a dry-runnable reclaim command so forgetfulness isn’t fatal.
4. Only then auto-delete whole trees.

---

## Architecture sketch (dependency direction)

```text
cli/delete, cli/reclaim, cli/status
        ↓
workspace/delete-safety, workspace/reclaim, workspace/status, workspace/tasks
        ↓
workspace/integration  →  services/github (gh pr) + services/git (ancestry)
        ↓
node-modules-cache (preserve/restore/pool) + workspace/cleanup (hard delete)
        ↑
workspace/pipeline (create): enforceLiveBudget → restore → install
```

No new global lock service: reclaim/create use **rename is atomic enough** on same FS volume (already assumed by pool); if preserve fails, skip that candidate and try next (best-effort), never brick create.

---

## Summary decision

Build a **boring garbage collector for live cost**:  
prove integration with **PR state + ancestry**, **cap live `node_modules`**, **evict idle installs into the existing pool**, and expose **`wf reclaim --dry-run`** before any aggressive whole-tree GC.

That matches Workforest’s current architecture, ships relief in small verifiable cuts, and avoids exotic elegance that doesn’t unwedge squash delete or install storms.
