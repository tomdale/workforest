import { NodeRuntime, Screen, setRuntime } from "@unblessed/node";
import { runParallel } from "../utils/task-generator.ts";
import type { RepoPipelineState } from "../workspace/pipeline.ts";
import { calculateGridDimensions, GridLayout } from "./grid-layout.ts";

// @unblessed/core requires a runtime to be registered before any Screen is created.
// NodeRuntime provides the Node.js-specific implementations (fs, process, tty, etc.).
setRuntime(new NodeRuntime());

export type RenderPipelinesGridOptions = {
  pipelines: Map<string, AsyncGenerator<RepoPipelineState>>;
  repoNames: string[];
};

/**
 * Check if the terminal supports grid rendering.
 * Falls back to spinner mode for:
 * - Non-TTY environments
 * - Small terminals (< 60 cols or < 15 rows)
 * - CI environments
 * - When WORKFOREST_NO_TUI is set
 */
export function shouldUseGrid(): boolean {
  if (!process.stdout.isTTY) return false;
  const { columns, rows } = process.stdout;
  if ((columns ?? 80) < 60 || (rows ?? 24) < 15) return false;
  if (process.env.CI || process.env.WORKFOREST_NO_TUI) return false;
  return true;
}

/**
 * Status indicators for pane labels.
 */
const STATUS_ICONS = {
  running: "\u21bb", // ⟳
  complete: "\u2713", // ✓
  failed: "\u2717", // ✗
  pending: "\u25cb", // ○
};

/**
 * Render parallel repo pipelines using a grid layout.
 * Each pane shows one repo's output and current phase.
 */
export async function renderPipelinesGrid({
  pipelines,
  repoNames,
}: RenderPipelinesGridOptions): Promise<Map<string, { hasLockfile: boolean }>> {
  const screen = new Screen({
    smartCSR: true,
    fullUnicode: true,
    title: "workforest",
  });

  const { rows, cols } = calculateGridDimensions(repoNames.length);

  const grid = new GridLayout({
    screen,
    rows,
    cols,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    borderColor: "cyan",
  });

  // Map repo names to pane indices
  const paneMap = new Map<string, number>();
  repoNames.forEach((name, i) => {
    paneMap.set(name, i);
    const pane = grid.getPane(i);
    if (pane) {
      pane.setLabel(`${name} ${STATUS_ICONS.pending}`);
    }
  });

  // Track repo states for return value
  const repoResults = new Map<string, { hasLockfile: boolean }>();
  const repoPhases = new Map<string, string>();

  // Handle keyboard events
  screen.key(["escape", "q", "C-c"], () => {
    grid.destroy();
    screen.destroy();
    process.exit(0);
  });

  // Initial render
  grid.render();

  // Consume all pipelines in parallel
  for await (const { id, state } of runParallel(pipelines)) {
    const paneIndex = paneMap.get(id);
    if (paneIndex === undefined) continue;

    const pane = grid.getPane(paneIndex);
    if (!pane) continue;

    switch (state.phase) {
      case "git": {
        repoPhases.set(id, state.step);
        pane.setLabel(`${id}: ${state.step} ${STATUS_ICONS.running}`);

        if (state.output) {
          appendOutput(pane, state.output);
        } else if (state.message) {
          pane.appendLine(`{gray-fg}${state.message}{/gray-fg}`);
        }
        break;
      }

      case "initializer": {
        repoPhases.set(id, state.name);
        pane.setLabel(`${id}: ${state.name} ${STATUS_ICONS.running}`);

        if (state.output) {
          appendOutput(pane, state.output);
        } else if (state.message) {
          pane.appendLine(`{gray-fg}${state.message}{/gray-fg}`);
        }
        break;
      }

      case "complete": {
        repoPhases.set(id, "complete");
        pane.setLabel(`{green-fg}${id} ${STATUS_ICONS.complete}{/green-fg}`);
        repoResults.set(id, { hasLockfile: state.hasLockfile });
        break;
      }

      case "failed": {
        repoPhases.set(id, "failed");
        pane.setLabel(`{red-fg}${id} ${STATUS_ICONS.failed}{/red-fg}`);
        pane.appendLine(`{red-fg}Error: ${state.error.message}{/red-fg}`);
        break;
      }
    }

    grid.render();
  }

  // Keep grid visible briefly so user can see final state
  await sleep(500);

  grid.destroy();
  screen.destroy();

  return repoResults;
}

/**
 * Append output to a pane, handling newlines and ANSI codes.
 */
function appendOutput(
  pane: { appendLine: (line: string) => void },
  output: string,
): void {
  // Strip ANSI codes but keep blessed tags
  const cleaned = stripAnsi(output);
  // appendLine handles splitting on newlines internally
  pane.appendLine(cleaned);
}

/**
 * Strip ANSI escape codes from a string.
 */
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape code detection requires control characters
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
