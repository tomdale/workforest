/**
 * Paged grid rendering for legacy RepoPipelineState pipelines (tasks, review,
 * cloud fan-outs) with more repositories than a 3×3 grid holds. Each
 * pipeline's states are lifted into run events through the compat bridge and
 * rendered by the event-native setup grid, which pages past nine panes
 * instead of refusing to render.
 */

import {
  runParallel,
  terminateRunningCommands,
} from "../../utils/task-generator.ts";
import type { RepoPipelineState } from "../../workspace/pipeline.ts";
import type { RunEvent, RunEventBody } from "../../workspace/run-log/events.ts";
import { createPipelineEventBridge } from "../../workspace/run-log/instrument.ts";
import { renderSetupGrid, type SetupViewEnvironment } from "./grid-view.ts";

export type RenderPipelinesGridPagedOptions = {
  pipelines: Map<string, AsyncGenerator<RepoPipelineState>>;
  repoNames: string[];
  workspacePath?: string;
  onFailure?: (
    repoName: string,
    state: Extract<RepoPipelineState, { phase: "failed" }>,
  ) => void | Promise<void>;
  onBeforeCompletionPrompt?: (
    repoResults: Map<string, { hasLockfile: boolean }>,
  ) => void | Promise<void>;
  maxConcurrent?: number;
  environment?: SetupViewEnvironment;
};

/**
 * Drive legacy pipelines and render them through the pageable setup grid.
 * Mirrors renderPipelinesGrid's contract: resolves with the repos whose
 * pipelines completed. A quit/cancel keypress stops the remaining pipelines
 * instead of exiting the process.
 */
export async function renderPipelinesGridPaged({
  pipelines,
  repoNames,
  workspacePath,
  onFailure,
  onBeforeCompletionPrompt,
  maxConcurrent,
  environment,
}: RenderPipelinesGridPagedOptions): Promise<
  Map<string, { hasLockfile: boolean }>
> {
  const queue: RunEvent[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let seq = 0;

  const push = (body: RunEventBody): void => {
    queue.push({
      v: 1,
      runId: "live",
      src: "cli",
      seq: seq++,
      ts: new Date().toISOString(),
      ...body,
    });
    wake?.();
    wake = null;
  };

  const events = (async function* (): AsyncGenerator<RunEvent> {
    while (true) {
      while (queue.length > 0) {
        const event = queue.shift();
        if (event) yield event;
      }
      if (closed) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();

  const startedAt = Date.now();
  push({
    kind: "run-start",
    command: "setup",
    repos: repoNames,
    scope: "workspace",
    pid: process.pid,
  });

  const bridges = new Map(
    repoNames.map((name) => [name, createPipelineEventBridge(name)]),
  );
  const results = new Map<string, { hasLockfile: boolean }>();
  let anyFailed = false;
  let cancelRequested = false;

  const updates = runParallel(pipelines, {
    ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
  })[Symbol.asyncIterator]();

  const runDriver = async (): Promise<void> => {
    try {
      while (true) {
        const next = await updates.next();
        if (next.done) break;
        const { id, state } = next.value;
        for (const body of bridges.get(id)?.convert(state) ?? []) {
          push(body);
        }
        switch (state.phase) {
          case "worktree-ready":
          case "complete":
            results.set(id, { hasLockfile: state.hasLockfile });
            break;
          case "failed":
            anyFailed = true;
            await onFailure?.(id, state);
            break;
          default:
            break;
        }
        if (cancelRequested) {
          await updates.return?.(undefined);
          break;
        }
      }
      await onBeforeCompletionPrompt?.(results);
      push({
        kind: "run-end",
        outcome: cancelRequested ? "cancelled" : anyFailed ? "failed" : "ready",
        durationMs: Date.now() - startedAt,
      });
    } finally {
      closed = true;
      wake?.();
      wake = null;
    }
  };
  const driver = runDriver();

  try {
    await renderSetupGrid({
      events,
      repoNames,
      mode: "until-ready",
      canDetach: false,
      ...(workspacePath !== undefined ? { targetDir: workspacePath } : {}),
      onCancelRequest: async () => {
        cancelRequested = true;
        wake?.();
        wake = null;
        await terminateRunningCommands();
      },
      ...(environment ? { environment } : {}),
    });
  } finally {
    cancelRequested = true;
    await driver.catch(() => undefined);
  }

  return results;
}
