import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  collectEvidence,
  type DigestGenerator,
  digestFromOutput,
} from "./generate.ts";
import { isProcessAlive, lockOwnerPid, tryAcquireLock } from "./lock.ts";
import { observeTarget, type TargetObservation } from "./observe.ts";
import {
  type ActivityPolicy,
  applyObservation,
  DEFAULT_ACTIVITY_POLICY,
  decideGeneration,
  isCheckDue,
  retryDelayMs,
} from "./policy.ts";
import {
  type ActivityPaths,
  mutateRecord,
  pruneRecords,
  readInputs,
  readJson,
  readRecord,
  writeJsonAtomic,
} from "./store.ts";
import type { ActivityTarget } from "./targets.ts";
import type { ActivityRecord, ActivityState } from "./types.ts";

const DETECTION_CONCURRENCY = 8;
const GENERATION_CONCURRENCY = 2;
const MAX_GENERATIONS_PER_SWEEP = 3;
const MAX_ERROR_CHARS = 500;

export type ActivityEngineOptions = Readonly<{
  paths: ActivityPaths;
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

async function readState(
  paths: ActivityPaths,
  target: ActivityTarget,
): Promise<ActivityState> {
  const [record, inputs] = await Promise.all([
    readRecord(paths, target.identity),
    readInputs(paths, target.identity),
  ]);
  return { record, inputs };
}

/**
 * Capture and store an observation. Inputs are read before Git so the
 * captured revision never claims inputs the fingerprint did not see; the
 * store step refuses to replace an observation whose capture began later.
 */
async function observeAndStore(
  options: ActivityEngineOptions,
  target: ActivityTarget,
): Promise<{
  observed: TargetObservation;
  record: ActivityRecord;
  stored: boolean;
  changed: boolean;
}> {
  const now = options.now ?? Date.now;
  const inputs = await readInputs(options.paths, target.identity);
  const observed = await observeTarget(target, inputs, now());
  let stored = false;
  let changed = false;
  const record = await mutateRecord(
    options.paths,
    target.identity,
    (current) => {
      const observation = applyObservation(current, observed, now());
      if (!observation) return null;
      stored = true;
      changed =
        current.observation !== null &&
        current.observation.fingerprint !== observation.fingerprint;
      return { ...current, observation };
    },
  );
  return { observed, record, stored, changed };
}

/**
 * One reconciliation pass: cheap detection for due checkouts, then a
 * bounded number of generations for active checkouts whose inputs changed
 * and have settled (debounce) or waited too long (max delay). Only one sweep
 * runs at a time across processes; a concurrent caller returns immediately
 * with `skippedReason`. Pass `prune` only with a complete target list.
 */
export async function runSweep(
  targets: readonly ActivityTarget[],
  options: ActivityEngineOptions & { prune?: boolean },
): Promise<SweepSummary> {
  const now = options.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const lock = await tryAcquireLock(
    path.join(options.paths.cacheRoot, "sweep.lock"),
  );
  if (!lock) {
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
    const candidates: Array<{ target: ActivityTarget; state: ActivityState }> =
      [];

    await forEachLimited(targets, DETECTION_CONCURRENCY, async (target) => {
      if (options.signal?.aborted) return;
      let state = await readState(options.paths, target);
      if (isCheckDue(state, now(), options.policy)) {
        const result = await observeAndStore(options, target);
        checked += 1;
        if (result.changed) changed += 1;
        state = await readState(options.paths, target);
      }
      if (wantsGeneration(state, now(), options)) {
        candidates.push({ target, state });
      }
    });

    candidates.sort(
      (left, right) =>
        Date.parse(right.state.record.observation?.lastActivityAt ?? "0") -
        Date.parse(left.state.record.observation?.lastActivityAt ?? "0"),
    );
    const limit =
      options.inferenceEnabled === false
        ? 0
        : (options.maxGenerationsPerSweep ?? MAX_GENERATIONS_PER_SWEEP);
    const selected = candidates.slice(0, limit);
    const deferred = candidates.slice(limit);

    for (const { target } of deferred) {
      await mutateRecord(options.paths, target.identity, (current) =>
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
      ? await pruneRecords(
          options.paths,
          new Set(targets.map((target) => target.identity.key)),
        )
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
    await writeJsonAtomic(
      path.join(options.paths.cacheRoot, "last-sweep.json"),
      summary,
    );
    return summary;
  } finally {
    await lock.release();
  }
}

function wantsGeneration(
  state: ActivityState,
  nowMs: number,
  options: ActivityEngineOptions,
): boolean {
  return (
    decideGeneration(state, nowMs, {
      ...(options.policy ? { policy: options.policy } : {}),
      isRunAlive,
    }).kind === "generate"
  );
}

/**
 * Detect, claim, gather evidence, generate, and reconcile for one checkout.
 *
 * Race safety:
 * - The fingerprint X is captured before evidence; commit evidence is read
 *   at the captured HEAD. A second capture after evidence must still equal
 *   X, otherwise the checkout is changing and the run is abandoned (queued)
 *   instead of summarizing a mixed snapshot.
 * - After the model returns, the checkout is observed again and stored with
 *   the digest, so work done during inference leaves the digest `outdated`
 *   immediately; only a digest whose fingerprint and inputs revision match
 *   the latest observation reads as `current`.
 * - An older, slower run never replaces a digest observed later, and only
 *   the claimant's run id may clear or fail the generation state.
 * - An aborted signal never launches the model and releases the claim.
 */
export async function generateForTarget(
  target: ActivityTarget,
  options: ActivityEngineOptions,
  mode: "scheduled" | "refresh" | "force",
): Promise<GenerationOutcome> {
  const now = options.now ?? Date.now;
  const policy = options.policy ?? DEFAULT_ACTIVITY_POLICY;
  const selector = target.identity.selector;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await generateWithSignal(
      target,
      options,
      mode,
      controller.signal,
      now,
      policy,
      selector,
    );
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}

async function generateWithSignal(
  target: ActivityTarget,
  options: ActivityEngineOptions,
  mode: "scheduled" | "refresh" | "force",
  signal: AbortSignal,
  now: () => number,
  policy: ActivityPolicy,
  selector: string,
): Promise<GenerationOutcome> {
  if (signal.aborted) {
    const { record } = await readState(options.paths, target);
    return { selector, result: "cancelled", record };
  }
  const inputs = await readInputs(options.paths, target.identity);
  const observed = await observeTarget(target, inputs, now());
  const runId = randomUUID();
  let skipReason: string | undefined;

  const claimed = await mutateRecord(
    options.paths,
    target.identity,
    (current) => {
      const observation = applyObservation(current, observed, now());
      if (!observation) {
        skipReason = "superseded";
        return null;
      }
      const next = { ...current, observation };
      const decision = decideGeneration({ record: next, inputs }, now(), {
        policy,
        isRunAlive,
        mode,
      });
      if (decision.kind === "skip") {
        skipReason = decision.reason;
        return next;
      }
      if (signal.aborted) {
        skipReason = "cancelled";
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
          startedAt: new Date(now()).toISOString(),
        },
      };
    },
  );
  if (skipReason !== undefined || claimed.generation.runId !== runId) {
    return {
      selector,
      result: skipReason === "cancelled" ? "cancelled" : "skipped",
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
  try {
    const packet = await collectEvidence(target, observed, inputs);
    const confirmInputs = await readInputs(options.paths, target.identity);
    const confirm = await observeTarget(target, confirmInputs, now());
    if (confirm.fingerprint !== fingerprint) {
      await storeObservation(options, target, confirm);
      const record = await releaseClaim(options, target, runId, "queued");
      return {
        selector,
        result: "skipped",
        reason: "changed-during-capture",
        record,
      };
    }
    if (signal.aborted) throw new Error("cancelled");
    const generated = await options.generator(packet, signal);
    const afterInputs = await readInputs(options.paths, target.identity);
    const after = await observeTarget(target, afterInputs, now());
    const record = await mutateRecord(
      options.paths,
      target.identity,
      (current) => {
        const digest = digestFromOutput({
          generated,
          inputs,
          fingerprint,
          capturedAtMs: observed.captureStartedAtMs,
          nowMs: now(),
        });
        const newer =
          current.digest &&
          Date.parse(current.digest.observedThrough) >
            observed.captureStartedAtMs;
        const withDigest = newer ? current : { ...current, digest };
        const observation =
          applyObservation(withDigest, after, now()) ?? current.observation;
        return {
          ...withDigest,
          observation,
          generation:
            current.generation.runId === runId
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
    if (signal.aborted) {
      const record = await releaseClaim(options, target, runId, "idle");
      return { selector, result: "cancelled", record };
    }
    const message = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, MAX_ERROR_CHARS);
    const record = await mutateRecord(
      options.paths,
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
  }
}

async function storeObservation(
  options: ActivityEngineOptions,
  target: ActivityTarget,
  observed: TargetObservation,
): Promise<void> {
  const now = options.now ?? Date.now;
  await mutateRecord(options.paths, target.identity, (current) => {
    const observation = applyObservation(current, observed, now());
    return observation ? { ...current, observation } : null;
  });
}

async function releaseClaim(
  options: ActivityEngineOptions,
  target: ActivityTarget,
  runId: string,
  state: "idle" | "queued",
): Promise<ActivityRecord> {
  return mutateRecord(options.paths, target.identity, (current) =>
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

export async function readServiceStatus(
  paths: ActivityPaths,
): Promise<ServiceStatus> {
  const [state, lastSweep, ownerPid] = await Promise.all([
    readJson<ServiceState>(path.join(paths.cacheRoot, "service.json")),
    readJson<SweepSummary>(path.join(paths.cacheRoot, "last-sweep.json")),
    lockOwnerPid(path.join(paths.cacheRoot, "service.lock")),
  ]);
  return { running: ownerPid !== null, state, lastSweep };
}

/**
 * Foreground periodic service: sweep, persist a heartbeat, sleep, repeat.
 * Exactly one service owns `service.lock`; aborting the signal cancels any
 * in-flight model call (killing its child process) and returns cleanly, so
 * nothing is left detached.
 */
export async function runService({
  paths,
  intervalMs,
  collectTargets,
  engine,
  onSweep,
  maxSweeps,
}: {
  paths: ActivityPaths;
  intervalMs: number;
  collectTargets: () => Promise<{
    targets: ActivityTarget[];
    complete: boolean;
  }>;
  engine: Omit<ActivityEngineOptions, "paths">;
  onSweep?: (summary: SweepSummary) => void;
  /** Stop after this many sweeps (tests and one-shot smoke runs). */
  maxSweeps?: number;
}): Promise<"stopped" | "already-running"> {
  const lock = await tryAcquireLock(path.join(paths.cacheRoot, "service.lock"));
  if (!lock) return "already-running";
  const now = engine.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  let lastSweep: SweepSummary | null = null;
  let lastError: string | null = null;
  const writeState = () =>
    writeJsonAtomic(path.join(paths.cacheRoot, "service.json"), {
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
        const { targets, complete } = await collectTargets();
        lastSweep = await runSweep(targets, {
          ...engine,
          paths,
          prune: complete,
        });
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
    await lock.release();
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
