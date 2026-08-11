# Plan: Bounded Install Lifecycle for Workforest

Bias: **systems design** — install reuse architecture, global resource bounds, and principled lifecycle ownership of `node_modules`.

Source: plan-architect subagent `7e73fdc4` (gpt-5.6-sol). Planning only; not an approved execution packet.

---

## 1. Problem restatement

Workforest is excellent at *creating* isolated checkouts and weak at *owning the machine cost of their dependencies*.

Three coupled failures:

1. **Create path is install-heavy.** New worktrees restore from a *delete-time pool only*. If the pool is empty or cold, every stamp pays a full `pnpm install` and endpoint scanners see a write storm.
2. **Live installs are unbounded.** `maxRetainedPerRepo` caps *pooled* trees (default 3). Nothing caps how many eligible `node_modules` sit in managed worktrees. Disk and scanner pressure grow with forgotten checkouts, not with intentional deletes.
3. **Delete/reclaim safety is squash-blind.** `isIntegrated` in `src/workspace/delete-safety.ts` (and the twin in `src/workspace/status.ts`) is `merge-base --is-ancestor HEAD origin/<default>`. Squash-merge policy makes that false for finished work, so `wf delete` demands `--force` and automatic reclaim cannot trust “done.”

Existing machinery is the right substrate: rename-based pool (`src/node-modules-cache.ts`), restore-before-install (`src/workspace/pipeline.ts`, `src/workspace/tasks.ts`), preserve-on-delete (`src/workspace/cleanup.ts`, `src/cli/delete.ts`). What’s missing is **lifecycle ownership of live installs** and **integration proof that matches real merge policy**.

---

## 2. Target end-state UX / behavior

### `wf new` / worktree + workspace setup

1. Create git worktree as today.
2. **Acquire** `node_modules` before initializers:
   - already present → keep
   - else **pool restore** (current path)
   - else **borrow** by soft-evicting an eligible cold live install for the same repo identity (rename into target)
   - else miss → fresh `pnpm install`
3. If live count would exceed the per-repo live cap, **force a soft eviction first** (preserve into pool or borrow into the new tree) before any fresh install.
4. Then run `pnpm install` as today so lockfile drift is repaired cheaply on a reused tree.
5. Progress/events mention source: `restored pooled node_modules` / `reused node_modules from <selector>` / `fresh install`.

### `wf delete`

1. Integration check uses **layered proof** (ancestry → GitHub merged PR for branch → unknown).
2. Squash-merged PRs delete **without `--force`** when the worktree is clean and proof succeeds.
3. Preserve `node_modules` into the pool as today; pool prune still applies.
4. `--force` remains the explicit abandon path for dirty/unknown/unmerged work.
5. Blocker copy stops claiming squash always needs `--force`; it says force is for abandoned/unproven work.

### Background / opportunistic reclaim (no long-running daemon v1)

Triggered on:

- install acquire under pressure (`wf new`, task setup with `--setup`)
- `wf delete` completion
- explicit `wf cache reclaim` (or extended `wf cache clean`)
- optionally `wf cache doctor`

Behavior under pressure, in order:

1. Soft-evict excess **live** installs into the pool (worktree stays; only `node_modules` moves).
2. Prune pool beyond `maxRetainedPerRepo`.
3. **Optional aggressive mode** (explicit command/flag, not default silent): delete clean + proven-integrated idle worktrees/workspaces after a grace period.

Never soft-evict or hard-delete: dirty trees, unproven unintegrated branches, paths with active setup, or “hot” trees (see invariants).

### Status / cache surfaces

- `wf cache list` / `show`: pool summary **plus** live install counts per repo identity, pressure vs caps.
- `wf status`: integration shows proven-via-ancestry vs proven-via-PR vs unproven; optional install presence.
- `wf cache doctor`: warns when live installs ≫ cap, when pool is empty while many cold lives exist, when `gh` auth missing and many unproven branches look squash-shaped.
- `wf delete --dry-run`: shows which proof method would clear integration.

### Tasks

- Default `wf task new` still skips setup (no install storm for agent fan-out).
- `wf task new --setup` and `wf task delete` use the same acquire/preserve + squash-aware merge proof.

---

## 3. Design options

### Option A — “Better pool only”

Improve pool hit rate: larger `maxRetainedPerRepo`, preserve on more paths, maybe pre-warm pool from idle trees only when user runs a clean command.

| Pros | Cons |
|------|------|
| Small diff; low risk | Does not bound *live* installs |
| | Create path still storms when pool empty |
| | Forgetting `wf delete` still catastrophic |
| | Squash delete pain untouched unless done separately |

**Verdict:** necessary but insufficient.

### Option B — Unified install ownership: pool + live borrow/evict (recommended)

Treat eligible `node_modules` as a **single scarce resource** per repo identity with two residences: **live** (in a worktree) and **pooled** (cache). Acquire prefers move over create. Live count is capped. Soft eviction is the default pressure valve; full worktree delete stays explicit/safe.

| Pros | Cons |
|------|------|
| Directly attacks write storms (rename ≫ install) | Needs safe “hot/cold” classification |
| Bounds disk without requiring perfect delete hygiene | Cross-device rename edge cases |
| Extends existing pool primitives | Needs lock to serialize acquire/evict |
| Squash proof unlocks both delete UX and reclaim | `gh` dependency for common squash case |
| Fits Workforest opinions (convention, few knobs) | |

**Verdict: recommended.**

### Option C — Content-addressed / shared virtual `node_modules`

Deduplicate at file level beyond pnpm’s store (e.g. global linker, reflinks, custom store layout).

| Pros | Cons |
|------|------|
| Maximum theoretical savings | Large new subsystem; pnpm already shares content store |
| | Endpoint scanners often still see per-tree file creates/links |
| | High complexity vs Workforest’s rename pool |

**Verdict:** non-goal now. pnpm’s content store already helps download cost; the pain is **tree materialization + live cardinality**.

### Option D — Automatic hard-delete of idle worktrees (LRU GC of checkouts)

Cap worktrees themselves; delete integrated idle ones aggressively.

| Pros | Cons |
|------|------|
| Strong disk bound | Surprising data loss surface |
| | Doesn’t help create path until something is deleted |
| | Fights “many parallel agents” workflow |

**Verdict:** optional later **explicit** `wf prune` policy, not the core install architecture. Soft-evict installs first.

### Recommendation

**Option B**, with squash-aware integration proof as a shared primitive used by delete, status, task merge checks, and reclaim eligibility. Keep hard worktree GC out of the default path.

---

## 4. Concrete module / API changes (against current code)

### New: `src/services/integration-proof.ts` (+ tests)

Shared proof used by delete-safety, status, tasks, reclaim.

```ts
type IntegrationProof =
  | { status: "integrated"; method: "default-branch" | "ancestor" | "github-pr"; detail?: string }
  | { status: "not-integrated"; method: "ancestor" }
  | { status: "unknown"; reason: "no-base" | "gh-unavailable" | "gh-error" | "no-branch" };
```

API sketch:

- `proveHeadIntegrated({ cwd, branch, defaultBranch, base, github?: GhClient })`
- Precedence in §6
- Pure-ish core with injected `runGit` + optional `runGh`

**Call sites to switch off local duplicates:**

- `src/workspace/delete-safety.ts` → `isIntegrated`
- `src/workspace/status.ts` → `isIntegrated`
- `src/workspace/tasks.ts` → `isBranchMerged` / `isTemporaryBranchMerged`
- `src/workspace/cleanup.ts` → `isBranchMerged` (remote branch delete path; keep fetch behavior explicit)

### Expand: `src/node-modules-cache.ts` → install lifecycle (keep filename or split)

Prefer **split** for clarity once it grows:

| Module | Responsibility |
|--------|----------------|
| `src/node-modules-cache.ts` | Pool I/O only: preserve/restore/list/prune/delete (existing) |
| `src/node-modules-lifecycle.ts` **new** | Live inventory, acquire, soft-evict, pressure, locks |
| `src/node-modules-lifecycle.test.ts` | Unit tests with temp dirs + fake inventory |

If split feels heavy for checkpoint 1, grow lifecycle functions inside `node-modules-cache.ts` then extract—but target end state is the split.

**New APIs:**

```ts
// Discovery
listLiveNodeModulesInstalls(config): Promise<LiveInstall[]>
// LiveInstall: { repoIdentity, repo: RepositorySource, hostSelector, hostPath, nodeModulesPath,
//   mtimeMs, dirty, integration: IntegrationProof, hot: boolean, kind: "worktree"|"workspace-repo"|"task" }

// Pressure
countLiveInstalls(identity): number
// Acquire for a target that needs deps
acquireNodeModules({ repo, repoDir, config, disabledInitializers, excludePaths? }): AcquireResult
// AcquireResult statuses: disabled | ineligible | present | restored | borrowed | missing | warning

// Pressure relief without full worktree delete
softEvictNodeModules({ install, config, reason }): Preserve-like result
reclaimNodeModulesPressure({ repo? , config }): ReclaimReport
```

**Change `restoreNodeModules` usage:**

- `src/workspace/pipeline.ts` (~L161): `restoreNodeModules` → `acquireNodeModules`
- `src/workspace/tasks.ts` (~L767): same

**Preserve path stays:**

- `src/workspace/cleanup.ts` `preserveNodeModulesForPath`
- task delete preserve paths in `tasks.ts`

**Locking:** file lock under `getCacheDir()/_node-modules/.locks/<identity>.lock` (reuse patterns from `src/services/worktree.ts` / metadata locks) so concurrent `wf new` / agents don’t double-borrow the same live tree.

### Inventory bridge

- `src/workspace/inventory.ts` `collectInventory` — reuse to find host paths; lifecycle maps inventory → per-repo paths (workspace repo dirs, standalone worktrees, tasks via metadata).
- May add a thin helper `listManagedRepoCheckouts(config)` in `src/workspace/inventory.ts` or lifecycle module to avoid duplicating directory walks.

### Delete / CLI

- `src/cli/delete.ts`: blocker text; proof method in dry-run plan JSON (`integratedBy?: ...`).
- `src/cli/commands.ts`: help text for delete/cache; stop documenting squash as always `--force`.
- `src/repository-cli.ts`: cache list/doctor/reclaim surfaces.
- New handler path: `cache.reclaim` **or** extend `cache.clean` with install pressure (prefer **`wf cache reclaim`** so `clean` stays “unused mirrors”).

### Config / types

- `src/types.ts` `NodeModulesCacheConfig`
- `src/configuration-registry.ts` defaults + docs
- `src/config.test.ts`, reference docs tests

### GitHub helper

- Extract minimal `runGh` / PR-by-head query from patterns in `src/services/template-suggestions.ts` into something reusable, e.g. `src/services/github-cli.ts`, **without** pulling template-suggest AI baggage.
- Review already shells to `gh`; keep one execution helper.

### Tests (primary)

- `src/node-modules-cache.test.ts` — keep pool contracts
- `src/node-modules-lifecycle.test.ts` — acquire order, cap, hot skip, lock
- `src/services/integration-proof.test.ts` — precedence matrix with mocked git/gh
- `src/cli.delete.test.ts` — squash-merged clean delete without force
- `src/workspace/pipeline.test.ts` / tasks tests — acquire mock
- Focused integration only if unit seams are insufficient

---

## 5. Data model / invariants

### Residences

For each **repo identity** = `sha256(normalizeRemote(remote))` (existing `repoIdentity`):

| Residence | Location | Counts toward |
|-----------|----------|----------------|
| Live | `<managed-checkout>/node_modules` with eligibility markers | `maxLivePerRepo` |
| Pooled | `$WORKFOREST_CACHE_DIR/_node-modules/<identity>/<entry>/node_modules` | `maxRetainedPerRepo` |

Eligibility (unchanged): pnpm lockfile in checkout + `node_modules/.pnpm-lockfile-hash`.

### Ownership rules

1. **At most one owner path** for a given physical tree: rename move, never copy, never hardlink whole tree.
2. **Acquire is atomic under per-identity lock:** decide source → rename → release lock → then `pnpm install` outside lock (install can be slow; don’t hold global lock across network).
3. **Soft-evict** only when host is **evictable**:
   - clean git status (no porcelain)
   - not **hot**
   - not the acquire target / not in `excludePaths`
   - preferred: integration proven; allowed fallback when over hard cap: clean + cold + **unproven** only if we soft-evict (keep branch/files) — **never hard-delete unproven**
4. **Hot** (non-evictable) if any:
   - `process.cwd()` or `$PWD` is inside host path (best-effort; also check `WORKFOREST_CD` style only if already exists—don’t invent telemetry)
   - `node_modules` mtime (or host dir mtime) within **idle grace** (default **2h**, constant first; config only if needed)
   - active setup detected via existing setup log / running state if cheap (`status` setup plumbing)
   - optional later: `lsof` — **non-goal v1** (slow, flaky on macOS)
5. **Eviction order** among evictable lives:
   1. proven integrated, oldest mtime
   2. proven via GitHub PR, oldest mtime
   3. unproven clean cold (soft-evict only under hard pressure)
6. **Pool order:** newest restore first (existing `sortEntries`); prune oldest beyond `maxRetainedPerRepo`.
7. **Cap semantics:**
   - `liveCount <= maxLivePerRepo` after acquire completes (best-effort if some lives are all hot: **allow temporary overage**, emit warning, do not steal hot installs, do not block create)
   - Soft cap with overage warning beats hard failure that breaks agent workflows
8. **Safety:** soft-evict never deletes git objects, branches, or dirty files; only moves eligible `node_modules`. Missing `node_modules` later is repaired by acquire + `pnpm install`.
9. **Cross-device:** if `rename` fails with `EXDEV`, fall back to “no borrow” (warning) rather than copy storms; pool should live on same volume as repos when possible (document).

### Invariant summary

```
∀ identity:
  pooled entries ≤ maxRetainedPerRepo
  live eligible installs ≤ maxLivePerRepo  OR  (overage ∧ all excess non-evictable ∧ warned)
  delete/hard-reclaim ⇒ clean ∧ (integrated proof ∨ --force)
  acquire prefers: present → pool → borrow live → miss
  moves are rename-only under lock
```

---

## 6. Squash-merge detection strategy

### Signals (precedence)

1. **Default branch checked out** → integrated (`method: default-branch`).
2. **Ancestry:** `git merge-base --is-ancestor HEAD origin/<default>` → integrated (`ancestor`).  
   Same as today; still best offline fast path for merge commits / rebased-onto-main.
3. **GitHub merged PR for head branch** (when `gh` available and remote is GitHub):
   - `gh pr list --repo <owner/name> --head <branch> --state merged --json number,url,mergedAt,mergeCommit`
   - Also try head as `owner:branch` if needed for forks
   - If ≥1 merged PR → integrated (`github-pr`, detail `#N`)
4. **Optional strengthening (checkpoint later, not required for v1):**
   - `gh pr list --search "is:merged head:<branch>"`
   - match by commit SHA: `gh api search/issues?q=sha:...` (rate-limit sensitive)
5. **Not in v1 unless cheap:** patch-id / tree equivalence against default branch (expensive, subtle with renames).

### Failure modes

| Situation | Result | User impact |
|-----------|--------|-------------|
| No network / `gh` missing / unauthenticated | `unknown` after failed ancestry | delete still blocked without `--force`; message explains how to auth or force |
| Branch renamed after PR | miss PR-by-head | unknown / not integrated → force |
| Multiple repos in workspace, only some GitHub | per-repo proof | each repo independent |
| PR merged, local has extra unpushed commits | ancestry false; PR may still say merged for branch name | **treat PR merged as integrated only if working tree clean and no unique unpushed commits ahead of merge commit** if mergeCommit available; else if clean and branch tip equals PR head SHA when queryable. **Conservative default:** if `gh` says merged **and** worktree clean **and** not ahead of `origin/<default>` by unpushed *non-squash* uniqueness—simplest v1: **merged PR + clean worktree ⇒ integrated**. Document that local-only commits on a reused branch name are a force case. |
| Non-GitHub hosts | ancestry only | same as today |
| Task branches | same helper vs parent HEAD and/or PR | task delete gains squash awareness |

### Caching

- Per CLI invocation memo by `(cwd, branch, base)`.
- Do not persist “integrated” forever in metadata without recheck at delete time (stale proof risk). Optional status-only cache with short TTL later.

### Product copy

- Delete blockers: “not proven integrated (ancestry and GitHub PR checks failed)” + suggestion `gh auth login` when applicable.
- Help: `--force` for abandoned/unproven work, not “always for squash.”

---

## 7. Config surface (minimal)

Extend existing object only:

```ts
// types.ts / configuration-registry defaults
cache.nodeModules.enabled            // default true (existing)
cache.nodeModules.maxRetainedPerRepo // default 3 (existing) — cold pool
cache.nodeModules.maxLivePerRepo     // default 3 (NEW) — live worktrees
```

**Constants first (not config) unless evidence demands:**

- idle grace for “hot”: 2 hours
- reclaim overage warning threshold
- gh timeout

**Avoid v1 knobs:** global live cap across all repos, daemon intervals, copy-on-EXDEV, npm/yarn pool, auto-hard-delete TTL.

Env override only if pattern already exists for setup concurrency: optional `WORKFOREST_MAX_LIVE_NODE_MODULES` — **skip unless needed for tests**.

---

## 8. Sequenced checkpoints (independently verifiable)

Each checkpoint: coherent main-ready diff; gate `pnpm check` (narrower tests while iterating).

### CP0 — Integration proof primitive

- Add `src/services/integration-proof.ts` + unit tests (mock git/gh).
- Wire **read-only** into `delete-safety` + `status` (behavior change: more `integrated: true`).
- Update delete blocker copy + `cli.delete` tests for squash-merged clean case.
- Wire tasks merge check to same helper.
- **Verify:** `pnpm test src/services/integration-proof.test.ts src/cli.delete.test.ts` then `pnpm check`.
- **Relief:** delete stop requiring `--force` on squash — immediate UX win, enables later reclaim.

### CP1 — Live install inventory + observability

- Discover eligible live installs via inventory + eligibility markers.
- Extend `wf cache list` / summary JSON with `liveInstalls` counts; doctor warning if `live > maxLive`.
- Config: `maxLivePerRepo` parse/default (enforced later).
- **Verify:** unit tests for discovery; `pnpm check`.
- **Relief:** visibility into the real problem.

### CP2 — Soft-evict + acquire (borrow path)

- Per-identity lock.
- `softEvict` → existing `preserveNodeModules`.
- `acquireNodeModules`: present → pool restore → borrow from best evictable live → missing.
- Pipeline + task setup call acquire; events for borrowed.
- Enforce soft live cap with overage-if-all-hot warning.
- **Verify:** lifecycle unit tests (fake installs on disk); pipeline/tasks mocks; `pnpm check`.
- **Relief:** main write-storm fix when idle lives or pool exist.

### CP3 — Pressure reclaim command

- `wf cache reclaim [--dry-run] [--repo <spec>]`: soft-evict excess lives, prune pool.
- Call reclaim opportunistically at end of successful acquire when over cap (best-effort).
- **Verify:** CLI unit/integration light tests; `pnpm check`.

### CP4 — Harden + docs polish

- EXDEV handling, nested tasks as borrow sources/targets, concurrent acquire stress test if feasible.
- Help/reference/registry text; status shows proof method if cheap.
- **Verify:** full `pnpm check`.

### CP5 (optional follow-on) — Explicit idle worktree prune

- `wf prune` / `wf delete --integrated-idle` style hard delete of clean proven-integrated cold worktrees.
- **Only after** CP0–CP3; separate product decision on defaults.
- **Not required** for install storm relief.

**Parallelization:** CP0 can parallel with CP1 (different files: integration-proof/delete vs inventory/cache list). CP2 depends on CP1 discovery + benefits from CP0 for eviction preference. CP3 depends on CP2.

---

## 9. Risks, open questions, non-goals

### Risks

- **False “cold” eviction** while IDE/tsserver holds files — mitigate with mtime grace + clean-only; accept that next enter pays restore+install (still better than unbounded growth).
- **Concurrent agents** racing acquire — per-identity lock mandatory.
- **Temporary overage** when all lives hot — correct; document.
- **`gh` false positive** on branch name reuse — mitigate with clean-tree requirement; accept residual force path.
- **Workspace multi-repo stamp** — N acquires; concurrency already limited by `setup.maxConcurrent`.
- **Borrow from worktree user still considers active** but idle > grace — product risk; tune grace before adding config.
- **Tests flakiness** with background size scripts — existing pattern in cache tests.

### Open questions

1. **Default `maxLivePerRepo`:** 2 vs 3? (Recommend **3** to match pool default and parallel-agent reality.)
2. **Should unproven clean cold trees be soft-evictable under pressure?** (Recommend **yes** for install moves; **no** for hard delete.)
3. **Opportunistic reclaim on every `wf new` vs only when over cap?** (Recommend **only over cap / missing pool candidate** to keep create latency predictable.)
4. **Task checkouts as borrow sources?** (Recommend **yes** if eligible and cold—tasks often abandoned.)
5. **Persist proof method in delete JSON only, or also status UI?** (Recommend delete dry-run + status boolean first; method in `--json`.)
6. **Same-volume recommendation** in doctor when pool path device ≠ repos device?

### Non-goals (unless later justified)

- npm/yarn install pooling
- Long-running GC daemon
- Copying `node_modules` trees
- Replacing pnpm’s content-addressable store
- Auto-deleting unintegrated work
- Network required for reuse happy path
- Global cross-repo live cap in v1
- lsof-based in-use detection in v1

---

## 10. Effort and what to ship first

| Checkpoint | Rough effort | Relief |
|------------|--------------|--------|
| CP0 integration proof | **1–2 days** | Stops squash `--force` tax; unlocks safe automation |
| CP1 live inventory + status | **1 day** | Observability; unblocks acquire design validation |
| CP2 acquire/borrow + cap | **2–3 days** | **Primary install-storm + disk relief** |
| CP3 reclaim command | **0.5–1 day** | Explicit pressure valve + forgetful-user path |
| CP4 harden/docs | **0.5–1 day** | Production confidence |
| **MVP total** | **~5–8 days** | |
| CP5 hard prune | **+1–2 days** | Optional |

### Ship first for max relief

**CP0 + CP2**, with CP1 only as much as CP2 needs for discovery.

Rationale:

- CP0 is small, unblocks delete hygiene immediately (users actually run delete more when it isn’t annoying), and makes eviction preference correct.
- CP2 is the architectural fix for write storms: **move an existing tree instead of creating thousands of files**.
- Observability (full CP1 polish) and `cache reclaim` (CP3) can trail by a day without blocking the core loop.

### Success metrics (qualitative/local)

- Second concurrent `wf new` on same large pnpm monorepo after an idle integrated tree exists: acquire event `borrowed` or `restored`, wall time dominated by incremental `pnpm install`, not full tree write.
- Live eligible installs per repo identity stabilize near `maxLivePerRepo` after reclaim/new cycles without manual delete of every checkout.
- Squash-merged clean feature branch: `wf delete` exits 0 without `--force`.

---

## Dependency / module boundary sketch

```text
cli/delete, status, tasks, cache
        │
        ▼
integration-proof  (git + optional gh)
        │
node-modules-lifecycle ──► node-modules-cache (pool)
        │                         │
        ├─ inventory/metadata     └─ getCacheDir()
        └─ pipeline / task setup (acquire before pnpm-install)
```

**Dependency direction:** CLI/workspace → lifecycle → pool/cache + inventory; integration-proof has no dependency on pool. Do not let template-suggestions import lifecycle; extract gh helper downward.

---

## Planning note

This is an architecture packet only: no implementation, no Workforest tasks, no product code changes from the planning agent.
