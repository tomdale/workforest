/**
 * The persistent scrollback summary printed to real stdout after the alt
 * screen tears down. Every grid exit path (success, failure, detach, cancel)
 * routes through {@link printRunSummary} so nothing the user needs survives
 * only on the vanished alternate screen.
 */

import {
  literalSpan,
  renderTerminalDocInline,
  type TerminalLine,
  terminalSpan,
} from "../../terminal/render-model.ts";
import { terminalSymbol } from "../../terminal/theme.ts";
import { compactHome } from "../../utils/display-path.ts";
import type {
  RepoRunSnapshot,
  RunSnapshot,
} from "../../workspace/run-log/reducer.ts";
import { formatElapsed, WORKSPACE_PANE_NAME } from "./model.ts";

export type RunSummaryOutcome = "ready" | "failed" | "cancelled" | "detached";

export type RunSummaryInput = Readonly<{
  snapshot: RunSnapshot;
  targetDir: string;
  outcome: RunSummaryOutcome;
  /** Pane order; defaults to the snapshot's repo order. */
  repoNames?: readonly string[];
  nextSteps?: readonly string[];
  nowMs?: number;
}>;

function repoDurationMs(repo: RepoRunSnapshot, nowMs: number): number | null {
  let total = 0;
  let seen = false;
  for (const step of repo.steps) {
    if (step.durationMs !== undefined) {
      total += step.durationMs;
      seen = true;
    } else if (
      (step.status === "running" || step.status === "retrying") &&
      step.startedAtMs !== undefined
    ) {
      total += Math.max(nowMs - step.startedAtMs, 0);
      seen = true;
    }
  }
  return seen ? total : null;
}

function repoOutcomeLabel(repo: RepoRunSnapshot): {
  label: string;
  glyph: string;
  role: "success" | "error" | "warning" | "muted";
} {
  switch (repo.status) {
    case "ready":
      return {
        label: "ready",
        glyph: terminalSymbol.statusComplete,
        role: "success",
      };
    case "failed":
      return {
        label: "failed",
        glyph: terminalSymbol.statusFailed,
        role: "error",
      };
    case "cancelled":
      return {
        label: "cancelled",
        glyph: terminalSymbol.statusCancelled,
        role: "warning",
      };
    case "handed-off":
      return {
        label: "initializing",
        glyph: terminalSymbol.statusRunning,
        role: "muted",
      };
    case "running":
      return {
        label: "running",
        glyph: terminalSymbol.statusRunning,
        role: "muted",
      };
    case "pending":
      return {
        label: "queued",
        glyph: terminalSymbol.statusPending,
        role: "muted",
      };
  }
}

function summaryHeading(input: RunSummaryInput, nowMs: number): TerminalLine {
  const { snapshot, outcome } = input;
  const elapsed =
    snapshot.durationMs ??
    (snapshot.startedAtMs !== undefined
      ? nowMs - snapshot.startedAtMs
      : undefined);
  const suffix = elapsed !== undefined ? ` in ${formatElapsed(elapsed)}` : "";
  switch (outcome) {
    case "ready":
      return {
        spans: [
          terminalSpan(`Setup complete${suffix}`, {
            role: "success",
            emphasis: "bold",
          }),
        ],
      };
    case "failed":
      return {
        spans: [
          terminalSpan(`Setup failed${suffix}`, {
            role: "error",
            emphasis: "bold",
          }),
        ],
      };
    case "cancelled":
      return {
        spans: [
          terminalSpan(`Setup cancelled${suffix}`, {
            role: "warning",
            emphasis: "bold",
          }),
        ],
      };
    case "detached":
      return {
        spans: [
          terminalSpan("Setup continues in the background", {
            emphasis: "bold",
          }),
        ],
      };
  }
}

/**
 * Format the end-of-run summary: target path, a per-repo outcome and timing
 * table, failure details with `wf init logs` pointers, and next steps.
 */
export function formatRunSummary(input: RunSummaryInput): string {
  const nowMs = input.nowMs ?? Date.now();
  const { snapshot, targetDir, outcome } = input;
  const repoNames =
    input.repoNames ??
    [...snapshot.repos.keys()].filter((name) => name !== WORKSPACE_PANE_NAME);

  const lines: TerminalLine[] = [];
  lines.push(summaryHeading(input, nowMs));
  lines.push({
    spans: [
      literalSpan("  "),
      terminalSpan(compactHome(targetDir), { role: "primary" }),
    ],
  });
  lines.push({ spans: [] });

  const nameWidth = Math.max(...repoNames.map((name) => name.length), 4);
  // When every repo landed ready the glyph already says so; a column of
  // identical "ready" labels is noise. Mixed outcomes keep the label column.
  const allReady = repoNames.every(
    (name) => snapshot.repos.get(name)?.status === "ready",
  );
  const failures: RepoRunSnapshot[] = [];
  for (const name of repoNames) {
    const repo = snapshot.repos.get(name);
    if (!repo) continue;
    const { label, glyph, role } = repoOutcomeLabel(repo);
    const duration = repoDurationMs(repo, nowMs);
    if (repo.status === "failed") failures.push(repo);
    lines.push({
      spans: [
        literalSpan("  "),
        terminalSpan(`${glyph} `, { role }),
        terminalSpan(name.padEnd(nameWidth + 2), {}),
        ...(allReady ? [] : [terminalSpan(label.padEnd(13), { role })]),
        ...(duration !== null
          ? [terminalSpan(formatElapsed(duration), { role: "muted" })]
          : []),
      ],
    });
  }

  const failedWorkspaceSteps = snapshot.workspaceSteps.filter(
    (step) => step.status === "failed",
  );
  if (failures.length > 0 || failedWorkspaceSteps.length > 0) {
    lines.push({ spans: [] });
    lines.push({
      spans: [
        literalSpan("  "),
        terminalSpan("Failures", { role: "error", emphasis: "bold" }),
      ],
    });
    for (const repo of failures) {
      const step = repo.failedStep ? ` (${repo.failedStep})` : "";
      lines.push({
        spans: [
          literalSpan("    "),
          terminalSpan(
            `${repo.repo}${step}: ${repo.error ?? "setup failed"}`,
            {},
          ),
        ],
      });
      lines.push({
        spans: [
          literalSpan("      "),
          terminalSpan(`wf init logs --repo ${repo.repo}`, { role: "dim" }),
        ],
      });
    }
    for (const step of failedWorkspaceSteps) {
      lines.push({
        spans: [
          literalSpan("    "),
          terminalSpan(
            `workspace ${step.title}: ${step.lastMessage ?? "failed"}`,
            {},
          ),
        ],
      });
      lines.push({
        spans: [
          literalSpan("      "),
          terminalSpan("wf init logs", { role: "dim" }),
        ],
      });
    }
  }

  if (outcome === "detached") {
    lines.push({ spans: [] });
    lines.push({
      spans: [
        literalSpan("  "),
        terminalSpan(
          "Initialization continues in the background. Run wf status --watch to follow it.",
          { role: "muted" },
        ),
      ],
    });
  }

  if (input.nextSteps && input.nextSteps.length > 0) {
    lines.push({ spans: [] });
    lines.push({
      spans: [
        literalSpan("  "),
        terminalSpan("Next steps", { emphasis: "bold" }),
      ],
    });
    for (const step of input.nextSteps) {
      lines.push({
        spans: [literalSpan("    "), terminalSpan(step, { role: "dim" })],
      });
    }
  }

  return renderTerminalDocInline({ lines });
}

/** Print the run summary to stdout (injectable for tests). */
export function printRunSummary(
  input: RunSummaryInput,
  write: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
): void {
  write(`${formatRunSummary(input)}\n`);
}
