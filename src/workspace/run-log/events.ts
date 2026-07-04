/**
 * Canonical event model for workspace and worktree setup runs.
 *
 * Every setup run (foreground CLI plus any detached initializer workers)
 * appends these events to per-process JSONL segment files under the run
 * directory. All progress surfaces (grid, console fallback, status, logs)
 * derive from this stream rather than from ad hoc state types.
 */

/**
 * Identifies one unit of work within a repository's setup.
 *
 * Conventions:
 * - `git:mirror` | `git:cleanup` | `git:worktree` for the git phase
 * - `init:<plugin-id>` for initializers (e.g. `init:pnpm-install`)
 * - `init:detect` for project-type detection
 * - `init:preflight` for pre-initializer preparation (template barrier)
 * - `hook:<name>` for workspace hooks (workspace-scoped, `repo: null`)
 * - `task:<name>` for compat adapters over task-style pipelines
 */
export type StepId = string;

export const GIT_STEP_IDS = {
  mirror: "git:mirror",
  cleanup: "git:cleanup",
  worktree: "git:worktree",
} as const;

export const DETECT_STEP_ID = "init:detect";
export const PREFLIGHT_STEP_ID = "init:preflight";

export function initializerStepId(initializerId: string): StepId {
  return `init:${initializerId}`;
}

export function hookStepId(hookName: string): StepId {
  return `hook:${hookName}`;
}

export type StepOutcome = "ok" | "failed" | "skipped" | "cancelled";

export type RunOutcome = "ready" | "failed" | "cancelled";

export type RunScopeKind = "workspace" | "worktree";

export type RunEventError = Readonly<{
  message: string;
  stack?: string;
}>;

export type RunEventEnvelope = Readonly<{
  v: 1;
  runId: string;
  /** Writer id: "cli" or `worker:<repo>`. One writer per segment file. */
  src: string;
  /** Per-writer monotonic counter; breaks ties among same-timestamp events. */
  seq: number;
  /** ISO-8601 timestamp with millisecond precision. */
  ts: string;
}>;

export type RunEventBody =
  | {
      kind: "run-start";
      command: string;
      repos: readonly string[];
      scope: RunScopeKind;
      pid: number;
    }
  | { kind: "repo-start"; repo: string }
  | { kind: "step-start"; repo: string | null; step: StepId; title: string }
  | { kind: "step-output"; repo: string | null; step: StepId; chunk: string }
  | {
      kind: "step-log";
      repo: string | null;
      step: StepId;
      level: "info" | "warn" | "error";
      message: string;
    }
  | {
      kind: "step-retry";
      repo: string | null;
      step: StepId;
      attempt: number;
      reason: string;
    }
  | {
      kind: "step-end";
      repo: string | null;
      step: StepId;
      outcome: StepOutcome;
      durationMs: number;
      error?: RunEventError;
      reason?: string;
    }
  | {
      kind: "worktree-ready";
      repo: string;
      hasLockfile: boolean;
    }
  | { kind: "repo-handoff"; repo: string; workerPid: number }
  | {
      kind: "repo-end";
      repo: string;
      outcome: RunOutcome;
      hasLockfile?: boolean;
      step?: StepId;
      error?: RunEventError;
    }
  | { kind: "run-end"; outcome: RunOutcome; durationMs: number };

export type RunEvent = RunEventEnvelope & RunEventBody;

export type RunManifest = Readonly<{
  v: 1;
  runId: string;
  startedAt: string;
  /** The user-facing operation that produced this run, e.g. "new" or "retry". */
  command: string;
  repos: readonly string[];
  scopeKind: RunScopeKind;
}>;

const EVENT_KINDS: ReadonlySet<string> = new Set([
  "run-start",
  "repo-start",
  "step-start",
  "step-output",
  "step-log",
  "step-retry",
  "step-end",
  "worktree-ready",
  "repo-handoff",
  "repo-end",
  "run-end",
]);

/**
 * Parse one JSONL line into a RunEvent. Returns null for blank lines,
 * torn trailing lines from a crashed writer, and unrecognized shapes.
 */
export function parseRunEventLine(line: string): RunEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate["v"] !== 1 ||
    typeof candidate["runId"] !== "string" ||
    typeof candidate["src"] !== "string" ||
    typeof candidate["seq"] !== "number" ||
    typeof candidate["ts"] !== "string" ||
    typeof candidate["kind"] !== "string" ||
    !EVENT_KINDS.has(candidate["kind"])
  ) {
    return null;
  }

  return value as RunEvent;
}

/**
 * Deterministic ordering for merged segment streams: timestamp first
 * (ISO-8601 strings sort lexicographically), then writer id, then the
 * writer's own sequence number.
 */
export function compareRunEvents(a: RunEvent, b: RunEvent): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.src !== b.src) return a.src < b.src ? -1 : 1;
  return a.seq - b.seq;
}

export function toRunEventError(error: Error): RunEventError {
  return {
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
  };
}

export function fromRunEventError(error: RunEventError): Error {
  const restored = new Error(error.message);
  if (error.stack) {
    restored.stack = error.stack;
  }
  return restored;
}
