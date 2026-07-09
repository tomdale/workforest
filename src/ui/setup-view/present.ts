/**
 * The session-native presentation seam for setup runs (`wf new`, worktree
 * creation): drives the per-repo pipelines while rendering progress from the
 * run's canonical event stream. Interactive terminals get the attached setup
 * grid (until run-end, with detach and graceful cancel); everything else gets
 * per-event console lines.
 */

import {
  emitServiceEvent,
  type ServiceEventSink,
} from "../../services/events.ts";
import {
  runParallel,
  terminateRunningCommands,
} from "../../utils/task-generator.ts";
import {
  cancelRepoInitializations,
  cancelRepoSetup,
  readRepoInitializationStates,
} from "../../workspace/initialization.ts";
import type { InitializationScope } from "../../workspace/initialization-scope.ts";
import type { RepoPipelineState } from "../../workspace/pipeline.ts";
import { followRunEvents } from "../../workspace/run-log/reader.ts";
import type { RunSession } from "../../workspace/run-log/session.ts";
import { resolveConfiguredMaxConcurrent } from "../../workspace/setup-limits.ts";
import { shouldUseGrid } from "../grid-consumer.ts";
import { createRunEventConsoleRenderer } from "./console.ts";
import { renderSetupGrid, type SetupViewEnvironment } from "./grid-view.ts";
import { printRunSummary, type RunSummaryOutcome } from "./summary.ts";

export type PresentRunOutcome =
  | "ready"
  | "failed"
  | "cancelled"
  | "detached"
  | "background";

export type PresentRunOptions = {
  session: RunSession;
  /** Initialization scope backing the run; used for graceful cancel. */
  scope: InitializationScope;
  pipelines: Map<string, AsyncGenerator<RepoPipelineState>>;
  repoNames: string[];
  interactive: boolean;
  targetDir: string;
  onEvent?: ServiceEventSink;
  /** Stream subprocess output in the console fallback. */
  verbose?: boolean;
  /** Whether the attached view may detach its foreground git phase. */
  canDetach?: boolean;
  nextSteps?: readonly string[];
  onFailure?: (
    repoName: string,
    state: Extract<RepoPipelineState, { phase: "failed" }>,
  ) => void | Promise<void>;
  onBeforeCompletionPrompt?: (
    results: Map<string, { hasLockfile: boolean }>,
  ) => void | Promise<void>;
  /**
   * Invoked when a graceful cancel stops a repo's pipeline before it settled
   * on its own. Callers that gate shared work on per-repo completion (the
   * template copy barrier) use this to keep their accounting balanced.
   */
  onRepoCancelled?: (repoName: string) => void;
  maxConcurrent?: number;
  shouldUseGrid?: typeof shouldUseGrid;
  environment?: SetupViewEnvironment;
  /** Where the scrollback summary is written; defaults to stdout. */
  writeSummary?: (text: string) => void;
};

export type PresentRunResult = {
  results: Map<string, { hasLockfile: boolean }>;
  outcome: PresentRunOutcome;
};

/**
 * Drive the repo pipelines and present their progress. Returns the repos
 * whose worktrees became ready (mirroring the legacy presentPipelines
 * contract) plus the run outcome so callers can map cancellation to exit
 * codes.
 */
export async function presentRun(
  options: PresentRunOptions,
): Promise<PresentRunResult> {
  const useGrid = options.shouldUseGrid ?? shouldUseGrid;
  const maxConcurrent =
    options.maxConcurrent ?? (await resolveConfiguredMaxConcurrent());

  const results = new Map<string, { hasLockfile: boolean }>();
  const cancelState = { requested: false };

  // "worktree-ready" is intentionally not settled: interrupting there stops
  // the pipeline before it launches a background worker the user just asked
  // to cancel.
  const isSettledPhase = (state: RepoPipelineState): boolean =>
    state.phase === "complete" ||
    state.phase === "failed" ||
    state.phase === "cancelled";

  // Wrap every pipeline in a cancellation gate: once a cancel is requested,
  // pipelines that have not started stop before doing any work, and running
  // ones stop at their next state. Both mark their repo cancelled so
  // finalization reaches a terminal workspace state and records run-end.
  const gatePipeline = (
    name: string,
    source: AsyncGenerator<RepoPipelineState>,
  ): AsyncGenerator<RepoPipelineState> =>
    (async function* (): AsyncGenerator<RepoPipelineState> {
      const cancelHere = async (): Promise<RepoPipelineState> => {
        await cancelRepoSetup(options.scope, name);
        options.session.emit({
          kind: "repo-end",
          repo: name,
          outcome: "cancelled",
        });
        options.onRepoCancelled?.(name);
        return { phase: "cancelled", message: "Setup cancelled" };
      };

      if (cancelState.requested) {
        yield await cancelHere();
        return;
      }

      let interrupted = false;
      for await (const state of source) {
        yield state;
        if (cancelState.requested && !isSettledPhase(state)) {
          interrupted = true;
          break;
        }
      }
      if (interrupted) {
        yield await cancelHere();
      }
    })();

  const gatedPipelines = new Map(
    [...options.pipelines].map(([name, source]) => [
      name,
      gatePipeline(name, source),
    ]),
  );

  const drive = async (): Promise<void> => {
    for await (const { id, state } of runParallel(gatedPipelines, {
      maxConcurrent,
    })) {
      switch (state.phase) {
        case "worktree-ready":
        case "complete":
          results.set(id, { hasLockfile: state.hasLockfile });
          break;
        case "failed":
          await options.onFailure?.(id, state);
          break;
        default:
          break;
      }
    }
    await options.onBeforeCompletionPrompt?.(results);
  };

  if (!options.interactive || !useGrid()) {
    return presentRunToConsole(options, drive, results);
  }

  const requestCancel = async (): Promise<void> => {
    if (cancelState.requested) return;
    cancelState.requested = true;
    await terminateRunningCommands();
    try {
      const states = await readRepoInitializationStates(options.scope);
      const active = states
        .filter(
          (state) => state.status === "queued" || state.status === "running",
        )
        .map((state) => state.repo);
      if (active.length > 0) {
        await cancelRepoInitializations(options.scope, active);
      }
    } catch {
      // Best effort: workers self-terminate via their cancellation poll; a
      // repo that raced into a terminal state needs no cancellation.
    }
  };

  let driveError: unknown = null;
  let signalDriveFailed: () => void = () => undefined;
  const driveFailed = new Promise<void>((resolve) => {
    signalDriveFailed = resolve;
  });
  const driver = drive().catch((error: unknown) => {
    driveError = error;
    signalDriveFailed();
  });

  const gridResult = await renderSetupGrid({
    events: followRunEvents(options.session.runDir),
    repoNames: options.repoNames,
    mode: "until-ready",
    targetDir: options.targetDir,
    ...(options.canDetach !== undefined
      ? { canDetach: options.canDetach }
      : {}),
    onCancelRequest: requestCancel,
    abort: driveFailed,
    ...(options.environment ? { environment: options.environment } : {}),
  });

  if (gridResult.outcome === "detached") {
    // Keep launching background workers for repos whose git phase is still
    // running; surface that residual progress as console lines.
    emitServiceEvent(options.onEvent, {
      type: "message",
      level: "info",
      message:
        "Detached from setup. Remaining worktrees finish in the foreground before handing off.",
    });
    const renderer = createRunEventConsoleRenderer({
      verbose: options.verbose ?? false,
    });
    const consolePump = (async (): Promise<void> => {
      for await (const event of options.session.subscribe()) {
        for (const line of renderer.render(event)) {
          emitServiceEvent(options.onEvent, {
            type: "message",
            level: line.level,
            message: line.message,
          });
        }
      }
    })();
    await driver;
    await options.session.close().catch(() => undefined);
    await consolePump.catch(() => undefined);
  } else {
    await driver;
  }

  if (driveError !== null) {
    throw driveError;
  }

  if (cancelState.requested) {
    // Sweep any child spawned between the first kill and pipeline shutdown.
    await terminateRunningCommands().catch(() => undefined);
  }

  const summaryOutcome: RunSummaryOutcome =
    gridResult.outcome === "detached"
      ? "detached"
      : gridResult.outcome === "cancelled"
        ? "cancelled"
        : gridResult.outcome === "ready"
          ? "ready"
          : "failed";

  printRunSummary(
    {
      snapshot: gridResult.snapshot,
      targetDir: options.targetDir,
      outcome: summaryOutcome,
      repoNames: options.repoNames,
      ...(options.nextSteps &&
      (summaryOutcome === "ready" || summaryOutcome === "detached")
        ? { nextSteps: options.nextSteps }
        : {}),
    },
    options.writeSummary,
  );

  return { results, outcome: summaryOutcome };
}

/**
 * Console fallback: per-event lines rendered from the run's live event bus
 * while the pipelines run. Keeps the non-interactive early-return contract:
 * this resolves at background handoff, not at full readiness.
 */
async function presentRunToConsole(
  options: PresentRunOptions,
  drive: () => Promise<void>,
  results: Map<string, { hasLockfile: boolean }>,
): Promise<PresentRunResult> {
  const renderer = createRunEventConsoleRenderer({
    verbose: options.verbose ?? false,
  });
  const pump = (async (): Promise<void> => {
    for await (const event of options.session.subscribe()) {
      for (const line of renderer.render(event)) {
        emitServiceEvent(options.onEvent, {
          type: "message",
          level: line.level,
          message: line.message,
        });
      }
    }
  })();

  try {
    await drive();
  } finally {
    // Close the session so the subscription drains its queue and ends; the
    // caller's own close() afterwards is an idempotent no-op.
    await options.session.close().catch(() => undefined);
    await pump.catch(() => undefined);
  }

  return { results, outcome: "background" };
}
