import { pathExists } from "@wf-plugin/core";
import { loadWorkspaceConfig } from "../config.ts";
import { emitServiceEvent, type ServiceEventSink } from "../services/events.ts";
import { presentPipelines } from "../ui/grid-consumer.ts";
import {
  cancelRepoInitializations,
  readRepoInitializationStates,
  retryRepoInitializations,
  watchRepoInitialization,
} from "../workspace/initialization.ts";
import {
  getInitializationRepoDir,
  type InitializationScope,
} from "../workspace/initialization-scope.ts";
import type { RepoPipelineState } from "../workspace/pipeline.ts";
import { readRunEvents } from "../workspace/run-log/reader.ts";
import { renderRunList, renderRunLog } from "../workspace/run-log/render.ts";
import { createRunSession } from "../workspace/run-log/session.ts";
import {
  getRunDir,
  listRuns,
  readRunManifest,
  resolveRunDir,
} from "../workspace/run-log/store.ts";
import { resolveSelector } from "../workspace/selectors.ts";
import { initializationScope } from "../workspace/status.ts";
import { OperationalError, UsageError } from "./errors.ts";
import { jsonSuccess, reportOutput, success } from "./output.ts";
import type { CommandResult, ParsedInvocation } from "./types.ts";

export type InitCommandDependencies = {
  interactive: boolean;
  onEvent: ServiceEventSink;
};

export async function runInitInvocation(
  invocation: ParsedInvocation,
  deps: InitCommandDependencies,
): Promise<CommandResult> {
  switch (invocation.command.leaf.handler) {
    case "init.logs":
      return runInitLogs(invocation);
    case "init.retry":
      return runInitRetry(invocation, deps);
    case "init.cancel":
      return runInitCancel(invocation, deps);
  }
  throw new Error(
    `No init handler registered for ${invocation.command.leaf.handler}.`,
  );
}

async function runInitLogs(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  const scope = await resolveScope(invocation.beforeDoubleDash[0]);
  const json = invocation.flags["json"] === true;

  if (invocation.flags["list"] === true) {
    const runs = await listRuns(scope);
    const withOutcomes = await Promise.all(
      runs.map(async (manifest) => {
        const events = await readRunEvents(getRunDir(scope, manifest.runId));
        const runEnd = events
          .filter((event) => event.kind === "run-end")
          .at(-1);
        return {
          manifest,
          ...(runEnd?.kind === "run-end" ? { outcome: runEnd.outcome } : {}),
        };
      }),
    );
    if (json) return jsonSuccess({ runs: withOutcomes });
    return success(reportOutput(renderRunList(withOutcomes)));
  }

  const selector = flagString(invocation, "run") ?? "last";
  const runDir = await resolveRunDir(scope, selector);
  if (!runDir) {
    throw new OperationalError(
      selector === "last"
        ? "No setup runs are recorded here yet. Runs are recorded by wf new and wf init retry."
        : `No setup run matches "${selector}". List runs with: wf init logs --list`,
    );
  }
  const manifest = await readRunManifest(runDir);
  const repoFilter = flagString(invocation, "repo");
  const stepFilter = flagString(invocation, "step");
  const filter = {
    ...(repoFilter !== undefined ? { repo: repoFilter } : {}),
    ...(stepFilter !== undefined ? { step: stepFilter } : {}),
  };

  if (invocation.flags["follow"] === true) {
    if (json) {
      throw new UsageError('Flag "--follow" cannot be combined with "--json".');
    }
    const { followRunEvents } = await import("../workspace/run-log/reader.ts");
    for await (const event of followRunEvents(runDir, { fromStart: true })) {
      if (filter.repo !== undefined && "repo" in event) {
        if (event.repo !== filter.repo && event.repo !== null) continue;
      }
      const line = formatFollowLine(event);
      if (line) process.stdout.write(`${line}\n`);
    }
    return success();
  }

  const events = await readRunEvents(runDir);
  if (json) {
    return jsonSuccess({ runId: manifest?.runId ?? null, events });
  }
  return success(reportOutput(renderRunLog(events, manifest, filter)));
}

async function runInitRetry(
  invocation: ParsedInvocation,
  deps: InitCommandDependencies,
): Promise<CommandResult> {
  const scope = await resolveScope(invocation.beforeDoubleDash[0]);
  const states = await readRepoInitializationStates(scope);
  const only = flagString(invocation, "repo");
  const retryable = states.filter(
    (state) => state.status === "failed" || state.status === "cancelled",
  );
  const targets = only
    ? retryable.filter((state) => state.repo === only)
    : retryable;

  if (targets.length === 0) {
    throw new OperationalError(
      only
        ? `Repository "${only}" has no failed or cancelled initialization to retry.`
        : "No failed or cancelled repositories to retry.",
    );
  }

  // Retry relaunches the background initializer, which needs a checkout to
  // work in. Git-phase failures never created one; resuming wf new is the
  // path that re-runs the git steps.
  const missingWorktrees: string[] = [];
  for (const state of targets) {
    const repoDir = getInitializationRepoDir(scope, state.repo);
    if (state.step?.startsWith("git:") || !(await pathExists(repoDir))) {
      missingWorktrees.push(state.repo);
    }
  }
  if (missingWorktrees.length > 0) {
    throw new OperationalError(
      [
        `Setup failed before a worktree existed for: ${missingWorktrees.join(", ")}.`,
        "Re-run wf new with the same name and repositories to resume setup;",
        "wf init retry only relaunches dependency initialization.",
      ].join("\n"),
    );
  }

  const session = await createRunSession({
    scope,
    command: "retry",
    repos: targets.map((state) => state.repo),
  });

  try {
    await retryRepoInitializations(
      scope,
      targets.map((state) => state.repo),
      undefined,
      { setupRunId: session.runId },
    );

    emitServiceEvent(deps.onEvent, {
      type: "message",
      level: "info",
      message: `Retrying ${targets.length} ${targets.length === 1 ? "repository" : "repositories"}.`,
    });

    const pipelines = new Map<string, AsyncGenerator<RepoPipelineState>>(
      targets.map((state) => [
        state.repo,
        watchRepoInitialization({ scope, repoName: state.repo }),
      ]),
    );
    await presentPipelines({
      pipelines,
      repoNames: targets.map((state) => state.repo),
      interactive: deps.interactive,
      onEvent: deps.onEvent,
      getLogPath: () => Promise.resolve(session.runDir),
    });
  } finally {
    await session.close().catch(() => undefined);
  }

  const after = await readRepoInitializationStates(scope);
  const failed = after.filter((state) => state.status === "failed");
  if (failed.length > 0) {
    throw new OperationalError(
      `${failed.length} ${failed.length === 1 ? "repository" : "repositories"} still failed: ${failed
        .map((state) => state.repo)
        .join(", ")}\nInspect with: wf init logs`,
    );
  }

  return success();
}

async function runInitCancel(
  invocation: ParsedInvocation,
  deps: InitCommandDependencies,
): Promise<CommandResult> {
  const scope = await resolveScope(invocation.beforeDoubleDash[0]);
  const states = await readRepoInitializationStates(scope);
  const only = flagString(invocation, "repo");
  const active = states.filter(
    (state) => state.status === "queued" || state.status === "running",
  );
  const targets = only ? active.filter((state) => state.repo === only) : active;

  if (targets.length === 0) {
    throw new OperationalError(
      only
        ? `Repository "${only}" has no queued or running initialization to cancel.`
        : "No queued or running repository initialization to cancel.",
    );
  }

  await cancelRepoInitializations(
    scope,
    targets.map((state) => state.repo),
  );
  emitServiceEvent(deps.onEvent, {
    type: "message",
    level: "success",
    message: `Cancelled initialization for ${targets
      .map((state) => state.repo)
      .join(", ")}.`,
  });
  return success();
}

async function resolveScope(
  selector: string | undefined,
): Promise<InitializationScope> {
  const { config } = await loadWorkspaceConfig();
  const resolution = await resolveSelector(config, selector);

  if (resolution.kind === "outside") {
    throw new OperationalError(
      [
        "Not in a Workforest worktree or workspace.",
        "Run: wf list",
        "Or pass a selector: wf init logs <group>/<name>",
      ].join("\n"),
    );
  }
  if (resolution.kind === "missing") {
    throw new UsageError(`Unknown selector: ${resolution.selector}`);
  }
  if (resolution.kind === "ambiguous") {
    throw new UsageError(
      [
        `Ambiguous selector "${resolution.selector}".`,
        "Matches:",
        ...resolution.matches.map((match) => `  ${match}`),
        resolution.hint ?? "Use <group>/<name>.",
      ].join("\n"),
    );
  }

  return initializationScope(resolution.entry);
}

function flagString(
  invocation: ParsedInvocation,
  name: string,
): string | undefined {
  const value = invocation.flags[name];
  return typeof value === "string" ? value : undefined;
}

function formatFollowLine(
  event: Awaited<ReturnType<typeof readRunEvents>>[number],
): string | null {
  switch (event.kind) {
    case "run-start":
      return `run ${event.runId} started (${event.command})`;
    case "step-start":
      return `${target(event.repo)}: ${event.title} started`;
    case "step-end":
      return `${target(event.repo)}: ${event.step} ${event.outcome}`;
    case "step-retry":
      return `${target(event.repo)}: retry ${event.attempt} (${event.reason})`;
    case "step-log":
      return event.level === "info"
        ? null
        : `${target(event.repo)}: [${event.level}] ${event.message}`;
    case "worktree-ready":
      return `${event.repo}: worktree ready`;
    case "repo-handoff":
      return `${event.repo}: initialization handed to background worker`;
    case "repo-end":
      return `${event.repo}: ${event.outcome}${event.error ? ` (${event.error.message})` : ""}`;
    case "run-end":
      return `run ${event.outcome}`;
    default:
      return null;
  }
}

function target(repo: string | null): string {
  return repo ?? "workspace";
}
