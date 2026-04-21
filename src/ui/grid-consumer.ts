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
  environment?: GridRenderEnvironment;
};

const DEFAULT_RENDER_INTERVAL_MS = 33;
const DEFAULT_FINAL_HOLD_MS = 500;

export interface GridPaneLike {
  setLabel(label: string): void;
  appendLine(line: string): void;
}

export interface GridLayoutLike {
  getPane(index: number): GridPaneLike | undefined;
  render(): void;
  destroy(): void;
}

export interface GridScreenLike {
  key(
    keys: string[],
    handler: (_ch?: string, _key?: { name?: string }) => void,
  ): void;
  destroy(): void;
}

export interface GridRenderEnvironment {
  createScreen(): GridScreenLike;
  createGrid(options: {
    screen: GridScreenLike;
    rows: number;
    cols: number;
  }): GridLayoutLike;
  renderIntervalMs?: number;
  finalHoldMs?: number;
}

function createDefaultEnvironment(): GridRenderEnvironment {
  return {
    createScreen: () =>
      new Screen({
        smartCSR: true,
        fullUnicode: true,
        title: "workforest",
      }),
    createGrid: ({ screen, rows, cols }) =>
      new GridLayout({
        screen: screen as Screen,
        rows,
        cols,
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        borderColor: "cyan",
      }),
    renderIntervalMs: DEFAULT_RENDER_INTERVAL_MS,
    finalHoldMs: DEFAULT_FINAL_HOLD_MS,
  };
}

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
  environment = createDefaultEnvironment(),
}: RenderPipelinesGridOptions): Promise<Map<string, { hasLockfile: boolean }>> {
  const renderIntervalMs =
    environment.renderIntervalMs ?? DEFAULT_RENDER_INTERVAL_MS;
  const finalHoldMs = environment.finalHoldMs ?? DEFAULT_FINAL_HOLD_MS;
  const screen = environment.createScreen();

  const { rows, cols } = calculateGridDimensions(repoNames.length);

  const grid = environment.createGrid({
    screen,
    rows,
    cols,
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
  const outputBuffers = new Map<string, string>();
  let pendingRender: Promise<void> | null = null;

  const scheduleRender = (): void => {
    if (renderIntervalMs <= 0) {
      grid.render();
      return;
    }

    if (pendingRender) return;
    pendingRender = new Promise((resolve) => {
      setTimeout(() => {
        pendingRender = null;
        grid.render();
        resolve();
      }, renderIntervalMs);
    });
  };

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
        pane.setLabel(`${id}: ${state.step} ${STATUS_ICONS.running}`);

        if (state.output) {
          appendOutput(pane, id, state.output, outputBuffers);
        } else if (state.message) {
          flushOutputBuffer(pane, id, outputBuffers);
          pane.appendLine(`{gray-fg}${state.message}{/gray-fg}`);
        }
        break;
      }

      case "initializer": {
        pane.setLabel(`${id}: ${state.name} ${STATUS_ICONS.running}`);

        if (state.output) {
          appendOutput(pane, id, state.output, outputBuffers);
        } else if (state.message) {
          flushOutputBuffer(pane, id, outputBuffers);
          pane.appendLine(`{gray-fg}${state.message}{/gray-fg}`);
        }
        break;
      }

      case "complete": {
        flushOutputBuffer(pane, id, outputBuffers);
        pane.setLabel(`{green-fg}${id} ${STATUS_ICONS.complete}{/green-fg}`);
        repoResults.set(id, { hasLockfile: state.hasLockfile });
        break;
      }

      case "failed": {
        flushOutputBuffer(pane, id, outputBuffers);
        pane.setLabel(`{red-fg}${id} ${STATUS_ICONS.failed}{/red-fg}`);
        pane.appendLine(`{red-fg}Error: ${state.error.message}{/red-fg}`);
        break;
      }
    }

    scheduleRender();
  }

  for (const [repoId, paneIndex] of paneMap) {
    const pane = grid.getPane(paneIndex);
    if (!pane) continue;
    flushOutputBuffer(pane, repoId, outputBuffers);
  }

  if (pendingRender) {
    await pendingRender;
  }

  // Keep grid visible briefly so user can see final state
  if (finalHoldMs > 0) {
    await sleep(finalHoldMs);
  }

  grid.destroy();
  screen.destroy();

  return repoResults;
}

/**
 * Append output to a pane, handling newlines and ANSI codes.
 */
function appendOutput(
  pane: { appendLine: (line: string) => void },
  repoId: string,
  output: string,
  buffers: Map<string, string>,
): void {
  const buffered = `${buffers.get(repoId) ?? ""}${stripAnsi(output)}`;
  let currentLine = "";

  for (const char of buffered) {
    if (char === "\r") {
      currentLine = "";
      continue;
    }

    if (char === "\n") {
      pane.appendLine(currentLine);
      currentLine = "";
      continue;
    }

    currentLine += char;
  }

  buffers.set(repoId, currentLine);
}

function flushOutputBuffer(
  pane: { appendLine: (line: string) => void },
  repoId: string,
  buffers: Map<string, string>,
): void {
  const pending = buffers.get(repoId);
  if (!pending) return;

  pane.appendLine(pending);
  buffers.delete(repoId);
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
