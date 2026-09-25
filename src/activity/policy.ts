import type {
  ActivityFreshness,
  ActivityObservation,
  ActivityRecord,
  ActivityState,
  ActivityView,
} from "./types.ts";

/**
 * Scheduling policy for activity digests. Everything here is a pure function
 * of persisted state and an explicit clock so the sweep, the read model, and
 * tests share one definition of "active", "due", and "current".
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
  inputsRevision: number;
  hasEvidence: boolean;
  captureStartedAtMs: number;
  /**
   * First-sighting activity estimate from checkout-specific evidence only:
   * commits beyond the shared baseline, dirty-file mtimes, explicit inputs.
   * `null` when none exists; the checkout's creation time is used instead.
   */
  estimatedActivityAtMs: number | null;
}>;

/**
 * Merge a finished capture into the stored observation. Returns `null` when
 * a capture that began later has already been stored, so a slow capture can
 * never overwrite newer state.
 */
export function applyObservation(
  record: ActivityRecord,
  observed: ObservedInputs,
  nowMs: number,
): ActivityObservation | null {
  const previous = record.observation;
  if (
    previous &&
    Date.parse(previous.captureStartedAt) > observed.captureStartedAtMs
  ) {
    return null;
  }
  const now = new Date(nowMs).toISOString();
  const common = {
    fingerprint: observed.fingerprint,
    captureStartedAt: new Date(observed.captureStartedAtMs).toISOString(),
    inputsRevision: observed.inputsRevision,
    hasEvidence: observed.hasEvidence,
    checkedAt: now,
  };
  const coveredByDigest = record.digest?.fingerprint === observed.fingerprint;

  if (!previous) {
    const estimated = Math.min(
      nowMs,
      observed.estimatedActivityAtMs ?? Date.parse(record.target.createdAt),
    );
    return {
      ...common,
      lastActivityAt: new Date(
        Number.isFinite(estimated) ? estimated : nowMs,
      ).toISOString(),
      pendingSince: coveredByDigest ? null : now,
    };
  }

  const changed = previous.fingerprint !== observed.fingerprint;
  return {
    ...common,
    lastActivityAt: changed ? now : previous.lastActivityAt,
    pendingSince: coveredByDigest
      ? null
      : changed
        ? (previous.pendingSince ?? now)
        : previous.pendingSince,
  };
}

function lastActivityMs(state: ActivityState): number | null {
  const times = [
    state.record.observation?.lastActivityAt,
    state.inputs.activityAt,
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => Date.parse(value));
  return times.length > 0 ? Math.max(...times) : null;
}

export function isActive(
  state: ActivityState,
  nowMs: number,
  policy: ActivityPolicy = DEFAULT_ACTIVITY_POLICY,
): boolean {
  if (state.inputs.pinned) return true;
  const last = lastActivityMs(state);
  return last !== null && nowMs - last < policy.activeWindowMs;
}

/** Whether cached observation already reflects the current explicit inputs. */
function inputsObserved(state: ActivityState): boolean {
  return state.record.observation?.inputsRevision === state.inputs.revision;
}

/** Whether a sweep should spend a detection pass on this checkout now. */
export function isCheckDue(
  state: ActivityState,
  nowMs: number,
  policy: ActivityPolicy = DEFAULT_ACTIVITY_POLICY,
): boolean {
  const observation = state.record.observation;
  if (!observation || !inputsObserved(state)) return true;
  if (isActive(state, nowMs, policy)) return true;
  return (
    nowMs - Date.parse(observation.checkedAt) >= policy.discoveryIntervalMs
  );
}

export function freshnessOf(state: ActivityState): ActivityFreshness {
  const { digest, observation } = state.record;
  if (!digest) return "missing";
  if (!observation || !inputsObserved(state)) return "outdated";
  return digest.fingerprint === observation.fingerprint &&
    digest.inputsRevision === state.inputs.revision
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
        | "no-evidence"
        | "inactive"
        | "running"
        | "backoff"
        | "debouncing"
        | "min-interval";
      retryAtMs?: number;
    }>;

export type DecisionOptions = Readonly<{
  policy?: ActivityPolicy;
  /**
   * `refresh` skips activity, debounce, spacing, and backoff gates but not an
   * already-current digest; `force` regenerates regardless.
   */
  mode?: "scheduled" | "refresh" | "force";
  isRunAlive?: (record: ActivityRecord) => boolean;
}>;

export function decideGeneration(
  state: ActivityState,
  nowMs: number,
  options: DecisionOptions = {},
): GenerationDecision {
  const policy = options.policy ?? DEFAULT_ACTIVITY_POLICY;
  const mode = options.mode ?? "scheduled";
  const { record } = state;
  const observation = record.observation;
  if (!observation || !inputsObserved(state)) {
    return { kind: "skip", reason: "unobserved" };
  }
  const fingerprint = observation.fingerprint;

  if (isRunning(record, nowMs, policy, options.isRunAlive)) {
    return { kind: "skip", reason: "running" };
  }
  if (mode === "force") return { kind: "generate", fingerprint };
  if (freshnessOf(state) === "current") {
    return { kind: "skip", reason: "current" };
  }
  if (mode === "refresh") return { kind: "generate", fingerprint };
  if (!observation.hasEvidence) {
    return { kind: "skip", reason: "no-evidence" };
  }
  if (!isActive(state, nowMs, policy)) {
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

  const lastActivity = lastActivityMs(state) ?? nowMs;
  const quietFor = nowMs - lastActivity;
  const pendingFor = observation.pendingSince
    ? nowMs - Date.parse(observation.pendingSince)
    : 0;
  if (quietFor < policy.debounceMs && pendingFor < policy.maxDelayMs) {
    return {
      kind: "skip",
      reason: "debouncing",
      retryAtMs: Math.min(
        lastActivity + policy.debounceMs,
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
  state: ActivityState,
  nowMs: number,
  options: Pick<DecisionOptions, "policy" | "isRunAlive"> = {},
): ActivityView {
  const policy = options.policy ?? DEFAULT_ACTIVITY_POLICY;
  const { record, inputs } = state;
  const digest = record.digest;
  const running = isRunning(record, nowMs, policy, options.isRunAlive);
  const storedState = record.generation.state;
  const generationState =
    storedState === "running" && !running ? "failed" : storedState;
  const handoffNext = latestHandoffNext(state);
  return {
    key: record.target.key,
    selector: record.target.selector,
    type: record.target.type,
    path: record.target.path,
    freshness: freshnessOf(state),
    generationState,
    active: isActive(state, nowMs, policy),
    pinned: inputs.pinned,
    // A digest purpose copied from a since-cleared explicit purpose is not
    // shown; only inferred digest purposes stand on their own.
    purpose:
      inputs.purpose ??
      (digest?.purposeSource === "inferred" ? digest.purpose : null),
    purposeSource: inputs.purpose
      ? "user"
      : digest?.purposeSource === "inferred"
        ? "inferred"
        : null,
    latest: digest?.latest ?? null,
    likelyNext: handoffNext ?? digest?.likelyNext ?? null,
    likelyNextBasis: handoffNext
      ? "handoff"
      : (digest?.likelyNextBasis ?? null),
    confidence: digest?.confidence ?? null,
    insufficientContext: digest?.insufficientContext ?? null,
    evidence: digest?.evidence ?? [],
    lastActivityAt: (() => {
      const last = lastActivityMs(state);
      return last === null ? null : new Date(last).toISOString();
    })(),
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
 * An explicit handoff's next step outranks inference until a digest whose
 * evidence already included that handoff exists; that digest may know the
 * step was completed.
 */
function latestHandoffNext(state: ActivityState): string | null {
  const event = [...state.inputs.events].reverse().find((entry) => entry.next);
  if (!event?.next) return null;
  const observed = state.record.digest?.observedThrough;
  if (observed && Date.parse(observed) >= Date.parse(event.at)) return null;
  return event.next;
}
