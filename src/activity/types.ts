/**
 * Persisted activity state for one Workforest checkout (a workspace or a
 * repository worktree). One JSON record per checkout identity lives under
 * `<cache>/_activity/records/<key>.json`.
 *
 * The record keeps four independent concerns apart:
 * - `observation`: what the last cheap detection pass saw (never inferred).
 * - `digest`: the last *successful* generated summary, tied to the input
 *   fingerprint it summarized. Failures never erase it.
 * - `generation`: queue/run/failure bookkeeping for the next summary.
 * - `user` and `events`: explicit human or agent inputs (purpose, pin,
 *   handoffs) that outrank inference.
 */
export const ACTIVITY_RECORD_VERSION = 1;

export type ActivityTargetType =
  | "template-workspace"
  | "adhoc-workspace"
  | "worktree";

export type ActivityTargetIdentity = Readonly<{
  /** Stable hash of path + metadata creation time; changes on delete/recreate. */
  key: string;
  selector: string;
  type: ActivityTargetType;
  path: string;
  createdAt: string;
}>;

export type ActivityObservation = {
  /** Hash of every meaningful input: Git state, lifecycle, explicit inputs. */
  fingerprint: string;
  /** When detection last ran for this checkout (the freshness horizon). */
  checkedAt: string;
  /** When a meaningful input change was last observed (or estimated on first sight). */
  lastActivityAt: string;
  /** First observed change not yet covered by a digest; drives max-delay. */
  pendingSince: string | null;
};

export type LikelyNextBasis = "handoff" | "inferred";

export type ActivityDigest = {
  /** Short purpose; `purposeSource` says whether a person stated it. */
  purpose: string | null;
  purposeSource: "user" | "inferred" | null;
  /** Latest observed work, grounded in the evidence packet. */
  latest: string;
  likelyNext: string | null;
  likelyNextBasis: LikelyNextBasis | null;
  confidence: "high" | "medium" | "low";
  insufficientContext: boolean;
  /** Short evidence references the summary relied on (commits, events, files). */
  evidence: string[];
  /** Time the evidence was captured; the digest says nothing about later work. */
  observedThrough: string;
  generatedAt: string;
  fingerprint: string;
  provider: string;
  model: string | null;
  promptVersion: number;
};

export type GenerationState = "idle" | "queued" | "running" | "failed";

export type ActivityGeneration = {
  state: GenerationState;
  /** Fingerprint captured for the queued or running attempt. */
  fingerprint: string | null;
  runId: string | null;
  pid: number | null;
  startedAt: string | null;
  attempts: number;
  lastError: string | null;
  lastFailedAt: string | null;
  nextAttemptAt: string | null;
};

export type ActivityEvent = {
  at: string;
  /** Free-form origin such as `bb:thr_123` or `manual`. */
  source: string;
  summary: string | null;
  next: string | null;
};

export type ActivityUserInputs = {
  purpose: string | null;
  pinned: boolean;
  updatedAt: string | null;
};

export type ActivityRecord = {
  version: typeof ACTIVITY_RECORD_VERSION;
  target: ActivityTargetIdentity;
  observation: ActivityObservation | null;
  digest: ActivityDigest | null;
  generation: ActivityGeneration;
  user: ActivityUserInputs;
  events: ActivityEvent[];
};

/** `current` means the digest matches the last observation, not the live disk. */
export type ActivityFreshness = "current" | "outdated" | "missing";

/**
 * The machine-readable read model for UI clients. Built from the persisted
 * record only; producing it never runs Git or a model.
 */
export type ActivityView = Readonly<{
  key: string;
  selector: string;
  type: ActivityTargetType;
  path: string;
  freshness: ActivityFreshness;
  generationState: GenerationState;
  active: boolean;
  pinned: boolean;
  purpose: string | null;
  purposeSource: "user" | "inferred" | null;
  latest: string | null;
  likelyNext: string | null;
  likelyNextBasis: LikelyNextBasis | null;
  confidence: ActivityDigest["confidence"] | null;
  insufficientContext: boolean | null;
  evidence: readonly string[];
  lastActivityAt: string | null;
  lastCheckedAt: string | null;
  observedThrough: string | null;
  generatedAt: string | null;
  lastError: string | null;
  model: string | null;
  promptVersion: number | null;
}>;
