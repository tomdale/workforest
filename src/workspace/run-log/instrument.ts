import type { SingleRepoInitializerState } from "../../services/initializers/index.ts";
import type { HookState } from "../../templates/apply.ts";
import type { TaskState } from "../../utils/task-generator.ts";
import type { RepoPipelineState } from "../pipeline.ts";
import {
  DETECT_STEP_ID,
  fromRunEventError,
  hookStepId,
  initializerStepId,
  PREFLIGHT_STEP_ID,
  type RunEventBody,
  type StepId,
  type StepOutcome,
  toRunEventError,
} from "./events.ts";

export type StepEventContext = {
  repo: string | null;
  step: StepId;
  title: string;
};

export type StepResult = {
  outcome: StepOutcome;
  error?: Error;
  reason?: string;
};

/**
 * Run one TaskState generator as a single timed step, translating its states
 * into run events. Total: source throws become a failed step result rather
 * than propagating.
 */
export async function* taskToEvents(
  task: AsyncGenerator<TaskState>,
  { repo, step, title }: StepEventContext,
): AsyncGenerator<RunEventBody, StepResult> {
  const startedAt = Date.now();
  const durationMs = (): number => Date.now() - startedAt;
  yield { kind: "step-start", repo, step, title };

  let skippedReason: string | undefined;
  try {
    for await (const state of task) {
      switch (state.status) {
        case "pending":
          break;
        case "running":
          if (state.message) {
            yield {
              kind: "step-log",
              repo,
              step,
              level: "info",
              message: state.message,
            };
          }
          break;
        case "output":
          yield { kind: "step-output", repo, step, chunk: state.data };
          break;
        case "log":
          yield {
            kind: "step-log",
            repo,
            step,
            level: state.level,
            message: state.message,
          };
          break;
        case "retrying":
          yield {
            kind: "step-retry",
            repo,
            step,
            attempt: state.attempt,
            reason: state.reason,
          };
          break;
        case "completed":
          yield {
            kind: "step-end",
            repo,
            step,
            outcome: "ok",
            durationMs: durationMs(),
          };
          return { outcome: "ok" };
        case "failed":
          yield {
            kind: "step-end",
            repo,
            step,
            outcome: "failed",
            durationMs: durationMs(),
            error: toRunEventError(state.error),
          };
          return { outcome: "failed", error: state.error };
        case "skipped":
          skippedReason = state.reason;
          break;
      }
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    yield {
      kind: "step-end",
      repo,
      step,
      outcome: "failed",
      durationMs: durationMs(),
      error: toRunEventError(failure),
    };
    return { outcome: "failed", error: failure };
  }

  if (skippedReason !== undefined) {
    yield {
      kind: "step-end",
      repo,
      step,
      outcome: "skipped",
      durationMs: durationMs(),
      reason: skippedReason,
    };
    return { outcome: "skipped", reason: skippedReason };
  }

  yield {
    kind: "step-end",
    repo,
    step,
    outcome: "ok",
    durationMs: durationMs(),
  };
  return { outcome: "ok" };
}

export type InitializersResult =
  | { outcome: "ok" }
  | { outcome: "failed"; error: Error; step: StepId; stepTitle: string };

/**
 * Translate a repo's initializer state stream into run events: one detect
 * step plus one step per initializer. A failed initializer ends the stream,
 * matching the sequential abort behavior of runSingleRepoInitializers.
 */
export async function* initializerStatesToEvents(
  states: AsyncGenerator<SingleRepoInitializerState>,
  repo: string,
): AsyncGenerator<RunEventBody, InitializersResult> {
  const startedTimes = new Map<StepId, number>();
  let detectOpen = false;
  let current: { step: StepId; title: string } | null = null;

  const startStep = function* (
    step: StepId,
    title: string,
  ): Generator<RunEventBody> {
    startedTimes.set(step, Date.now());
    yield { kind: "step-start", repo, step, title };
  };
  const endStep = function* (
    step: StepId,
    outcome: StepOutcome,
    extras: { error?: Error; reason?: string } = {},
  ): Generator<RunEventBody> {
    const startedAt = startedTimes.get(step) ?? Date.now();
    yield {
      kind: "step-end",
      repo,
      step,
      outcome,
      durationMs: Date.now() - startedAt,
      ...(extras.error ? { error: toRunEventError(extras.error) } : {}),
      ...(extras.reason !== undefined ? { reason: extras.reason } : {}),
    };
  };
  const closeDetect = function* (): Generator<RunEventBody> {
    if (!detectOpen) return;
    detectOpen = false;
    yield* endStep(DETECT_STEP_ID, "ok");
  };

  try {
    for await (const state of states) {
      switch (state.phase) {
        case "detecting": {
          detectOpen = true;
          yield* startStep(DETECT_STEP_ID, "detect");
          break;
        }
        case "running": {
          yield* closeDetect();
          const step = initializerStepId(state.initializerId);
          if (current === null || current.step !== step) {
            current = { step, title: state.initializerName };
            yield* startStep(step, state.initializerName);
          }
          const task = state.state;
          switch (task.status) {
            case "pending":
              break;
            case "running":
              if (task.message) {
                yield {
                  kind: "step-log",
                  repo,
                  step,
                  level: "info",
                  message: task.message,
                };
              }
              break;
            case "output":
              yield { kind: "step-output", repo, step, chunk: task.data };
              break;
            case "log":
              yield {
                kind: "step-log",
                repo,
                step,
                level: task.level,
                message: task.message,
              };
              break;
            case "retrying":
              yield {
                kind: "step-retry",
                repo,
                step,
                attempt: task.attempt,
                reason: task.reason,
              };
              break;
            case "completed":
              yield* endStep(step, "ok");
              current = null;
              break;
            case "failed":
              yield* endStep(step, "failed", { error: task.error });
              return {
                outcome: "failed",
                error: task.error,
                step,
                stepTitle: state.initializerName,
              };
            case "skipped":
              yield* endStep(step, "skipped", { reason: task.reason });
              current = null;
              break;
          }
          break;
        }
        case "skipped": {
          yield* closeDetect();
          const step = initializerStepId(state.initializerId);
          yield* startStep(step, state.initializerId);
          yield* endStep(step, "skipped", { reason: state.reason });
          break;
        }
        case "complete": {
          yield* closeDetect();
          break;
        }
      }
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const step = current?.step ?? DETECT_STEP_ID;
    const stepTitle = current?.title ?? "detect";
    yield* endStep(step, "failed", { error: failure });
    return { outcome: "failed", error: failure, step, stepTitle };
  }

  yield* closeDetect();
  return { outcome: "ok" };
}

/**
 * Translate workspace hook states into run events (workspace-scoped, so
 * `repo` is null). A hook that runs in several directories is one step; a
 * thrown abort (continueOnError unset) fails the current hook's step and
 * rethrows for the caller's workspace-state handling.
 */
export async function* hookStatesToEvents(
  states: AsyncGenerator<HookState>,
): AsyncGenerator<RunEventBody> {
  const startedTimes = new Map<StepId, number>();
  let current: StepId | null = null;

  try {
    for await (const state of states) {
      const step = hookStepId(state.hookName);
      switch (state.phase) {
        case "hook-start": {
          current = step;
          startedTimes.set(step, Date.now());
          yield { kind: "step-start", repo: null, step, title: state.hookName };
          break;
        }
        case "hook": {
          const task = state.state;
          switch (task.status) {
            case "pending":
            case "completed":
              break;
            case "running":
              if (task.message) {
                yield {
                  kind: "step-log",
                  repo: null,
                  step,
                  level: "info",
                  message: task.message,
                };
              }
              break;
            case "output":
              yield { kind: "step-output", repo: null, step, chunk: task.data };
              break;
            case "log":
              yield {
                kind: "step-log",
                repo: null,
                step,
                level: task.level,
                message: task.message,
              };
              break;
            case "retrying":
              yield {
                kind: "step-retry",
                repo: null,
                step,
                attempt: task.attempt,
                reason: task.reason,
              };
              break;
            case "failed":
              // With continueOnError the stream keeps going, so a failed
              // command is a log line here; an aborting failure arrives as a
              // thrown error instead.
              yield {
                kind: "step-log",
                repo: null,
                step,
                level: "error",
                message: task.error.message,
              };
              break;
            case "skipped":
              yield {
                kind: "step-log",
                repo: null,
                step,
                level: "info",
                message: `Skipped: ${task.reason}`,
              };
              break;
          }
          break;
        }
        case "hook-complete": {
          current = null;
          yield {
            kind: "step-end",
            repo: null,
            step,
            outcome: "ok",
            durationMs: Date.now() - (startedTimes.get(step) ?? Date.now()),
          };
          break;
        }
      }
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (current) {
      yield {
        kind: "step-end",
        repo: null,
        step: current,
        outcome: "failed",
        durationMs: Date.now() - (startedTimes.get(current) ?? Date.now()),
        error: toRunEventError(failure),
      };
    }
    throw failure;
  }
}

export type PipelineEventBridge = {
  convert(state: RepoPipelineState): RunEventBody[];
};

/**
 * Compatibility bridge in the opposite direction of
 * {@link createPipelineStateConverter}: lifts a legacy RepoPipelineState
 * stream (tasks, review, cloud fan-outs) into run events so those surfaces
 * can render through the event-native setup view. Stateful per repo: it
 * tracks the open step so transitions become timed step-start/step-end pairs.
 */
export function createPipelineEventBridge(repo: string): PipelineEventBridge {
  let current: { step: StepId; title: string } | null = null;
  const startedTimes = new Map<StepId, number>();
  let retryAttempts = 0;

  const stepFor = (
    state: Extract<RepoPipelineState, { phase: "git" | "initializer" }>,
  ): { step: StepId; title: string } =>
    state.phase === "git"
      ? { step: `git:${state.step}`, title: state.step }
      : { step: `task:${state.name}`, title: state.name };

  const openStep = (target: {
    step: StepId;
    title: string;
  }): RunEventBody[] => {
    const events: RunEventBody[] = [];
    if (current !== null && current.step !== target.step) {
      events.push(...closeStep("ok"));
    }
    if (current === null || current.step !== target.step) {
      current = target;
      retryAttempts = 0;
      startedTimes.set(target.step, Date.now());
      events.push({
        kind: "step-start",
        repo,
        step: target.step,
        title: target.title,
      });
    }
    return events;
  };

  const closeStep = (
    outcome: StepOutcome,
    extras: { error?: Error; reason?: string } = {},
  ): RunEventBody[] => {
    if (current === null) return [];
    const { step } = current;
    current = null;
    const startedAt = startedTimes.get(step) ?? Date.now();
    return [
      {
        kind: "step-end",
        repo,
        step,
        outcome,
        durationMs: Date.now() - startedAt,
        ...(extras.error ? { error: toRunEventError(extras.error) } : {}),
        ...(extras.reason !== undefined ? { reason: extras.reason } : {}),
      },
    ];
  };

  const convert = (state: RepoPipelineState): RunEventBody[] => {
    switch (state.phase) {
      case "git":
      case "initializer": {
        const target = stepFor(state);
        switch (state.status) {
          case "pending":
            return [];
          case "running": {
            const events = openStep(target);
            if (state.message) {
              events.push({
                kind: "step-log",
                repo,
                step: target.step,
                level: "info",
                message: state.message,
              });
            }
            return events;
          }
          case "output": {
            const events = openStep(target);
            if (state.output !== undefined) {
              events.push({
                kind: "step-output",
                repo,
                step: target.step,
                chunk: state.output,
              });
            }
            return events;
          }
          case "log": {
            const events = openStep(target);
            if (state.message) {
              events.push({
                kind: "step-log",
                repo,
                step: target.step,
                level: "info",
                message: state.message,
              });
            }
            return events;
          }
          case "retrying": {
            const events = openStep(target);
            retryAttempts += 1;
            events.push({
              kind: "step-retry",
              repo,
              step: target.step,
              attempt: retryAttempts + 1,
              reason: state.message ?? "Retrying",
            });
            return events;
          }
          case "completed":
            return [...openStep(target), ...closeStep("ok")];
          case "failed":
            return [...openStep(target), ...closeStep("failed")];
          case "skipped":
            return [
              ...openStep(target),
              ...closeStep("skipped", {
                ...(state.message !== undefined
                  ? { reason: state.message }
                  : {}),
              }),
            ];
        }
        break;
      }
      case "worktree-ready":
        return [
          ...closeStep("ok"),
          { kind: "worktree-ready", repo, hasLockfile: state.hasLockfile },
          {
            kind: "repo-end",
            repo,
            outcome: "ready",
            hasLockfile: state.hasLockfile,
          },
        ];
      case "complete":
        return [
          ...closeStep("ok"),
          {
            kind: "repo-end",
            repo,
            outcome: "ready",
            hasLockfile: state.hasLockfile,
          },
        ];
      case "cancelled":
        return [
          ...closeStep("cancelled"),
          { kind: "repo-end", repo, outcome: "cancelled" },
        ];
      case "failed":
        return [
          ...closeStep("failed", { error: state.error }),
          {
            kind: "repo-end",
            repo,
            outcome: "failed",
            ...(state.step !== undefined ? { step: state.step } : {}),
            error: toRunEventError(state.error),
          },
        ];
    }
    return [];
  };

  return { convert };
}

export type PipelineStateConverter = {
  convert(body: RunEventBody): RepoPipelineState[];
};

/**
 * Compatibility bridge from run events back to the legacy RepoPipelineState
 * stream that existing presentation seams consume. Stateful: it remembers
 * step titles so failure steps render with the names surfaces expect.
 */
export function createPipelineStateConverter(): PipelineStateConverter {
  const titles = new Map<StepId, string>();

  const compatFailureStep = (step: StepId | undefined): string | undefined => {
    if (step === undefined) return undefined;
    if (step === DETECT_STEP_ID) return "initializer:detection";
    if (step === PREFLIGHT_STEP_ID) return "initializer:preflight";
    if (step.startsWith("init:")) {
      return `initializer:${titles.get(step) ?? step.slice("init:".length)}`;
    }
    return step;
  };

  const convert = (body: RunEventBody): RepoPipelineState[] => {
    switch (body.kind) {
      case "step-start": {
        titles.set(body.step, body.title);
        if (body.step === DETECT_STEP_ID) {
          return [
            {
              phase: "initializer",
              name: "detecting",
              status: "running",
              message: "Detecting project type...",
            },
          ];
        }
        const target = stepTarget(body.step, titles);
        if (!target) return [];
        return [{ ...target, status: "running" }];
      }
      case "step-log": {
        const target = stepTarget(body.step, titles);
        if (!target) return [];
        return [{ ...target, status: "running", message: body.message }];
      }
      case "step-output": {
        const target = stepTarget(body.step, titles);
        if (!target) return [];
        return [{ ...target, status: "output", output: body.chunk }];
      }
      case "step-retry": {
        const target = stepTarget(body.step, titles);
        if (!target) return [];
        return [
          {
            ...target,
            status: "retrying",
            message: `Retry ${body.attempt}: ${body.reason}`,
          },
        ];
      }
      case "step-end": {
        if (body.step === DETECT_STEP_ID) return [];
        const target = stepTarget(body.step, titles);
        if (!target) return [];
        switch (body.outcome) {
          case "ok":
            return [{ ...target, status: "completed" }];
          case "failed":
            return [{ ...target, status: "failed" }];
          case "skipped":
            return [
              {
                ...target,
                status: "skipped",
                ...(body.reason !== undefined ? { message: body.reason } : {}),
              },
            ];
          case "cancelled":
            return [];
        }
        break;
      }
      case "worktree-ready":
        return [{ phase: "complete", hasLockfile: body.hasLockfile }];
      case "repo-end": {
        switch (body.outcome) {
          case "ready":
            return [
              { phase: "complete", hasLockfile: body.hasLockfile ?? false },
            ];
          case "failed": {
            const step = compatFailureStep(body.step);
            return [
              {
                phase: "failed",
                error: fromRunEventError(
                  body.error ?? { message: "Repository setup failed." },
                ),
                ...(step !== undefined ? { step } : {}),
              },
            ];
          }
          case "cancelled":
            return [{ phase: "cancelled" }];
        }
        break;
      }
      case "run-start":
      case "run-end":
      case "repo-start":
      case "repo-handoff":
        return [];
    }
    return [];
  };

  return { convert };
}

type StepTargetState =
  | { phase: "git"; step: "mirror" | "cleanup" | "worktree" }
  | { phase: "initializer"; name: string };

function stepTarget(
  step: StepId,
  titles: Map<StepId, string>,
): StepTargetState | null {
  if (step === "git:mirror") return { phase: "git", step: "mirror" };
  if (step === "git:cleanup") return { phase: "git", step: "cleanup" };
  if (step === "git:worktree") return { phase: "git", step: "worktree" };
  if (step === PREFLIGHT_STEP_ID) return null;
  if (step === DETECT_STEP_ID) {
    return { phase: "initializer", name: "detecting" };
  }
  if (step.startsWith("init:")) {
    return {
      phase: "initializer",
      name: titles.get(step) ?? step.slice("init:".length),
    };
  }
  return null;
}
