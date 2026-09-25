import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  collectEvidence,
  type DigestGenerator,
  digestFromOutput,
} from "./generate.ts";
import { observeTarget } from "./observe.ts";
import {
  type ActivityPolicy,
  applyObservation,
  DEFAULT_ACTIVITY_POLICY,
  decideGeneration,
  freshnessOf,
  isCheckDue,
  retryDelayMs,
} from "./policy.ts";
import {
  isProcessAlive,
  listRecordKeys,
  mutateRecord,
  readJson,
  readRecord,
  removeRecord,
  tryAcquireOwnership,
  writeJsonAtomic,
} from "./store.ts";
import type { ActivityTarget } from "./targets.ts";
import type { ActivityRecord } from "./types.ts";

const DETECTION_CONCURRENCY = 8;
const GENERATION_CONCURRENCY = 2;
const MAX_GENERATIONS_PER_SWEEP = 3;
const MAX_ERROR_CHARS = 500;

export type ActivityEngineOptions = Readonly<{
  root: string;
  generator: DigestGenerator;
  now?: () => number;
  policy?: ActivityPolicy;
  /** When false, sweeps detect and queue but never call the model. */
  inferenceEnabled?: boolean;
  maxGenerationsPerSweep?: number;
  signal?: AbortSignal;
}>;

export type GenerationOutcome = Readonly<{
  selector: string;
  result: "generated" | "skipped" | "failed" | "cancelled";
  reason?: string;
  record: ActivityRecord;
}>;

export type SweepSummary = Readonly<{
  startedAt: string;
  finishedAt: string;
  targets: number;
  checked: number;
  changed: number;
  queued: number;
  generated: number;
  failed: number;
  pruned: number;
  skippedReason?: "already-running";
}>;

export function isRunAlive(record: ActivityRecord): boolean {
  const pid = record.generation.pid;
  return pid !== null && isProcessAlive(pid);
}

/**
 * One reconciliation pass: cheap detection for due checkouts, then a
 * bounded number of generations for active checkouts whose inputs changed
 * and have settled (debounce) or waited too long (max delay). Only one
 * sweep runs at a time across processes; a concurrent caller returns
 * immediately with `skippedReason`.
 */
export async function runSweep(
  targets: readonly ActivityTarget[],
  options: ActivityEngineOptions & { prune?: boolean },
): Promise<SweepSummary> {
  const now = options.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const release = await tryAcquireOwnership(
    path.join(options.root, "sweep.lock"),
  );
  if (!release) {
    return {
      startedAt,
      finishedAt: startedAt,
      targets: targets.length,
      checked: 0,
      changed: 0,
      queued: 0,
      generated: 0,
      failed: 0,
      pruned: 0,
      skippedReason: "already-running",
    };
  }

  try {
    let checked = 0;
    let changed = 0;
    const candidates: Array<{
      target: ActivityTarget;
      record: ActivityRecord;
    }> = [];

    await forEachLimited(targets, DETECTION_CONCURRENCY, async (target) => {
      if (options.signal?.aborted) return;
      const existing = await readRecord(options.root, target.identity.key);
      if (existing && !isCheckDue(existing, now(), options.policy)) {
        if (wantsGeneration(existing, now(), options)) {
          candidates.push({ target, record: existing });
        }
        return;
      }
      const observed = await observeTarget(target, existing);
      checked += 1;
      const record = await mutateRecord(
        options.root,
        target.identity,
        (current) => {
          const observation = applyObservation(current, observed, now());
          if (
            current.observation &&
            current.observation.fingerprint !== observation.fingerprint
          ) {
            changed += 1;
          }
          return { ...current, observation };
        },
      );
      if (wantsGeneration(record, now(), options)) {
        candidates.push({ target, record });
      }
    });

    candidates.sort(
      (left, right) =>
        Date.parse(right.record.observation?.lastActivityAt ?? "0") -
        Date.parse(left.record.observation?.lastActivityAt ?? "0"),
    );
    const limit =
      options.inferenceEnabled === false
        ? 0
        : (options.maxGenerationsPerSweep ?? MAX_GENERATIONS_PER_SWEEP);
    const selected = candidates.slice(0, limit);
    const deferred = candidates.slice(limit);

    for (const { target } of deferred) {
      await mutateRecord(options.root, target.identity, (current) =>
        current.generation.state === "running"
          ? null
          : {
              ...current,
              generation: { ...current.generation, state: "queued" },
            },
      );
    }

    let generated = 0;
    let failed = 0;
    await forEachLimited(
      selected,
      GENERATION_CONCURRENCY,
      async ({ target }) => {
        if (options.signal?.aborted) return;
        const outcome = await generateForTarget(target, options, "scheduled");
        if (outcome.result === "generated") generated += 1;
        if (outcome.result === "failed") failed += 1;
      },
    );

    const pruned = options.prune
      ? await pruneRecords(options.root, targets)
      : 0;
    const summary: SweepSummary = {
      startedAt,
      finishedAt: new Date(now()).toISOString(),
      targets: targets.length,
      checked,
      changed,
      queued: deferred.length,
      generated,
      failed,
      pruned,
    };
    await writeJsonAtomic(path.join(options.root, "last-sweep.json"), summary);
    return summary;
  } finally {
    await release();
  }
}

function wantsGeneration(
  record: ActivityRecord,
  nowMs: number,
  options: ActivityEngineOptions,
): boolean {
  return (
    decideGeneration(record, nowMs, {
      ...(options.policy ? { policy: options.policy } : {}),
      isRunAlive,
    }).kind === "generate"
  );
}

/**
 * Detect, claim, gather evidence, and generate for one checkout.
 *
 * Race safety: the fingerprint is captured *before* evidence, and the digest
 * is stored with that fingerprint. A change made while the model runs gives
 * the next observation a different fingerprint, so the digest reads as
 * `outdated` rather than being mistaken for current. A slower, older run
 * never replaces a digest observed later, and only the claimant's run id may
 * clear or fail the generation state.
 *
 * `refresh` ignores scheduling gates but skips an already-current digest;
 * `force` regenerates regardless.
 */
export async function generateForTarget(
  target: ActivityTarget,
  options: ActivityEngineOptions,
  mode: "scheduled" | "refresh" | "force",
): Promise<GenerationOutcome> {
  const now = options.now ?? Date.now;
  const policy = options.policy ?? DEFAULT_ACTIVITY_POLICY;
  const selector = target.identity.selector;
  const existing = await readRecord(options.root, target.identity.key);
  const observed = await observeTarget(target, existing);
  const capturedAtMs = now();
  const runId = randomUUID();
  let skipReason: string | undefined;

  const claimed = await mutateRecord(
    options.root,
    target.identity,
    (current) => {
      const observation = applyObservation(current, observed, capturedAtMs);
      const next = { ...current, observation };
      const decision = decideGeneration(next, capturedAtMs, {
        policy,
        isRunAlive,
        force: mode !== "scheduled",
      });
      if (decision.kind === "skip") {
        skipReason = decision.reason;
        return next;
      }
      if (mode === "refresh" && freshnessOf(next) === "current") {
        skipReason = "current";
        return next;
      }
      return {
        ...next,
        generation: {
          ...next.generation,
          state: "running",
          fingerprint: observation.fingerprint,
          runId,
          pid: process.pid,
          startedAt: new Date(capturedAtMs).toISOString(),
        },
      };
    },
  );
  if (skipReason !== undefined || claimed.generation.runId !== runId) {
    return {
      selector,
      result: "skipped",
      reason: skipReason ?? "running",
      record: claimed,
    };
  }
  if (options.inferenceEnabled === false) {
    const record = await releaseClaim(options, target, runId, "idle");
    return {
      selector,
      result: "skipped",
      reason: "inference-disabled",
      record,
    };
  }

  const fingerprint = observed.fingerprint;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const packet = await collectEvidence(
      target,
      observed,
      claimed,
      capturedAtMs,
    );
    const generated = await options.generator(packet, controller.signal);
    const record = await mutateRecord(
      options.root,
      target.identity,
      (current) => {
        const digest = digestFromOutput({
          generated,
          record: current,
          fingerprint,
          capturedAtMs,
          nowMs: now(),
        });
        const newer =
          current.digest &&
          Date.parse(current.digest.observedThrough) > capturedAtMs;
        const ownsClaim = current.generation.runId === runId;
        return {
          ...current,
          digest: newer ? current.digest : digest,
          observation: current.observation
            ? {
                ...current.observation,
                pendingSince:
                  current.observation.fingerprint === fingerprint
                    ? null
                    : current.observation.pendingSince,
              }
            : current.observation,
          generation: ownsClaim
            ? {
                ...current.generation,
                state: "idle",
                fingerprint: null,
                runId: null,
                pid: null,
                startedAt: null,
                attempts: 0,
                lastError: null,
                nextAttemptAt: null,
              }
            : current.generation,
        };
      },
    );
    return { selector, result: "generated", record };
  } catch (error) {
    if (controller.signal.aborted) {
      const record = await releaseClaim(options, target, runId, "idle");
      return { selector, result: "cancelled", record };
    }
    const message = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, MAX_ERROR_CHARS);
    const record = await mutateRecord(
      options.root,
      target.identity,
      (current) => {
        if (current.generation.runId !== runId) return null;
        const attempts = current.generation.attempts + 1;
        const failedAt = now();
        return {
          ...current,
          generation: {
            ...current.generation,
            state: "failed",
            runId: null,
            pid: null,
            startedAt: null,
            attempts,
            lastError: message,
            lastFailedAt: new Date(failedAt).toISOString(),
            nextAttemptAt: new Date(
              failedAt + retryDelayMs(attempts, policy),
            ).toISOString(),
          },
        };
      },
    );
    return { selector, result: "failed", reason: message, record };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}

async function releaseClaim(
  options: ActivityEngineOptions,
  target: ActivityTarget,
  runId: string,
  state: "idle",
): Promise<ActivityRecord> {
  return mutateRecord(options.root, target.identity, (current) =>
    current.generation.runId === runId
      ? {
          ...current,
          generation: {
            ...current.generation,
            state,
            fingerprint: null,
            runId: null,
            pid: null,
            startedAt: null,
          },
        }
      : null,
  );
}

/** Records whose checkout identity no longer exists are deleted. */
async function pruneRecords(
  root: string,
  targets: readonly ActivityTarget[],
): Promise<number> {
  const live = new Set(targets.map((target) => target.identity.key));
  let pruned = 0;
  for (const key of await listRecordKeys(root)) {
    if (live.has(key)) continue;
    await removeRecord(root, key);
    pruned += 1;
  }
  return pruned;
}

export type ServiceState = Readonly<{
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  intervalMs: number;
  lastSweep: SweepSummary | null;
  lastError: string | null;
}>;

export type ServiceStatus = Readonly<{
  running: boolean;
  state: ServiceState | null;
  lastSweep: SweepSummary | null;
}>;

export async function readServiceStatus(root: string): Promise<ServiceStatus> {
  const [state, lastSweep] = await Promise.all([
    readJson<ServiceState>(path.join(root, "service.json")),
    readJson<SweepSummary>(path.join(root, "last-sweep.json")),
  ]);
  const running = state !== null && isProcessAlive(state.pid);
  return { running, state, lastSweep };
}

/**
 * Foreground periodic service: sweep, persist a heartbeat, sleep, repeat.
 * Exactly one service owns `service.lock`; aborting the signal cancels any
 * in-flight model call (killing its child process) and returns cleanly, so
 * nothing is left detached.
 */
export async function runService({
  root,
  intervalMs,
  collectTargets,
  engine,
  onSweep,
  maxSweeps,
}: {
  root: string;
  intervalMs: number;
  collectTargets: () => Promise<ActivityTarget[]>;
  engine: Omit<ActivityEngineOptions, "root">;
  onSweep?: (summary: SweepSummary) => void;
  /** Stop after this many sweeps (tests and one-shot smoke runs). */
  maxSweeps?: number;
}): Promise<"stopped" | "already-running"> {
  const release = await tryAcquireOwnership(path.join(root, "service.lock"));
  if (!release) return "already-running";
  const now = engine.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  let lastSweep: SweepSummary | null = null;
  let lastError: string | null = null;
  const writeState = () =>
    writeJsonAtomic(path.join(root, "service.json"), {
      pid: process.pid,
      startedAt,
      heartbeatAt: new Date(now()).toISOString(),
      intervalMs,
      lastSweep,
      lastError,
    } satisfies ServiceState);

  try {
    let sweeps = 0;
    while (!engine.signal?.aborted) {
      try {
        const targets = await collectTargets();
        lastSweep = await runSweep(targets, { ...engine, root, prune: true });
        lastError = null;
        onSweep?.(lastSweep);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await writeState();
      sweeps += 1;
      if (maxSweeps !== undefined && sweeps >= maxSweeps) break;
      try {
        await delay(intervalMs, undefined, {
          ...(engine.signal ? { signal: engine.signal } : {}),
        });
      } catch {
        break;
      }
    }
    return "stopped";
  } finally {
    await release();
  }
}

async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  action: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (index < items.length) {
        const item = items[index];
        index += 1;
        if (item !== undefined) await action(item);
      }
    },
  );
  await Promise.all(workers);
}
