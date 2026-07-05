/**
 * Pure view models for the setup grid: pane content, pane labels, and the
 * status line are all derived from a {@link RunSnapshot} plus a timestamp, so
 * every rendering concern is vitest-testable without a TTY.
 */

import { truncateAnsi } from "../../terminal/ansi-text.ts";
import {
  renderTerminalLineBlessed,
  type TerminalLineInput,
  type TerminalStyleRole,
  terminalLine,
  terminalSpan,
} from "../../terminal/render-model.ts";
import { activeTheme } from "../../terminal/theme-system.ts";
import type {
  RepoRunSnapshot,
  RunSnapshot,
  StepSnapshot,
} from "../../workspace/run-log/reducer.ts";
import { formatDuration } from "../../workspace/run-log/render.ts";

/** The synthetic pane that shows workspace-scoped steps (hooks, AGENTS.md). */
export const WORKSPACE_PANE_NAME = "workspace";

export type PaneSize = Readonly<{ width: number; height: number }>;

export type SetupViewMode = "until-ready" | "watch";

/** Format an elapsed or total duration for checklist rows and status lines. */
export function formatElapsed(ms: number): string {
  return formatDuration(Math.max(0, Math.round(ms)));
}

function renderLine(input: TerminalLineInput): string {
  return renderTerminalLineBlessed(terminalLine(input));
}

type StepGlyph = { glyph: string; role: TerminalStyleRole };

function stepGlyph(status: StepSnapshot["status"]): StepGlyph {
  const { symbols } = activeTheme();
  switch (status) {
    case "ok":
      return { glyph: symbols.statusComplete, role: "success" };
    case "failed":
      return { glyph: symbols.statusFailed, role: "error" };
    case "running":
    case "retrying":
      return { glyph: symbols.statusRunning, role: "accent" };
    case "skipped":
      return { glyph: symbols.statusPending, role: "muted" };
    case "cancelled":
      return { glyph: symbols.statusCancelled, role: "warning" };
    case "pending":
      return { glyph: symbols.statusPending, role: "muted" };
  }
}

function stepElapsed(step: StepSnapshot, nowMs: number): string | null {
  if (step.durationMs !== undefined) return formatElapsed(step.durationMs);
  if (step.status === "running" || step.status === "retrying") {
    if (step.startedAtMs !== undefined && Number.isFinite(step.startedAtMs)) {
      return formatElapsed(nowMs - step.startedAtMs);
    }
  }
  return null;
}

function stepRow(step: StepSnapshot, width: number, nowMs: number): string {
  const { glyph, role } = stepGlyph(step.status);
  const elapsed = stepElapsed(step, nowMs);
  const attempt = step.attempt > 1 ? ` (retry ${step.attempt})` : "";
  const suffixText = `${attempt}${elapsed ? ` ${elapsed}` : ""}`;
  const titleWidth = Math.max(width - 2 - suffixText.length, 4);
  return renderLine([
    terminalSpan(glyph, { role }),
    " ",
    terminalSpan(truncateAnsi(step.title, titleWidth), {
      role: step.status === "pending" ? "muted" : "primary",
    }),
    ...(attempt ? [terminalSpan(attempt, { role: "warning" })] : []),
    ...(elapsed ? [" ", terminalSpan(elapsed, { role: "muted" })] : []),
  ]);
}

/**
 * Render one repository pane: a step checklist with elapsed times, an error
 * line when the repo failed, then a divider and the newest output lines that
 * fit the pane. Rebuilt from the snapshot every frame, so reflow, zoom, and
 * paging never depend on accumulated pane state.
 */
export function renderPaneLines(
  repo: RepoRunSnapshot,
  size: PaneSize,
  nowMs: number,
  /**
   * Live emulator-rendered screen lines for this pane (from
   * `TerminalTailStore`), preferred over `repo.tail` when non-null and
   * non-empty. `repo.tail` is the reducer's plain normalized tail (the
   * canonical text also used for logs and the scrollback summary);
   * `styledTail` is the current @xterm/headless screen contents, carrying
   * real SGR codes so the pane looks like what the child process actually
   * drew (progress bars, colored output, cursor-addressed redraws resolved).
   */
  styledTail?: readonly string[] | null,
): string[] {
  const width = Math.max(size.width, 8);
  const height = Math.max(size.height, 1);
  const lines: string[] = [];

  if (repo.steps.length === 0) {
    const message =
      repo.status === "cancelled"
        ? "Cancelled"
        : repo.status === "pending"
          ? "Queued"
          : "Starting…";
    lines.push(
      renderLine([
        terminalSpan(message, {
          role: repo.status === "cancelled" ? "warning" : "muted",
        }),
      ]),
    );
  }

  const stepBudget = Math.max(height - (repo.error ? 1 : 0), 1);
  const steps =
    repo.steps.length > stepBudget
      ? repo.steps.slice(repo.steps.length - stepBudget)
      : repo.steps;
  for (const step of steps) {
    lines.push(stepRow(step, width, nowMs));
  }

  if (repo.error && lines.length < height) {
    lines.push(
      renderLine([
        terminalSpan(truncateAnsi(`Error: ${repo.error}`, width), {
          role: "error",
        }),
      ]),
    );
  }

  const tailLines =
    styledTail && styledTail.length > 0 ? styledTail : repo.tail;
  const remaining = height - lines.length;
  if (remaining >= 2 && tailLines.length > 0) {
    lines.push(
      renderLine([terminalSpan("─".repeat(width), { role: "muted" })]),
    );
    const tailBudget = remaining - 1;
    for (const tailLine of tailLines.slice(-tailBudget)) {
      // No role here (unlike the other spans in this file): the content box
      // that renders tail lines flips its own default fg between dim and the
      // focus color, and the SGR-styled tail needs to carry its own colors
      // through untouched rather than being forced dim.
      lines.push(renderLine([terminalSpan(truncateAnsi(tailLine, width))]));
    }
  }

  return lines.slice(0, height);
}

/** The pane border label: repo name plus its most informative live state. */
export function paneLabel(repo: RepoRunSnapshot, nowMs: number): string {
  const { symbols } = activeTheme();
  switch (repo.status) {
    case "ready":
      return renderLine([
        terminalSpan(`${repo.repo} ${symbols.statusComplete}`, {
          role: "success",
        }),
      ]);
    case "failed":
      return renderLine([
        terminalSpan(`${repo.repo} ${symbols.statusFailed}`, { role: "error" }),
      ]);
    case "cancelled":
      return renderLine([
        terminalSpan(`${repo.repo} ${symbols.statusCancelled}`, {
          role: "warning",
        }),
      ]);
    default: {
      const active = [...repo.steps]
        .reverse()
        .find(
          (step) => step.status === "running" || step.status === "retrying",
        );
      if (!active) {
        const glyph =
          repo.status === "pending"
            ? symbols.statusPending
            : symbols.statusRunning;
        return renderLine([repo.repo, " ", glyph]);
      }
      const elapsed = stepElapsed(active, nowMs);
      return renderLine([
        repo.repo,
        ": ",
        active.title,
        " ",
        symbols.statusRunning,
        ...(elapsed ? [" ", terminalSpan(elapsed, { role: "muted" })] : []),
      ]);
    }
  }
}

/**
 * Project workspace-scoped steps (hooks, AGENTS.md refresh) onto the same
 * pane shape repos use, so the grid can render them as one extra pane.
 * Returns null while no workspace-level work has been recorded.
 */
export function workspacePaneSnapshot(
  run: RunSnapshot,
): RepoRunSnapshot | null {
  if (run.workspaceSteps.length === 0 && run.workspaceTail.length === 0) {
    return null;
  }
  const failed = run.workspaceSteps.find((step) => step.status === "failed");
  const running = run.workspaceSteps.some(
    (step) => step.status === "running" || step.status === "retrying",
  );
  return {
    repo: WORKSPACE_PANE_NAME,
    status: failed
      ? "failed"
      : running
        ? "running"
        : run.outcome === "ready"
          ? "ready"
          : "running",
    steps: run.workspaceSteps,
    tail: run.workspaceTail,
    ...(failed?.lastMessage !== undefined ? { error: failed.lastMessage } : {}),
  };
}

export type StatusLineInput = Readonly<{
  snapshot: RunSnapshot;
  repoNames: readonly string[];
  page: number;
  pageCount: number;
  zoomed: boolean;
  mode: SetupViewMode;
  canDetach: boolean;
  cancelRequested: boolean;
  nowMs: number;
}>;

/**
 * The one-line footer under the grid: readiness counts, elapsed time, paging
 * position, and the key hints for the current mode (key first, action second).
 */
export function buildStatusLine(input: StatusLineInput): string {
  const {
    snapshot,
    repoNames,
    page,
    pageCount,
    zoomed,
    mode,
    canDetach,
    cancelRequested,
    nowMs,
  } = input;

  if (cancelRequested) {
    return renderLine([
      terminalSpan("Cancelling, press Ctrl-C again to force", {
        role: "warning",
      }),
    ]);
  }

  let ready = 0;
  let failed = 0;
  for (const name of repoNames) {
    const repo = snapshot.repos.get(name);
    if (repo?.status === "ready") ready += 1;
    if (repo?.status === "failed") failed += 1;
  }

  const parts: string[] = [`${ready}/${repoNames.length} ready`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (snapshot.startedAtMs !== undefined) {
    parts.push(`${formatElapsed(nowMs - snapshot.startedAtMs)} elapsed`);
  }
  if (pageCount > 1) {
    parts.push(`page ${page + 1}/${pageCount}`);
  }

  const hints: string[] = [];
  if (zoomed) {
    hints.push("[esc] back");
  } else {
    hints.push("[z] zoom");
    if (pageCount > 1) hints.push("[ ] page");
  }
  if (mode === "until-ready") {
    if (canDetach) hints.push("[d] detach");
    hints.push("[q] cancel");
  } else {
    hints.push("[q] quit");
  }
  hints.push("[?] help");

  return renderLine([
    terminalSpan(parts.join(" · "), { role: "muted" }),
    terminalSpan("  ", { role: "muted" }),
    terminalSpan(hints.join(" "), { role: "dim" }),
  ]);
}

export type HelpLinesInput = Readonly<{
  mode: SetupViewMode;
  canDetach: boolean;
}>;

/**
 * The `?` overlay's full keymap, one rendered line per binding. The status
 * line only has room for the mode's primary hints; this is the complete
 * reference for everything the grid responds to.
 */
export function buildHelpLines(input: HelpLinesInput): string[] {
  const bindings: [key: string, action: string][] = [
    ["arrows / hjkl", "move focus between panes"],
    ["z / enter", "toggle zoom on the focused pane"],
    ["esc", "close zoom (or this help)"],
    ["[ and ]", "previous / next page"],
  ];
  if (input.mode === "until-ready") {
    if (input.canDetach) {
      bindings.push(["d", "detach; setup continues in the background"]);
    }
    bindings.push(["q / ctrl-c", "cancel setup (press twice to force)"]);
  } else {
    bindings.push(["q / esc", "quit watching; setup keeps running"]);
  }
  bindings.push(["?", "toggle this help"]);

  const keyWidth = Math.max(...bindings.map(([key]) => key.length));
  const lines = bindings.map(([key, action]) =>
    renderLine([
      terminalSpan(key.padEnd(keyWidth + 2), { role: "accent" }),
      terminalSpan(action, {}),
    ]),
  );
  lines.push("");
  lines.push(
    renderLine([
      terminalSpan("press any key to close", {
        role: "muted",
      }),
    ]),
  );
  return lines;
}
