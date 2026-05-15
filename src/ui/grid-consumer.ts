import {
  CommandStreamAdapter,
  escapeBlessedTags,
} from "../terminal/command-stream-adapter.ts";
import {
  createFullscreenScreen,
  createFullscreenStatusLine,
  type FullscreenScreen,
  type FullscreenStatusLine,
  waitForFullscreenKey,
} from "../terminal/fullscreen-surface.ts";
import { runParallel } from "../utils/task-generator.ts";
import type { RepoPipelineState } from "../workspace/pipeline.ts";
import { calculateGridDimensions, GridLayout } from "./grid-layout.ts";

export type RenderPipelinesGridOptions = {
  pipelines: Map<string, AsyncGenerator<RepoPipelineState>>;
  repoNames: string[];
  getLogPath?: (repoName: string) => Promise<string>;
  onFailure?: (
    repoName: string,
    state: Extract<RepoPipelineState, { phase: "failed" }>,
  ) => void | Promise<void>;
  onBeforeCompletionPrompt?: (
    repoResults: Map<string, { hasLockfile: boolean }>,
  ) => void | Promise<void>;
  environment?: GridRenderEnvironment;
};

const DEFAULT_RENDER_INTERVAL_MS = 33;
const DEFAULT_FINAL_HOLD_MS = 500;
const MAX_GRID_REPOS = 9;

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
  once?(event: "keypress", handler: () => void): void;
  destroy(): void;
}

export interface GridStatusLineLike {
  setContent(content: string): void;
  destroy(): void;
}

export interface GridRenderEnvironment {
  createScreen(): GridScreenLike;
  createGrid(options: {
    screen: GridScreenLike;
    rows: number;
    cols: number;
  }): GridLayoutLike;
  createStatusLine?: (options: {
    screen: GridScreenLike;
  }) => GridStatusLineLike;
  waitForCompletionAck?: (screen: GridScreenLike) => Promise<void>;
  renderIntervalMs?: number;
  finalHoldMs?: number;
}

function createDefaultEnvironment(): GridRenderEnvironment {
  return {
    createScreen: () => createFullscreenScreen(),
    createGrid: ({ screen, rows, cols }) =>
      new GridLayout({
        screen: screen as FullscreenScreen,
        rows,
        cols,
        top: 0,
        left: 0,
        width: "100%",
        height: "100%-1",
        borderColor: "cyan",
      }),
    createStatusLine: ({ screen }) =>
      createFullscreenStatusLine(
        screen as FullscreenScreen,
      ) as FullscreenStatusLine,
    waitForCompletionAck: (screen) =>
      waitForFullscreenKey(screen as FullscreenScreen),
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
export function shouldUseGrid(repoCount?: number): boolean {
  if (repoCount !== undefined && repoCount > MAX_GRID_REPOS) return false;
  if (!process.stdout.isTTY) return false;
  const { columns, rows } = process.stdout;
  if ((columns ?? 80) < 60 || (rows ?? 24) < 15) return false;
  if (process.env["CI"] || process.env["WORKFOREST_NO_TUI"]) return false;
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
  getLogPath,
  onFailure,
  onBeforeCompletionPrompt,
  environment = createDefaultEnvironment(),
}: RenderPipelinesGridOptions): Promise<Map<string, { hasLockfile: boolean }>> {
  const renderIntervalMs =
    environment.renderIntervalMs ?? DEFAULT_RENDER_INTERVAL_MS;
  const finalHoldMs = environment.finalHoldMs ?? DEFAULT_FINAL_HOLD_MS;
  const { rows, cols } = calculateGridDimensions(repoNames.length);
  if (repoNames.length > rows * cols) {
    throw new Error(
      `Grid can render ${rows * cols} repositories, received ${repoNames.length}.`,
    );
  }

  const screen = environment.createScreen();
  const statusLine = environment.createStatusLine?.({ screen });

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
      pane.setLabel(`${escapeBlessedTags(name)} ${STATUS_ICONS.pending}`);
    }
  });

  // Track repo states for return value
  const repoResults = new Map<string, { hasLockfile: boolean }>();
  const outputAdapters = new Map<string, CommandStreamAdapter>();
  let pendingRender: Promise<void> | null = null;
  let pendingRenderTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  let awaitingCompletionAck = false;

  const destroyScreen = (): void => {
    if (destroyed) return;
    destroyed = true;

    if (pendingRenderTimer) {
      clearTimeout(pendingRenderTimer);
      pendingRenderTimer = null;
      pendingRender = null;
    }

    grid.destroy();
    statusLine?.destroy();
    screen.destroy();
  };

  const scheduleRender = (): void => {
    if (renderIntervalMs <= 0) {
      grid.render();
      return;
    }

    if (pendingRender) return;
    pendingRender = new Promise((resolve) => {
      pendingRenderTimer = setTimeout(() => {
        pendingRenderTimer = null;
        pendingRender = null;
        grid.render();
        resolve();
      }, renderIntervalMs);
    });
  };

  // Handle keyboard events
  screen.key(["escape", "q", "C-c"], () => {
    if (awaitingCompletionAck) return;
    destroyScreen();
    process.exit(0);
  });

  try {
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
          pane.setLabel(
            `${escapeBlessedTags(id)}: ${state.step} ${STATUS_ICONS.running}`,
          );

          if (state.output) {
            appendOutput(pane, id, state.output, outputAdapters);
          } else if (state.message) {
            flushOutputBuffer(pane, id, outputAdapters);
            pane.appendLine(
              `{gray-fg}${escapeBlessedTags(state.message)}{/gray-fg}`,
            );
          }
          break;
        }

        case "initializer": {
          pane.setLabel(
            `${escapeBlessedTags(id)}: ${escapeBlessedTags(state.name)} ${STATUS_ICONS.running}`,
          );

          if (state.output) {
            appendOutput(pane, id, state.output, outputAdapters);
          } else if (state.message) {
            flushOutputBuffer(pane, id, outputAdapters);
            pane.appendLine(
              `{gray-fg}${escapeBlessedTags(state.message)}{/gray-fg}`,
            );
          }
          break;
        }

        case "complete": {
          flushOutputBuffer(pane, id, outputAdapters);
          pane.setLabel(
            `{green-fg}${escapeBlessedTags(id)} ${STATUS_ICONS.complete}{/green-fg}`,
          );
          repoResults.set(id, { hasLockfile: state.hasLockfile });
          break;
        }

        case "failed": {
          flushOutputBuffer(pane, id, outputAdapters);
          pane.setLabel(
            `{red-fg}${escapeBlessedTags(id)} ${STATUS_ICONS.failed}{/red-fg}`,
          );
          if (state.step) {
            pane.appendLine(
              `{red-fg}Step: ${escapeBlessedTags(state.step)}{/red-fg}`,
            );
          }
          pane.appendLine(
            `{red-fg}Error: ${escapeBlessedTags(state.error.message)}{/red-fg}`,
          );
          if (getLogPath) {
            const logPath = await getLogPath(id);
            pane.appendLine(
              `{red-fg}Log: ${escapeBlessedTags(logPath)}{/red-fg}`,
            );
          }
          await onFailure?.(id, state);
          break;
        }
      }

      scheduleRender();
    }

    for (const [repoId, paneIndex] of paneMap) {
      const pane = grid.getPane(paneIndex);
      if (!pane) continue;
      flushOutputBuffer(pane, repoId, outputAdapters);
    }

    if (pendingRender) {
      await pendingRender;
    }

    if (onBeforeCompletionPrompt) {
      statusLine?.setContent("{gray-fg}Finalizing workspace...{/gray-fg}");
      grid.render();
      await onBeforeCompletionPrompt(repoResults);
    }

    const completionMessage = getCompletionMessage(
      repoResults.size,
      repoNames.length,
    );
    appendCompletionPromptToPanes({
      grid,
      paneMap,
      message: completionMessage.pane,
    });
    statusLine?.setContent(completionMessage.statusLine);
    grid.render();

    if (environment.waitForCompletionAck) {
      awaitingCompletionAck = true;
      await environment.waitForCompletionAck(screen);
      awaitingCompletionAck = false;
    } else if (finalHoldMs > 0) {
      // Compatibility for benchmark/test environments without an acknowledgement
      // hook.
      await sleep(finalHoldMs);
    }

    return repoResults;
  } finally {
    destroyScreen();
  }
}

/**
 * Append output to a pane, handling newlines and ANSI codes.
 */
function appendOutput(
  pane: { appendLine: (line: string) => void },
  repoId: string,
  output: string,
  adapters: Map<string, CommandStreamAdapter>,
): void {
  const adapter = getAdapter(adapters, repoId);
  for (const line of adapter.push("stdout", output)) {
    pane.appendLine(line.line);
  }
}

function flushOutputBuffer(
  pane: { appendLine: (line: string) => void },
  repoId: string,
  adapters: Map<string, CommandStreamAdapter>,
): void {
  const adapter = adapters.get(repoId);
  if (!adapter) return;
  for (const line of adapter.flush()) {
    pane.appendLine(line.line);
  }
  adapters.delete(repoId);
}

function getAdapter(
  adapters: Map<string, CommandStreamAdapter>,
  repoId: string,
): CommandStreamAdapter {
  let adapter = adapters.get(repoId);
  if (!adapter) {
    adapter = new CommandStreamAdapter();
    adapters.set(repoId, adapter);
  }
  return adapter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCompletionMessage(
  completedCount: number,
  totalCount: number,
): { pane: string; statusLine: string } {
  const failedCount = totalCount - completedCount;
  const summary =
    failedCount > 0
      ? `{yellow-fg}${completedCount}/${totalCount} repositories complete, ${failedCount} failed{/yellow-fg}`
      : `{green-fg}${totalCount}/${totalCount} repositories complete{/green-fg}`;

  return {
    pane: `${summary}\n{gray-fg}Press any key to continue{/gray-fg}`,
    statusLine: `${summary}  {gray-fg}Press any key to continue{/gray-fg}`,
  };
}

function appendCompletionPromptToPanes({
  grid,
  paneMap,
  message,
}: {
  grid: GridLayoutLike;
  paneMap: Map<string, number>;
  message: string;
}): void {
  for (const paneIndex of paneMap.values()) {
    const pane = grid.getPane(paneIndex);
    if (!pane) continue;
    pane.appendLine("");
    pane.appendLine(message);
  }
}
