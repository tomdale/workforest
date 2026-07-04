import { normalizeControlText } from "../../terminal/command-stream-adapter.ts";
import {
  literalSpan,
  renderTerminalDocInline,
  type TerminalLine,
  terminalSpan,
} from "../../terminal/render-model.ts";
import { terminalSymbol } from "../../terminal/theme.ts";
import type { RunEvent, RunManifest, StepId } from "./events.ts";

export type RenderRunLogFilter = {
  repo?: string;
  step?: StepId;
};

type RenderedStep = {
  step: StepId;
  title: string;
  lines: string[];
  outcome?: { symbol: string; role: "success" | "error" | "muted" };
  durationMs?: number;
  error?: string;
};

type RenderedTarget = {
  label: string;
  steps: Map<StepId, RenderedStep>;
  outcome?: string;
};

/**
 * Render a run's merged event stream as a static report: one section per
 * repo, one block per step with duration, retries, and captured output.
 */
export function renderRunLog(
  events: readonly RunEvent[],
  manifest: RunManifest | null,
  filter: RenderRunLogFilter = {},
): string {
  const targets = new Map<string, RenderedTarget>();
  let outcomeLine: string | null = null;

  const targetFor = (repo: string | null): RenderedTarget => {
    const label = repo ?? "workspace";
    const existing = targets.get(label);
    if (existing) return existing;
    const created: RenderedTarget = { label, steps: new Map() };
    targets.set(label, created);
    return created;
  };

  for (const event of events) {
    if (!("repo" in event)) {
      if (event.kind === "run-end") {
        outcomeLine = `${event.outcome} in ${formatDuration(event.durationMs)}`;
      }
      continue;
    }
    if (filter.repo !== undefined && event.repo !== filter.repo) continue;
    if (
      filter.step !== undefined &&
      "step" in event &&
      event.step !== filter.step
    ) {
      continue;
    }

    switch (event.kind) {
      case "step-start": {
        targetFor(event.repo).steps.set(event.step, {
          step: event.step,
          title: event.title,
          lines: [],
        });
        break;
      }
      case "step-output": {
        const step = targetFor(event.repo).steps.get(event.step);
        if (!step) break;
        for (const line of normalizeOutputLines(event.chunk)) {
          step.lines.push(line);
        }
        break;
      }
      case "step-log": {
        const step = targetFor(event.repo).steps.get(event.step);
        step?.lines.push(
          event.level === "warn" || event.level === "error"
            ? `[${event.level}] ${event.message}`
            : event.message,
        );
        break;
      }
      case "step-retry": {
        const step = targetFor(event.repo).steps.get(event.step);
        step?.lines.push(`[retry ${event.attempt}] ${event.reason}`);
        break;
      }
      case "step-end": {
        const target = targetFor(event.repo);
        const step = target.steps.get(event.step) ?? {
          step: event.step,
          title: event.step,
          lines: [],
        };
        target.steps.set(event.step, step);
        step.durationMs = event.durationMs;
        step.outcome =
          event.outcome === "ok"
            ? { symbol: terminalSymbol.statusComplete, role: "success" }
            : event.outcome === "failed"
              ? { symbol: terminalSymbol.statusFailed, role: "error" }
              : { symbol: terminalSymbol.statusCancelled, role: "muted" };
        if (event.error) step.error = event.error.message;
        if (event.reason) step.lines.push(`Skipped: ${event.reason}`);
        break;
      }
      case "repo-end": {
        if (event.repo === null) break;
        const target = targetFor(event.repo);
        target.outcome = event.outcome;
        break;
      }
      default:
        break;
    }
  }

  const lines: TerminalLine[] = [];
  if (manifest) {
    const meta = [
      manifest.command,
      `${manifest.repos.length} ${manifest.repos.length === 1 ? "repo" : "repos"}`,
      formatStartedAt(manifest.startedAt),
      ...(outcomeLine ? [outcomeLine] : []),
    ];
    lines.push({
      spans: [
        terminalSpan(`Run ${manifest.runId}`, {
          role: "primary",
          emphasis: "bold",
        }),
        literalSpan("   "),
        terminalSpan(meta.join(" · "), { role: "muted" }),
      ],
    });
    lines.push({ spans: [] });
  }

  if (targets.size === 0) {
    lines.push({
      spans: [
        terminalSpan("No matching events in this run.", { role: "muted" }),
      ],
    });
    return renderTerminalDocInline({ lines });
  }

  let first = true;
  for (const target of targets.values()) {
    if (target.steps.size === 0) continue;
    if (!first) lines.push({ spans: [] });
    first = false;

    lines.push({
      spans: [
        terminalSpan(target.label, { emphasis: "bold" }),
        ...(target.outcome
          ? [
              literalSpan("  "),
              terminalSpan(
                target.outcome,
                target.outcome === "ready"
                  ? { role: "success" }
                  : target.outcome === "failed"
                    ? { role: "error" }
                    : { role: "muted" },
              ),
            ]
          : []),
      ],
    });

    for (const step of target.steps.values()) {
      const outcome = step.outcome ?? {
        symbol: terminalSymbol.statusRunning,
        role: "muted" as const,
      };
      lines.push({
        spans: [
          literalSpan("  "),
          terminalSpan(`${outcome.symbol} `, { role: outcome.role }),
          terminalSpan(step.title, {}),
          ...(step.durationMs !== undefined
            ? [
                literalSpan(" "),
                terminalSpan(formatDuration(step.durationMs), {
                  role: "muted",
                }),
              ]
            : []),
        ],
      });
      for (const line of step.lines) {
        lines.push({
          spans: [literalSpan("      "), terminalSpan(line, { role: "dim" })],
        });
      }
      if (step.error) {
        lines.push({
          spans: [
            literalSpan("      "),
            terminalSpan(`Error: ${step.error}`, { role: "error" }),
          ],
        });
      }
    }
  }

  return renderTerminalDocInline({ lines });
}

/** One line per run for `wf init logs --list`. */
export function renderRunList(
  runs: readonly { manifest: RunManifest; outcome?: string }[],
): string {
  if (runs.length === 0) {
    return renderTerminalDocInline({
      lines: [
        {
          spans: [
            terminalSpan("No recorded setup runs for this selector.", {
              role: "muted",
            }),
          ],
        },
      ],
    });
  }

  const lines: TerminalLine[] = runs.map(({ manifest, outcome }) => ({
    spans: [
      terminalSpan(manifest.runId, { emphasis: "bold" }),
      literalSpan("  "),
      terminalSpan(
        [
          manifest.command,
          `${manifest.repos.length} ${manifest.repos.length === 1 ? "repo" : "repos"}`,
          formatStartedAt(manifest.startedAt),
        ].join(" · "),
        { role: "muted" },
      ),
      literalSpan("  "),
      terminalSpan(
        outcome ?? "incomplete",
        outcome === "ready"
          ? { role: "success" }
          : outcome === "failed"
            ? { role: "error" }
            : { role: "muted" },
      ),
    ],
  }));

  return renderTerminalDocInline({ lines });
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}:${String(rest).padStart(2, "0")}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function formatStartedAt(startedAt: string): string {
  const ms = Date.parse(startedAt);
  if (!Number.isFinite(ms)) return startedAt;
  return new Date(ms).toLocaleString();
}

function normalizeOutputLines(chunk: string): string[] {
  const lines: string[] = [];
  let current = "";
  for (const char of normalizeControlText(chunk)) {
    if (char === "\r") {
      current = "";
      continue;
    }
    if (char === "\n") {
      if (current) lines.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) lines.push(current);
  return lines;
}
