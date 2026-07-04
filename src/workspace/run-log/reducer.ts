import { normalizeControlText } from "../../terminal/command-stream-adapter.ts";
import type { RunEvent, RunOutcome, StepId, StepOutcome } from "./events.ts";

export type StepStatus =
  | "pending"
  | "running"
  | "retrying"
  | "ok"
  | "failed"
  | "skipped"
  | "cancelled";

export type StepSnapshot = {
  step: StepId;
  title: string;
  status: StepStatus;
  startedAtMs?: number;
  durationMs?: number;
  attempt: number;
  lastMessage?: string;
};

export type RepoRunStatus =
  | "pending"
  | "running"
  | "handed-off"
  | "ready"
  | "failed"
  | "cancelled";

export type RepoRunSnapshot = {
  repo: string;
  status: RepoRunStatus;
  /** Ordered by first step-start. */
  steps: readonly StepSnapshot[];
  /** Newest normalized output and log lines, oldest first. */
  tail: readonly string[];
  error?: string;
  failedStep?: StepId;
  hasLockfile?: boolean;
};

export type RunSnapshot = {
  runId?: string;
  command?: string;
  startedAtMs?: number;
  repos: ReadonlyMap<string, RepoRunSnapshot>;
  /** Workspace-scoped steps (hooks, AGENTS.md refresh). */
  workspaceSteps: readonly StepSnapshot[];
  workspaceTail: readonly string[];
  outcome?: RunOutcome;
  durationMs?: number;
};

export type RunReducer = {
  apply(event: RunEvent): void;
  snapshot(): RunSnapshot;
};

export type RunReducerOptions = {
  /** Maximum retained output lines per repo (and for workspace steps). */
  tailLines?: number;
};

const DEFAULT_TAIL_LINES = 200;

type MutableStep = {
  step: StepId;
  title: string;
  status: StepStatus;
  startedAtMs?: number;
  durationMs?: number;
  attempt: number;
  lastMessage?: string;
};

type MutableTarget = {
  steps: Map<StepId, MutableStep>;
  tail: LineTail;
};

type MutableRepo = MutableTarget & {
  repo: string;
  status: RepoRunStatus;
  error?: string;
  failedStep?: StepId;
  hasLockfile?: boolean;
};

/**
 * Folds a run's event stream into the snapshot every surface renders from.
 * Pure state machine over events; safe to feed live or replayed streams.
 */
export function createRunReducer(options: RunReducerOptions = {}): RunReducer {
  const tailLines = options.tailLines ?? DEFAULT_TAIL_LINES;
  const repos = new Map<string, MutableRepo>();
  const workspace: MutableTarget = {
    steps: new Map(),
    tail: new LineTail(tailLines),
  };
  let runId: string | undefined;
  let command: string | undefined;
  let startedAtMs: number | undefined;
  let outcome: RunOutcome | undefined;
  let durationMs: number | undefined;

  const ensureRepo = (name: string): MutableRepo => {
    const existing = repos.get(name);
    if (existing) return existing;
    const created: MutableRepo = {
      repo: name,
      status: "pending",
      steps: new Map(),
      tail: new LineTail(tailLines),
    };
    repos.set(name, created);
    return created;
  };

  const targetFor = (repo: string | null): MutableTarget =>
    repo === null ? workspace : ensureRepo(repo);

  const markRunning = (repo: string | null): void => {
    if (repo === null) return;
    const entry = ensureRepo(repo);
    if (entry.status === "pending" || entry.status === "handed-off") {
      entry.status = "running";
    }
  };

  const apply = (event: RunEvent): void => {
    runId ??= event.runId;

    switch (event.kind) {
      case "run-start": {
        command = event.command;
        startedAtMs = Date.parse(event.ts);
        for (const repo of event.repos) ensureRepo(repo);
        return;
      }
      case "repo-start": {
        markRunning(event.repo);
        return;
      }
      case "step-start": {
        const target = targetFor(event.repo);
        target.steps.set(event.step, {
          step: event.step,
          title: event.title,
          status: "running",
          startedAtMs: Date.parse(event.ts),
          attempt: 1,
        });
        markRunning(event.repo);
        return;
      }
      case "step-output": {
        targetFor(event.repo).tail.pushChunk(event.chunk);
        return;
      }
      case "step-log": {
        const target = targetFor(event.repo);
        target.tail.pushLine(event.message);
        const step = target.steps.get(event.step);
        if (step) step.lastMessage = event.message;
        return;
      }
      case "step-retry": {
        const target = targetFor(event.repo);
        const step = target.steps.get(event.step);
        if (step) {
          step.status = "retrying";
          step.attempt = event.attempt;
          step.lastMessage = event.reason;
        }
        // A retry restarts the step's output; stale lines would misattribute
        // the previous attempt's output to the new one.
        target.tail.clear();
        target.tail.pushLine(`Retry ${event.attempt}: ${event.reason}`);
        return;
      }
      case "step-end": {
        const target = targetFor(event.repo);
        const step = target.steps.get(event.step) ?? {
          step: event.step,
          title: event.step,
          status: "running" as StepStatus,
          attempt: 1,
        };
        target.steps.set(event.step, step);
        step.status = stepOutcomeToStatus(event.outcome);
        step.durationMs = event.durationMs;
        if (event.reason) step.lastMessage = event.reason;
        if (event.error) {
          step.lastMessage = event.error.message;
          if (event.repo !== null) {
            const repo = ensureRepo(event.repo);
            repo.error = event.error.message;
            repo.failedStep = event.step;
          }
        }
        return;
      }
      case "worktree-ready": {
        const repo = ensureRepo(event.repo);
        repo.hasLockfile = event.hasLockfile;
        return;
      }
      case "repo-handoff": {
        const repo = ensureRepo(event.repo);
        if (!isTerminalRepoStatus(repo.status)) {
          repo.status = "handed-off";
        }
        return;
      }
      case "repo-end": {
        const repo = ensureRepo(event.repo);
        repo.status = event.outcome;
        if (event.hasLockfile !== undefined) {
          repo.hasLockfile = event.hasLockfile;
        }
        if (event.error) repo.error = event.error.message;
        if (event.step) repo.failedStep = event.step;
        return;
      }
      case "run-end": {
        outcome = event.outcome;
        durationMs = event.durationMs;
        return;
      }
    }
  };

  const snapshot = (): RunSnapshot => ({
    ...(runId !== undefined ? { runId } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(startedAtMs !== undefined && Number.isFinite(startedAtMs)
      ? { startedAtMs }
      : {}),
    repos: new Map(
      [...repos.values()].map((repo) => [
        repo.repo,
        {
          repo: repo.repo,
          status: repo.status,
          steps: snapshotSteps(repo.steps),
          tail: repo.tail.lines(),
          ...(repo.error !== undefined ? { error: repo.error } : {}),
          ...(repo.failedStep !== undefined
            ? { failedStep: repo.failedStep }
            : {}),
          ...(repo.hasLockfile !== undefined
            ? { hasLockfile: repo.hasLockfile }
            : {}),
        },
      ]),
    ),
    workspaceSteps: snapshotSteps(workspace.steps),
    workspaceTail: workspace.tail.lines(),
    ...(outcome !== undefined ? { outcome } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  });

  return { apply, snapshot };
}

function snapshotSteps(steps: Map<StepId, MutableStep>): StepSnapshot[] {
  return [...steps.values()].map((step) => ({ ...step }));
}

function stepOutcomeToStatus(outcome: StepOutcome): StepStatus {
  switch (outcome) {
    case "ok":
      return "ok";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "cancelled":
      return "cancelled";
  }
}

function isTerminalRepoStatus(status: RepoRunStatus): boolean {
  return status === "ready" || status === "failed" || status === "cancelled";
}

/**
 * Line accumulator with CommandStreamAdapter semantics: control sequences
 * stripped, carriage returns reset the in-progress line (so child progress
 * bars collapse to their final state), bounded retention.
 */
class LineTail {
  readonly #maxLines: number;
  #lines: string[] = [];
  #current = "";

  constructor(maxLines: number) {
    this.#maxLines = Math.max(1, maxLines);
  }

  pushChunk(chunk: string): void {
    const normalized = normalizeControlText(chunk);
    for (const char of normalized) {
      if (char === "\r") {
        this.#current = "";
        continue;
      }
      if (char === "\n") {
        this.#commit(this.#current);
        this.#current = "";
        continue;
      }
      this.#current += char;
    }
  }

  pushLine(line: string): void {
    if (this.#current) {
      this.#commit(this.#current);
      this.#current = "";
    }
    this.#commit(normalizeControlText(line));
  }

  clear(): void {
    this.#lines = [];
    this.#current = "";
  }

  lines(): string[] {
    const result = [...this.#lines];
    if (this.#current) result.push(this.#current);
    return result.slice(-this.#maxLines);
  }

  #commit(line: string): void {
    this.#lines.push(line);
    if (this.#lines.length > this.#maxLines) {
      this.#lines.splice(0, this.#lines.length - this.#maxLines);
    }
  }
}
