/**
 * Activity state for one Workforest checkout (a workspace or a repository
 * worktree) is split by durability:
 *
 * - `ActivityRecord` is regenerable cache under
 *   `<cache>/_activity/records/<key>.json`: what the last cheap detection
 *   pass saw (`observation`), the last *successful* digest tied to the input
 *   fingerprint it summarized (`digest`, never erased by failures), and
 *   queue/run/failure bookkeeping (`generation`).
 * - `ActivityInputs` is authored data under
 *   `<config dir>/activity/inputs/<key>.json`: explicit purpose, pin, and
 *   handoff notes. It survives cache wipes and outranks inference.
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
  /**
   * When this observation's capture began. A capture that began earlier
   * never replaces a later one, whatever order they finish in.
   */
  captureStartedAt: string;
  /** The inputs revision folded into `fingerprint`. */
  inputsRevision: number;
  /**
   * Whether anything checkout-specific exists to summarize: commits beyond
   * the shared baseline, uncommitted changes, a purpose, or handoff notes.
   * A slug or shared upstream history alone never triggers a digest.
   */
  hasEvidence: boolean;
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
  inputsRevision: number;
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
  /** Host of the claimant; a claim from another host is never superseded. */
  host: string | null;
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

export type ActivityInputs = {
  version: typeof ACTIVITY_RECORD_VERSION;
  target: ActivityTargetIdentity;
  purpose: string | null;
  pinned: boolean;
  events: ActivityEvent[];
  /**
   * Increments whenever purpose or events change. Observations and digests
   * record the revision they saw, so an input change makes cached state
   * outdated immediately without running Git.
   */
  revision: number;
  /** Last purpose or note change; counts as activity. Pins do not. */
  activityAt: string | null;
};

export type ActivityRecord = {
  version: typeof ACTIVITY_RECORD_VERSION;
  target: ActivityTargetIdentity;
  observation: ActivityObservation | null;
  digest: ActivityDigest | null;
  generation: ActivityGeneration;
};

/** The pair every policy decision reads. */
export type ActivityState = Readonly<{
  record: ActivityRecord;
  inputs: ActivityInputs;
}>;

/**
 * `current` means the digest matches the last observation and the current
 * explicit inputs, not the live disk.
 */
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
