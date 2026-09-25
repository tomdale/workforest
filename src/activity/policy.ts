import type {
  ActivityFreshness,
  ActivityObservation,
  ActivityRecord,
  ActivityView,
} from "./types.ts";

/**
 * Scheduling policy for activity digests. Everything here is a pure function
 * of the persisted record and an explicit clock so the sweep and tests share
 * one definition of "active", "due", and "current".
 */
export type ActivityPolicy = Readonly<{
  /** Quiet period after the last observed change before summarizing. */
  debounceMs: number;
  /** Summarize anyway once changes have been pending this long. */
  maxDelayMs: number;
  /** Minimum spacing between two digests of the same checkout. */
  minIntervalMs: number;
  /** Recent activity keeps a checkout active for this long. */
  activeWindowMs: number;
  /** Inactive checkouts are re-checked this often to discover new work. */
  discoveryIntervalMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  /** A running claim older than this is treated as abandoned. */
  staleRunMs: number;
}>;

export const DEFAULT_ACTIVITY_POLICY: ActivityPolicy = {
  debounceMs: 3 * 60_000,
  maxDelayMs: 30 * 60_000,
  minIntervalMs: 10 * 60_000,
  activeWindowMs: 12 * 60 * 60_000,
  discoveryIntervalMs: 6 * 60 * 60_000,
  retryBaseMs: 5 * 60_000,
  retryMaxMs: 6 * 60 * 60_000,
  staleRunMs: 10 * 60_000,
};

export type ObservedInputs = Readonly<{
  fingerprint: string;
  /**
   * Best evidence-based activity time for a first sighting: newest HEAD
   * commit, dirty-file mtime, or explicit event. Ignored once a prior
   * observation exists, where only fingerprint changes count as activity.
   */
  estimatedActivityAtMs: number | null;
}>;

export function applyObservation(
  record: ActivityRecord,
  observed: ObservedInputs,
  nowMs: number,
): ActivityObservation {
  const now = new Date(nowMs).toISOString();
  const previous = record.observation;
  const coveredByDigest = record.digest?.fingerprint === observed.fingerprint;

  if (!previous) {
    const estimated = Math.min(
      nowMs,
      observed.estimatedActivityAtMs ?? Date.parse(record.target.createdAt),
    );
    return {
      fingerprint: observed.fingerprint,
      checkedAt: now,
      lastActivityAt: new Date(
        Number.isFinite(estimated) ? estimated : nowMs,
      ).toISOString(),
      pendingSince: coveredByDigest ? null : now,
    };
  }

  const changed = previous.fingerprint !== observed.fingerprint;
  return {
    fingerprint: observed.fingerprint,
    checkedAt: now,
    lastActivityAt: changed ? now : previous.lastActivityAt,
    pendingSince: coveredByDigest
      ? null
      : changed
        ? (previous.pendingSince ?? now)
        : previous.pendingSince,
  };
}

export function isActive(
  record: ActivityRecord,
  nowMs: number,
  policy: ActivityPolicy = DEFAULT_ACTIVITY_POLICY,
): boolean {
  if (record.user.pinned) return true;
  const lastActivity = record.observation?.lastActivityAt;
  if (!lastActivity) return false;
  return nowMs - Date.parse(lastActivity) < policy.activeWindowMs;
}

/** Whether a sweep should spend a detection pass on this checkout now. */
export function isCheckDue(
  record: ActivityRecord,
  nowMs: number,
  policy: ActivityPolicy = DEFAULT_ACTIVITY_POLICY,
): boolean {
  if (!record.observation) return true;
  if (isActive(record, nowMs, policy)) return true;
  return (
    nowMs - Date.parse(record.observation.checkedAt) >=
    policy.discoveryIntervalMs
  );
}

export function freshnessOf(record: ActivityRecord): ActivityFreshness {
  if (!record.digest) return "missing";
  if (!record.observation) return "current";
  return record.digest.fingerprint === record.observation.fingerprint
    ? "current"
    : "outdated";
}

export type GenerationDecision =
  | Readonly<{ kind: "generate"; fingerprint: string }>
  | Readonly<{
      kind: "skip";
      reason:
        | "unobserved"
        | "current"
        | "inactive"
        | "running"
        | "backoff"
        | "debouncing"
        | "min-interval";
      retryAtMs?: number;
    }>;

export type DecisionOptions = Readonly<{
  policy?: ActivityPolicy;
  /** Explicit refreshes skip activity, debounce, spacing, and backoff gates. */
  force?: boolean;
  isRunAlive?: (record: ActivityRecord) => boolean;
}>;

export function decideGeneration(
  record: ActivityRecord,
  nowMs: number,
  options: DecisionOptions = {},
): GenerationDecision {
  const policy = options.policy ?? DEFAULT_ACTIVITY_POLICY;
  const observation = record.observation;
  if (!observation) return { kind: "skip", reason: "unobserved" };
  const fingerprint = observation.fingerprint;

  if (isRunning(record, nowMs, policy, options.isRunAlive)) {
    return { kind: "skip", reason: "running" };
  }
  if (options.force) return { kind: "generate", fingerprint };
  if (record.digest?.fingerprint === fingerprint) {
    return { kind: "skip", reason: "current" };
  }
  if (!isActive(record, nowMs, policy)) {
    return { kind: "skip", reason: "inactive" };
  }

  const nextAttempt = record.generation.nextAttemptAt;
  if (
    record.generation.state === "failed" &&
    nextAttempt &&
    Date.parse(nextAttempt) > nowMs
  ) {
    return {
      kind: "skip",
      reason: "backoff",
      retryAtMs: Date.parse(nextAttempt),
    };
  }

  const quietSince = nowMs - Date.parse(observation.lastActivityAt);
  const pendingFor = observation.pendingSince
    ? nowMs - Date.parse(observation.pendingSince)
    : 0;
  if (quietSince < policy.debounceMs && pendingFor < policy.maxDelayMs) {
    return {
      kind: "skip",
      reason: "debouncing",
      retryAtMs: Math.min(
        Date.parse(observation.lastActivityAt) + policy.debounceMs,
        observation.pendingSince
          ? Date.parse(observation.pendingSince) + policy.maxDelayMs
          : Number.POSITIVE_INFINITY,
      ),
    };
  }

  if (record.digest) {
    const nextAllowed =
      Date.parse(record.digest.generatedAt) + policy.minIntervalMs;
    if (nextAllowed > nowMs) {
      return { kind: "skip", reason: "min-interval", retryAtMs: nextAllowed };
    }
  }

  return { kind: "generate", fingerprint };
}

export function isRunning(
  record: ActivityRecord,
  nowMs: number,
  policy: ActivityPolicy = DEFAULT_ACTIVITY_POLICY,
  isRunAlive: (record: ActivityRecord) => boolean = () => true,
): boolean {
  const generation = record.generation;
  if (generation.state !== "running" || !generation.startedAt) return false;
  if (nowMs - Date.parse(generation.startedAt) >= policy.staleRunMs) {
    return false;
  }
  return isRunAlive(record);
}

export function retryDelayMs(
  attempts: number,
  policy: ActivityPolicy = DEFAULT_ACTIVITY_POLICY,
): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(policy.retryMaxMs, policy.retryBaseMs * 2 ** exponent);
}

export function toActivityView(
  record: ActivityRecord,
  nowMs: number,
  options: Pick<DecisionOptions, "policy" | "isRunAlive"> = {},
): ActivityView {
  const policy = options.policy ?? DEFAULT_ACTIVITY_POLICY;
  const digest = record.digest;
  const userPurpose = record.user.purpose;
  const running = isRunning(record, nowMs, policy, options.isRunAlive);
  const storedState = record.generation.state;
  const generationState =
    storedState === "running" && !running ? "failed" : storedState;
  const handoffNext = latestHandoffNext(record);
  const likelyNext = handoffNext ?? digest?.likelyNext ?? null;
  return {
    key: record.target.key,
    selector: record.target.selector,
    type: record.target.type,
    path: record.target.path,
    freshness: freshnessOf(record),
    generationState,
    active: isActive(record, nowMs, policy),
    pinned: record.user.pinned,
    purpose: userPurpose ?? digest?.purpose ?? null,
    purposeSource: userPurpose ? "user" : (digest?.purposeSource ?? null),
    latest: digest?.latest ?? null,
    likelyNext,
    likelyNextBasis: handoffNext
      ? "handoff"
      : (digest?.likelyNextBasis ?? null),
    confidence: digest?.confidence ?? null,
    insufficientContext: digest?.insufficientContext ?? null,
    evidence: digest?.evidence ?? [],
    lastActivityAt: record.observation?.lastActivityAt ?? null,
    lastCheckedAt: record.observation?.checkedAt ?? null,
    observedThrough: digest?.observedThrough ?? null,
    generatedAt: digest?.generatedAt ?? null,
    lastError:
      generationState === "failed"
        ? (record.generation.lastError ?? "Generation was interrupted.")
        : null,
    model: digest?.model ?? null,
    promptVersion: digest?.promptVersion ?? null,
  };
}

/**
 * An explicit handoff's next step outranks inference, but only while no
 * newer digest exists: a digest generated after the handoff already had it
 * as evidence and may know it was completed.
 */
function latestHandoffNext(record: ActivityRecord): string | null {
  const event = [...record.events].reverse().find((entry) => entry.next);
  if (!event?.next) return null;
  const digestObserved = record.digest?.observedThrough;
  if (digestObserved && Date.parse(digestObserved) >= Date.parse(event.at)) {
    return null;
  }
  return event.next;
}
