import type {
  ActivityInput,
  ActivityStatus,
  ActivityView,
  SweepSummary,
} from "../activity/index.ts";
import { loadWorkspaceConfig } from "../config.ts";
import { type ReportEntry, renderReport } from "../terminal/report.ts";
import type { WorkspaceConfig } from "../types.ts";
import { OperationalError, UsageError } from "./errors.ts";
import { humanOutput, jsonSuccess, reportOutput, success } from "./output.ts";
import type { CommandResult, ParsedInvocation } from "./types.ts";

const DEFAULT_WATCH_INTERVAL_SECONDS = 60;

export async function runActivityCommand(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  const { config } = await loadWorkspaceConfig();
  const activity = await import("../activity/index.ts");
  const json = invocation.flags["json"] === true;
  const handler = invocation.command.leaf.handler;

  switch (handler) {
    case "activity.list": {
      const repo = stringFlag(invocation, "repo");
      const group = stringFlag(invocation, "group");
      const views = await activity.readActivityViews(config, {
        ...(repo ? { repo } : {}),
        ...(group ? { group } : {}),
      });
      return json
        ? jsonSuccess(views)
        : success(reportOutput(renderActivityList(views)));
    }
    case "activity.show": {
      const target = await resolveTarget(config, invocation);
      const view = await activity.readActivityView(target);
      return json
        ? jsonSuccess(view)
        : success(reportOutput(renderActivityView(view)));
    }
    case "activity.refresh": {
      const target = await resolveTarget(config, invocation);
      const outcome = await activity.generateForTarget(
        target,
        activity.defaultEngineOptions(config),
        invocation.flags["force"] === true ? "force" : "refresh",
      );
      const view = await activity.readActivityView(target);
      if (outcome.result === "failed") {
        throw new OperationalError(
          `Activity digest generation failed for ${view.selector}: ${outcome.reason ?? "unknown error"}\nThe previous digest was kept.`,
        );
      }
      const note =
        outcome.result === "skipped"
          ? `Not regenerated (${outcome.reason ?? "skipped"}).`
          : null;
      return json
        ? jsonSuccess({
            result: outcome.result,
            reason: outcome.reason ?? null,
            activity: view,
          })
        : success(reportOutput(renderActivityView(view, note)));
    }
    case "activity.sweep": {
      const targets = await activity.collectActivityTargets(config);
      const summary = await activity.runSweep(targets, {
        ...activity.defaultEngineOptions(config),
        prune: true,
      });
      return json
        ? jsonSuccess(summary)
        : success(reportOutput(renderSweep(summary)));
    }
    case "activity.watch":
      return runWatch(config, invocation);
    case "activity.status": {
      const status = await activity.readActivityStatus(config);
      return json
        ? jsonSuccess(status)
        : success(reportOutput(renderStatus(status)));
    }
    case "activity.purpose":
    case "activity.pin":
    case "activity.note": {
      const input = activityInput(invocation);
      const target = await resolveTarget(config, invocation);
      const view = await activity.recordActivityInput(target, input);
      return json
        ? jsonSuccess(view)
        : success(reportOutput(renderActivityView(view)));
    }
    default:
      throw new OperationalError(`Unknown activity command: ${handler}`);
  }
}

function activityInput(invocation: ParsedInvocation): ActivityInput {
  switch (invocation.command.leaf.handler) {
    case "activity.purpose": {
      const set = stringFlag(invocation, "set");
      const clear = invocation.flags["clear"] === true;
      if ((set === undefined) === !clear) {
        throw new UsageError(
          'Pass exactly one of "--set <text>" or "--clear".',
        );
      }
      return { kind: "purpose", purpose: clear ? null : (set ?? null) };
    }
    case "activity.pin":
      return { kind: "pin", pinned: invocation.flags["off"] !== true };
    default: {
      const summary = stringFlag(invocation, "summary") ?? null;
      const next = stringFlag(invocation, "next") ?? null;
      if (!summary?.trim() && !next?.trim()) {
        throw new UsageError(
          'Pass "--summary <text>", "--next <text>", or both.',
        );
      }
      return {
        kind: "note",
        source: stringFlag(invocation, "source") ?? "manual",
        summary,
        next,
      };
    }
  }
}

async function resolveTarget(
  config: WorkspaceConfig,
  invocation: ParsedInvocation,
) {
  const { resolveSelector } = await import("../workspace/selectors.ts");
  const { activityTargetForEntry } = await import("../activity/index.ts");
  const resolution = await resolveSelector(
    config,
    invocation.beforeDoubleDash[0],
  );
  switch (resolution.kind) {
    case "outside":
      throw new OperationalError(
        "Not in a Workforest worktree or workspace.\nPass a selector, or run: wf activity list",
      );
    case "missing":
      throw new UsageError(`Unknown selector: ${resolution.selector}`);
    case "ambiguous":
      throw new UsageError(
        [
          `Ambiguous selector "${resolution.selector}".`,
          "Matches:",
          ...resolution.matches.map((match) => `  ${match}`),
          resolution.hint ?? "Use <group>/<name>.",
        ].join("\n"),
      );
  }
  const target = await activityTargetForEntry(resolution.entry);
  if (!target) {
    throw new OperationalError(
      `Metadata for ${resolution.entry.selector} could not be read.`,
    );
  }
  return target;
}

async function runWatch(
  config: WorkspaceConfig,
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  const rawInterval = stringFlag(invocation, "interval");
  const seconds =
    rawInterval === undefined
      ? DEFAULT_WATCH_INTERVAL_SECONDS
      : Number(rawInterval);
  if (!Number.isFinite(seconds) || seconds < 5) {
    throw new UsageError(
      '"--interval" must be a number of seconds, at least 5.',
    );
  }
  const activity = await import("../activity/index.ts");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const engine = activity.defaultEngineOptions(config, controller.signal);
    process.stderr.write(
      `Activity service running (every ${seconds}s, inference ${engine.inferenceEnabled ? "enabled" : "disabled"}). Press Ctrl-C to stop.\n`,
    );
    const result = await activity.runService({
      root: engine.root,
      intervalMs: seconds * 1000,
      collectTargets: () => activity.collectActivityTargets(config),
      engine,
      onSweep: (summary) => {
        process.stderr.write(`${formatSweepLine(summary)}\n`);
      },
    });
    if (result === "already-running") {
      throw new OperationalError(
        "Another activity service is already running. Inspect it with: wf activity status",
      );
    }
    return success(humanOutput("Activity service stopped."));
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

function stringFlag(
  invocation: ParsedInvocation,
  name: string,
): string | undefined {
  const value = invocation.flags[name];
  return typeof value === "string" ? value : undefined;
}

function renderActivityList(views: readonly ActivityView[]): string {
  if (views.length === 0) {
    return renderReport({
      title: "Activity",
      sections: [{ note: "No worktrees or workspaces found." }],
    });
  }
  const sorted = [...views].sort(
    (left, right) =>
      Date.parse(right.lastActivityAt ?? "0") -
      Date.parse(left.lastActivityAt ?? "0"),
  );
  return renderReport({
    title: "Activity",
    sections: [{ entries: sorted.map(activityEntry) }],
    footer:
      "Digests describe the last observation, not live disk state. Refresh one with: wf activity refresh <selector>",
  });
}

function activityEntry(view: ActivityView): ReportEntry {
  return {
    title: view.selector,
    tone:
      view.freshness === "current"
        ? "success"
        : view.generationState === "failed"
          ? "error"
          : "pending",
    description: stateLabel(view),
    details: digestFields(view),
  };
}

function renderActivityView(
  view: ActivityView,
  note: string | null = null,
): string {
  return renderReport({
    title: view.selector,
    sections: [
      ...(note ? [{ note }] : []),
      {
        fields: [
          { label: "State", value: stateLabel(view) },
          ...digestFields(view),
          {
            label: "Last activity",
            value: view.lastActivityAt ?? "(never observed)",
          },
          { label: "Last checked", value: view.lastCheckedAt ?? "(never)" },
          {
            label: "Observed through",
            value: view.observedThrough ?? "(none)",
          },
          { label: "Generated", value: view.generatedAt ?? "(never)" },
          ...(view.evidence.length > 0
            ? [{ label: "Evidence", value: view.evidence.join(", ") }]
            : []),
          ...(view.lastError
            ? [{ label: "Last error", value: view.lastError }]
            : []),
          { label: "Path", value: view.path },
        ],
      },
    ],
  });
}

function digestFields(view: ActivityView) {
  const purpose = view.purpose
    ? `${view.purpose}${view.purposeSource === "user" ? "" : " (inferred)"}`
    : "(unknown)";
  const next = view.likelyNext
    ? `${view.likelyNext}${view.likelyNextBasis === "inferred" ? " (inferred)" : view.likelyNextBasis === "handoff" ? " (handoff)" : ""}`
    : "(unknown)";
  return [
    { label: "Purpose", value: purpose },
    { label: "Latest", value: view.latest ?? "(no digest yet)" },
    { label: "Next", value: next },
  ];
}

function stateLabel(view: ActivityView): string {
  const parts: string[] = [view.freshness];
  if (view.generationState !== "idle") parts.push(view.generationState);
  parts.push(view.active ? "active" : "inactive");
  if (view.pinned) parts.push("pinned");
  if (view.insufficientContext) parts.push("insufficient context");
  return parts.join(", ");
}

function renderSweep(summary: SweepSummary): string {
  return renderReport({
    title: "Activity sweep",
    sections: [
      {
        fields: summary.skippedReason
          ? [{ label: "Skipped", value: "another sweep is already running" }]
          : [
              { label: "Targets", value: String(summary.targets) },
              { label: "Checked", value: String(summary.checked) },
              { label: "Changed", value: String(summary.changed) },
              { label: "Generated", value: String(summary.generated) },
              { label: "Queued", value: String(summary.queued) },
              { label: "Failed", value: String(summary.failed) },
              { label: "Pruned", value: String(summary.pruned) },
            ],
      },
    ],
  });
}

function formatSweepLine(summary: SweepSummary): string {
  if (summary.skippedReason)
    return `${summary.finishedAt} sweep skipped (already running)`;
  return `${summary.finishedAt} checked ${summary.checked}/${summary.targets}, changed ${summary.changed}, generated ${summary.generated}, queued ${summary.queued}, failed ${summary.failed}`;
}

function renderStatus(status: ActivityStatus): string {
  const service = status.service;
  return renderReport({
    title: "Activity service",
    sections: [
      {
        fields: [
          {
            label: "Service",
            value: service.running
              ? `running (pid ${service.state?.pid}, every ${Math.round((service.state?.intervalMs ?? 0) / 1000)}s)`
              : "not running (start with: wf activity watch)",
          },
          { label: "Heartbeat", value: service.state?.heartbeatAt ?? "(none)" },
          {
            label: "Last sweep",
            value: service.lastSweep?.finishedAt ?? "(none)",
          },
          { label: "Inference", value: status.inference },
          { label: "Store", value: status.root },
        ],
      },
      {
        title: "Digests",
        fields: Object.entries(status.counts).map(([label, value]) => ({
          label: label[0]?.toUpperCase() + label.slice(1),
          value: String(value),
        })),
      },
    ],
  });
}
