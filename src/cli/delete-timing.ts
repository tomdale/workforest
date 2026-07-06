import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { getTimingFilePath } from "../config.ts";
import type { CleanupState } from "../workspace/cleanup.ts";

type DeleteTimingPhaseName =
  | "review-resolution"
  | "selector-resolution"
  | "repository-safety"
  | "task-checks"
  | "cleanup-dispatch";

type DeleteTimingPhase = Readonly<{
  name: DeleteTimingPhaseName;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  status: "ok" | "error";
  error?: string;
}>;

type DeleteTimingCleanupState = Readonly<{
  atMs: number;
  state: JsonCleanupState;
}>;

type JsonCleanupState =
  | { phase: "init"; message: string }
  | {
      phase: "node-modules";
      repo: string;
      path: string;
      status: "preserving" | "preserved" | "skipped" | "warning";
      reason?: "disabled" | "missing" | "ineligible";
      message?: string;
    }
  | { phase: "worktree"; repo: string; state: JsonTaskState }
  | { phase: "worktree-complete"; repo: string }
  | {
      phase: "remote-branch";
      repo: string;
      branch: string;
      status: "checking" | "deleting" | "deleted" | "skipped" | "failed";
      reason?: string;
    }
  | { phase: "remove-dir"; message: string }
  | {
      phase: "complete";
      removedRepos: readonly string[];
      deletedBranches?: readonly string[];
    };

type JsonTaskState =
  | { status: "pending" }
  | { status: "running"; message?: string }
  | { status: "output"; data: string }
  | { status: "retrying"; reason: string; attempt: number }
  | { status: "completed" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string }
  | { status: "log"; level: "info" | "warn" | "error"; message: string };

type DeleteTimingReport = Readonly<{
  kind: "workforest.delete.timing";
  version: 1;
  startedAt: string;
  endedAt: string;
  totalMs: number;
  phases: readonly DeleteTimingPhase[];
  cleanupStates: readonly DeleteTimingCleanupState[];
}>;

export type DeleteTimingRecorder = Readonly<{
  time<T>(name: DeleteTimingPhaseName, action: () => Promise<T>): Promise<T>;
  recordCleanupState(state: CleanupState): void;
  flush(): Promise<void>;
}>;

export function createDeleteTimingRecorder(
  timingFilePath = getTimingFilePath(),
): DeleteTimingRecorder {
  const startedAtDate = new Date();
  const startedAt = performance.now();
  const phases: DeleteTimingPhase[] = [];
  const cleanupStates: DeleteTimingCleanupState[] = [];

  const elapsed = () => performance.now() - startedAt;

  return {
    async time(name, action) {
      const phaseStartedAt = elapsed();
      try {
        const result = await action();
        const phaseEndedAt = elapsed();
        phases.push({
          name,
          startedAtMs: roundMs(phaseStartedAt),
          endedAtMs: roundMs(phaseEndedAt),
          durationMs: roundMs(phaseEndedAt - phaseStartedAt),
          status: "ok",
        });
        return result;
      } catch (error) {
        const phaseEndedAt = elapsed();
        phases.push({
          name,
          startedAtMs: roundMs(phaseStartedAt),
          endedAtMs: roundMs(phaseEndedAt),
          durationMs: roundMs(phaseEndedAt - phaseStartedAt),
          status: "error",
          error: errorMessage(error),
        });
        throw error;
      }
    },
    recordCleanupState(state) {
      cleanupStates.push({
        atMs: roundMs(elapsed()),
        state: cleanupStateToJson(state),
      });
    },
    async flush() {
      if (!timingFilePath) {
        return;
      }

      const endedAtDate = new Date();
      const report: DeleteTimingReport = {
        kind: "workforest.delete.timing",
        version: 1,
        startedAt: startedAtDate.toISOString(),
        endedAt: endedAtDate.toISOString(),
        totalMs: roundMs(performance.now() - startedAt),
        phases,
        cleanupStates,
      };

      try {
        await fs.mkdir(path.dirname(timingFilePath), { recursive: true });
        await fs.writeFile(
          timingFilePath,
          `${JSON.stringify(report, null, 2)}\n`,
          "utf8",
        );
      } catch {
        // Timing is internal instrumentation; delete behavior must not depend on it.
      }
    },
  };
}

function cleanupStateToJson(state: CleanupState): JsonCleanupState {
  switch (state.phase) {
    case "init":
    case "node-modules":
    case "remove-dir":
    case "worktree-complete":
      return state;
    case "remote-branch":
      return {
        phase: state.phase,
        repo: state.repo,
        branch: state.branch,
        status: state.status,
        ...(state.reason ? { reason: state.reason } : {}),
      };
    case "complete":
      return {
        phase: state.phase,
        removedRepos: state.removedRepos,
        ...(state.deletedBranches
          ? { deletedBranches: state.deletedBranches }
          : {}),
      };
    case "worktree":
      return {
        phase: state.phase,
        repo: state.repo,
        state: taskStateToJson(state.state),
      };
  }
}

function taskStateToJson(
  state: Extract<CleanupState, { phase: "worktree" }>["state"],
): JsonTaskState {
  switch (state.status) {
    case "failed":
      return { status: state.status, error: state.error.message };
    case "skipped":
      return {
        status: state.status,
        reason: state.reason,
      };
    case "running":
      return {
        status: state.status,
        ...(state.message ? { message: state.message } : {}),
      };
    case "output":
      return { status: state.status, data: state.data };
    case "log":
      return {
        status: state.status,
        level: state.level,
        message: state.message,
      };
    case "retrying":
      return {
        status: state.status,
        reason: state.reason,
        attempt: state.attempt,
      };
    case "pending":
    case "completed":
      return { status: state.status };
  }
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
