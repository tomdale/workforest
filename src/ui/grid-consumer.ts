import {
  Box,
  type BoxOptions,
  type Screen as UnblessedScreen,
} from "@unblessed/node";
import stringWidth from "string-width";
import {
  isEnvironmentVariableSet,
  STANDARD_ENVIRONMENT_VARIABLES,
  WORKFOREST_ENVIRONMENT_VARIABLES,
} from "../environment.ts";
import { emitServiceEvent, type ServiceEventSink } from "../services/events.ts";
import { CommandStreamAdapter } from "../terminal/command-stream-adapter.ts";
import {
  createFullscreenKeypress,
  createFullscreenScreen,
  createFullscreenStage,
  createFullscreenStatusLine,
  FULLSCREEN_QUIT_KEYS,
  type FullscreenKeypress,
  type FullscreenScreen,
  type FullscreenStatusLine,
  fullTerminalViewport,
} from "../terminal/fullscreen-surface.ts";
import {
  renderTerminalLineBlessed,
  type TerminalLineInput,
  terminalLine,
  terminalSpan,
} from "../terminal/render-model.ts";
import { activeTheme, toBlessed } from "../terminal/theme-system.ts";
import { compactHome } from "../utils/display-path.ts";
import { runParallel } from "../utils/task-generator.ts";
import { resolveConfiguredMaxConcurrent } from "../workspace/setup-limits.ts";

/** Pane status glyphs, resolved from the active theme's semantic symbols. */
function statusIcons(): {
  running: string;
  complete: string;
  failed: string;
  pending: string;
} {
  const { symbols } = activeTheme();
  return {
    running: symbols.statusRunning,
    complete: symbols.statusComplete,
    failed: symbols.statusFailed,
    pending: symbols.statusPending,
  };
}

/** Decorative confetti fill colors, projected to @unblessed tokens. */
function confettiColorTokens(): readonly string[] {
  return activeTheme().decoration.confettiColors.map(toBlessed);
}

/** Decorative confetti particle glyphs from the active theme. */
function confettiGlyphs(): readonly string[] {
  return activeTheme().decoration.confettiGlyphs;
}

/** Semantic color roles as @unblessed tokens for the current theme. */
function colors(): {
  focus: string;
  success: string;
  warning: string;
  error: string;
  muted: string;
  primary: string;
  border: string;
  background: string;
} {
  const theme = activeTheme();
  const { palette } = theme;
  return {
    focus: toBlessed(palette.focus.color),
    success: toBlessed(palette.success.color),
    warning: toBlessed(palette.warning.color),
    error: toBlessed(palette.error.color),
    muted: toBlessed(palette.muted.color),
    primary: toBlessed(palette.primary.color),
    border: toBlessed(theme.chrome.border),
    background: toBlessed(theme.chrome.background),
  };
}

function renderBlessedLine(input: TerminalLineInput): string {
  return renderTerminalLineBlessed(terminalLine(input));
}

function repoLabel(repoName: string, status: string): string {
  return renderBlessedLine([repoName, " ", status]);
}

function repoStepLabel(repoName: string, step: string, status: string): string {
  return renderBlessedLine([repoName, ": ", step, " ", status]);
}

function styledRepoLabel(
  repoName: string,
  status: string,
  role: "success" | "warning" | "error",
): string {
  return renderBlessedLine([terminalSpan(`${repoName} ${status}`, { role })]);
}

function paneMessage(
  message: string,
  role: "muted" | "warning" | "error",
): string {
  return renderBlessedLine([terminalSpan(message, { role })]);
}

import type { RepoPipelineState } from "../workspace/pipeline.ts";
import { calculateGridDimensions, GridLayout } from "./grid-layout.ts";

export type RenderPipelinesGridOptions = {
  pipelines: Map<string, AsyncGenerator<RepoPipelineState>>;
  repoNames: string[];
  workspacePath?: string;
  getLogPath?: (repoName: string) => Promise<string>;
  onFailure?: (
    repoName: string,
    state: Extract<RepoPipelineState, { phase: "failed" }>,
  ) => void | Promise<void>;
  onBeforeCompletionPrompt?: (
    repoResults: Map<string, { hasLockfile: boolean }>,
  ) => void | Promise<void>;
  completeOnWorktreesReady?: boolean;
  backgroundInitialization?: boolean;
  /** Cap on concurrently running pipelines; queued repos start as slots free. */
  maxConcurrent?: number;
  environment?: GridRenderEnvironment;
  /** Environment for the pageable setup view used past nine repositories. */
  setupViewEnvironment?: import("./setup-view/grid-view.ts").SetupViewEnvironment;
};

const DEFAULT_RENDER_INTERVAL_MS = 33;
const DEFAULT_FINAL_HOLD_MS = 500;
const COMPLETION_CONFETTI_INTERVAL_MS = 60;
const COMPLETION_CONFETTI_CELLS_PER_PIECE = 14;
const COMPLETION_CONFETTI_FALL_MIN_MS = 99;
const COMPLETION_CONFETTI_FALL_MAX_MS = 165;
const COMPLETION_CONFETTI_DIRECTION_CHANGE_MIN_MS = 500;
const COMPLETION_CONFETTI_DIRECTION_CHANGE_MAX_MS = 1_400;
const COMPLETION_CONFETTI_HORIZONTAL_JITTER = 3;
const COMPLETION_CONFETTI_HORIZONTAL_RANGE = 5;
const COMPLETION_CONFETTI_CHARACTER_SAMPLING: "cycle" | "fixed" = "cycle";
const COMPLETION_MODAL_TEXT_PADDING = 3;
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

export interface GridCompletionModalLike {
  destroy(): void;
}

export type GridCompletionFailure = {
  repoName: string;
  step?: string;
  message: string;
};

export type GridCompletionModalOptions = {
  screen: GridScreenLike;
  workspacePath?: string;
  worktreeNames: string[];
  completedCount: number;
  totalCount: number;
  setupWarnings: GridCompletionFailure[];
  repoErrors: GridCompletionFailure[];
  backgroundInitialization?: boolean;
};

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
  createCompletionModal?: (
    options: GridCompletionModalOptions,
  ) => GridCompletionModalLike;
  createCompletionAck?: (screen: GridScreenLike) => FullscreenKeypress;
  renderIntervalMs?: number;
  finalHoldMs?: number;
}

function createDefaultEnvironment(): GridRenderEnvironment {
  return {
    createScreen: () => createFullscreenScreen(),
    createGrid: ({ screen, rows, cols }) => {
      const fullscreenScreen = screen as FullscreenScreen;
      const stage = createFullscreenStage(
        fullscreenScreen,
        fullTerminalViewport,
      );
      const grid = new GridLayout({
        screen: fullscreenScreen,
        parent: stage,
        rows,
        cols,
        top: 0,
        left: 0,
        width: "100%",
        height: "100%-1",
        borderColor: colors().primary,
        backgroundColor: colors().background,
      });
      const destroyGrid = grid.destroy.bind(grid);
      grid.destroy = (): void => {
        destroyGrid();
        stage.destroy();
      };
      return grid;
    },
    createStatusLine: ({ screen }) =>
      createFullscreenStatusLine(
        screen as FullscreenScreen,
      ) as FullscreenStatusLine,
    createCompletionModal: createDefaultCompletionModal,
    createCompletionAck: (screen) =>
      createFullscreenKeypress(screen as FullscreenScreen),
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
 *
 * Repo count no longer matters: runs with more than nine repositories page
 * through the grid instead of falling back to the spinner.
 */
export function shouldUseGrid(): boolean {
  if (!process.stdout.isTTY) return false;
  const { columns, rows } = process.stdout;
  if ((columns ?? 80) < 60 || (rows ?? 24) < 15) return false;
  if (
    isEnvironmentVariableSet(STANDARD_ENVIRONMENT_VARIABLES.ci) ||
    isEnvironmentVariableSet(WORKFOREST_ENVIRONMENT_VARIABLES.noTui)
  ) {
    return false;
  }
  return true;
}

/**
 * Render parallel repo pipelines using a grid layout.
 * Each pane shows one repo's output and current phase.
 */
export async function renderPipelinesGrid({
  pipelines,
  repoNames,
  workspacePath,
  getLogPath,
  onFailure,
  onBeforeCompletionPrompt,
  completeOnWorktreesReady = false,
  backgroundInitialization = false,
  maxConcurrent,
  environment = createDefaultEnvironment(),
  setupViewEnvironment,
}: RenderPipelinesGridOptions): Promise<Map<string, { hasLockfile: boolean }>> {
  if (repoNames.length > MAX_GRID_REPOS) {
    // More repos than one grid screen holds: render through the pageable
    // event-native setup view instead of refusing.
    const { renderPipelinesGridPaged } = await import("./setup-view/compat.ts");
    return renderPipelinesGridPaged({
      pipelines,
      repoNames,
      ...(workspacePath !== undefined ? { workspacePath } : {}),
      ...(onFailure !== undefined ? { onFailure } : {}),
      ...(onBeforeCompletionPrompt !== undefined
        ? { onBeforeCompletionPrompt }
        : {}),
      ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
      ...(setupViewEnvironment !== undefined
        ? { environment: setupViewEnvironment }
        : {}),
    });
  }

  const renderIntervalMs =
    environment.renderIntervalMs ?? DEFAULT_RENDER_INTERVAL_MS;
  const finalHoldMs = environment.finalHoldMs ?? DEFAULT_FINAL_HOLD_MS;
  const { rows, cols } = calculateGridDimensions(repoNames.length);

  const screen = environment.createScreen();
  const grid = environment.createGrid({
    screen,
    rows,
    cols,
  });
  const statusLine = environment.createStatusLine?.({ screen });

  // Map repo names to pane indices
  const paneMap = new Map<string, number>();
  repoNames.forEach((name, i) => {
    paneMap.set(name, i);
    const pane = grid.getPane(i);
    if (pane) {
      pane.setLabel(repoLabel(name, statusIcons().pending));
    }
  });

  // Track repo states for return value
  const repoResults = new Map<string, { hasLockfile: boolean }>();
  const worktreeResults = new Map<string, { hasLockfile: boolean }>();
  const worktreeSettled = new Set<string>();
  const outputAdapters = new Map<string, CommandStreamAdapter>();
  const setupWarnings: GridCompletionFailure[] = [];
  const repoErrors: GridCompletionFailure[] = [];
  let pendingRender: Promise<void> | null = null;
  let pendingRenderTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  let awaitingCompletionAck = false;
  let completionModal: GridCompletionModalLike | null = null;
  let completionAck: FullscreenKeypress | null = null;
  let completionShown = false;

  const destroyScreen = (): void => {
    if (destroyed) return;
    destroyed = true;

    if (pendingRenderTimer) {
      clearTimeout(pendingRenderTimer);
      pendingRenderTimer = null;
      pendingRender = null;
    }

    grid.destroy();
    completionModal?.destroy();
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
  screen.key([...FULLSCREEN_QUIT_KEYS], () => {
    if (awaitingCompletionAck) return;
    destroyScreen();
    process.exit(0);
  });

  try {
    // Initial render
    grid.render();

    const renderCompletion = (): void => {
      completionModal?.destroy();
      completionModal =
        environment.createCompletionModal?.({
          screen,
          ...(workspacePath ? { workspacePath } : {}),
          worktreeNames: repoNames.filter(
            (repoName) =>
              !repoErrors.some((failure) => failure.repoName === repoName),
          ),
          completedCount: completeOnWorktreesReady
            ? worktreeResults.size
            : repoResults.size,
          totalCount: repoNames.length,
          setupWarnings,
          repoErrors,
          ...(backgroundInitialization ? { backgroundInitialization } : {}),
        }) ?? null;
      grid.render();
    };

    const showCompletion = async (): Promise<void> => {
      if (completionShown) return;
      completionShown = true;

      if (pendingRender) {
        await pendingRender;
      }

      if (onBeforeCompletionPrompt) {
        statusLine?.setContent(paneMessage("Finalizing workspace...", "muted"));
        grid.render();
        await onBeforeCompletionPrompt(
          completeOnWorktreesReady ? worktreeResults : repoResults,
        );
      }

      statusLine?.setContent(
        backgroundInitialization
          ? paneMessage("Initialization continues in the background", "muted")
          : "",
      );
      renderCompletion();

      if (environment.createCompletionAck) {
        awaitingCompletionAck = true;
        completionAck = environment.createCompletionAck(screen);
        void completionAck.wait().finally(() => {
          awaitingCompletionAck = false;
        });
      }
    };

    const updates = runParallel(pipelines, {
      ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
    })[Symbol.asyncIterator]();
    let nextUpdate = updates.next();

    while (true) {
      const ack = completionAck as FullscreenKeypress | null;
      const next = ack
        ? await ack.race(nextUpdate)
        : {
            type: "result" as const,
            result: await nextUpdate,
          };

      if (next.type === "keypress") {
        await updates.return?.(undefined);
        return completeOnWorktreesReady ? worktreeResults : repoResults;
      }

      if (next.result.done) {
        break;
      }

      const { id, state } = next.result.value;
      nextUpdate = updates.next();
      const paneIndex = paneMap.get(id);
      if (paneIndex === undefined) continue;

      const pane = grid.getPane(paneIndex);
      if (!pane) continue;

      switch (state.phase) {
        case "git": {
          pane.setLabel(repoStepLabel(id, state.step, statusIcons().running));

          if (state.output) {
            appendOutput(pane, id, state.output, outputAdapters);
          } else if (state.message) {
            flushOutputBuffer(pane, id, outputAdapters);
            pane.appendLine(paneMessage(state.message, "muted"));
          }
          break;
        }

        case "initializer": {
          pane.setLabel(repoStepLabel(id, state.name, statusIcons().running));

          if (state.output) {
            appendOutput(pane, id, state.output, outputAdapters);
          } else if (state.message) {
            flushOutputBuffer(pane, id, outputAdapters);
            pane.appendLine(paneMessage(state.message, "muted"));
          }
          break;
        }

        case "worktree-ready": {
          flushOutputBuffer(pane, id, outputAdapters);
          pane.setLabel(
            repoStepLabel(id, "initializing", statusIcons().running),
          );
          pane.appendLine(
            paneMessage(
              "Worktree ready; initialization moved to background",
              "muted",
            ),
          );
          worktreeResults.set(id, { hasLockfile: state.hasLockfile });
          worktreeSettled.add(id);
          break;
        }

        case "complete": {
          flushOutputBuffer(pane, id, outputAdapters);
          pane.setLabel(styledRepoLabel(id, statusIcons().complete, "success"));
          repoResults.set(id, { hasLockfile: state.hasLockfile });
          break;
        }

        case "cancelled": {
          flushOutputBuffer(pane, id, outputAdapters);
          pane.setLabel(styledRepoLabel(id, "cancelled", "warning"));
          pane.appendLine(
            paneMessage(state.message ?? "Initialization cancelled", "warning"),
          );
          setupWarnings.push({
            repoName: id,
            step: "initializer",
            message: state.message ?? "Initialization cancelled",
          });
          if (completionModal) renderCompletion();
          break;
        }

        case "failed": {
          flushOutputBuffer(pane, id, outputAdapters);
          pane.setLabel(styledRepoLabel(id, statusIcons().failed, "error"));
          if (state.step) {
            pane.appendLine(paneMessage(`Step: ${state.step}`, "error"));
          }
          pane.appendLine(
            paneMessage(`Error: ${state.error.message}`, "error"),
          );
          if (getLogPath) {
            const logPath = await getLogPath(id);
            pane.appendLine(paneMessage(`Log: ${logPath}`, "error"));
          }
          recordCompletionFailure(id, state, {
            setupWarnings,
            repoErrors,
          });
          if (!state.step?.startsWith("initializer:")) {
            worktreeSettled.add(id);
          }
          await onFailure?.(id, state);
          if (completionModal) renderCompletion();
          break;
        }
      }

      scheduleRender();

      if (
        completeOnWorktreesReady &&
        worktreeSettled.size === repoNames.length &&
        !completionShown
      ) {
        await showCompletion();
      }
    }

    for (const [repoId, paneIndex] of paneMap) {
      const pane = grid.getPane(paneIndex);
      if (!pane) continue;
      flushOutputBuffer(pane, repoId, outputAdapters);
    }

    await showCompletion();

    const finalCompletionAck = completionAck as FullscreenKeypress | null;
    if (finalCompletionAck) {
      await finalCompletionAck.wait();
    } else if (finalHoldMs > 0) {
      // Compatibility for benchmark/test environments without an acknowledgement
      // hook.
      await sleep(finalHoldMs);
    }

    return completeOnWorktreesReady ? worktreeResults : repoResults;
  } finally {
    destroyScreen();
  }
}

type PipelineProgressState =
  | Extract<RepoPipelineState, { phase: "git" }>
  | Extract<RepoPipelineState, { phase: "initializer" }>;

/** Emit a git/initializer step's running, retry, completion, or failure line. */
function emitPipelineProgress(
  onEvent: ServiceEventSink | undefined,
  id: string,
  label: string,
  state: PipelineProgressState,
): void {
  switch (state.status) {
    case "running":
      if (state.message) {
        emitServiceEvent(onEvent, {
          type: "message",
          level: "info",
          message: `${id}: ${label} - ${state.message}`,
        });
      }
      break;
    case "retrying":
      if (state.message) {
        emitServiceEvent(onEvent, {
          type: "message",
          level: "warning",
          message: `${id}: ${label} - ${state.message}`,
        });
      }
      break;
    case "completed":
      emitServiceEvent(onEvent, {
        type: "message",
        level: "success",
        message: `${id}: ${label} complete`,
      });
      break;
    case "failed":
      emitServiceEvent(onEvent, {
        type: "message",
        level: "error",
        message: `${id}: ${label} failed`,
      });
      break;
    // "output" / "log" / "skipped" / "pending" carry no inline progress line.
  }
}

export type DrainPipelinesToConsoleOptions = {
  onEvent?: ServiceEventSink;
  onFailure?: (
    repoName: string,
    state: Extract<RepoPipelineState, { phase: "failed" }>,
  ) => void | Promise<void>;
  getLogPath?: (repoName: string) => Promise<string>;
  onBeforeCompletionPrompt?: (
    repoResults: Map<string, { hasLockfile: boolean }>,
  ) => void | Promise<void>;
  /** Cap on concurrently running pipelines. */
  maxConcurrent?: number;
  /** Stream subprocess output lines prefixed with the repo name. */
  verbose?: boolean;
};

/**
 * Console fallback for {@link presentPipelines}: drains the per-repo pipelines to
 * inline service events and returns the completed repos. The return value mirrors
 * {@link renderPipelinesGrid}'s contract so callers build their result the same
 * way regardless of which surface ran. `onBeforeCompletionPrompt` runs once all
 * pipelines settle — the same point the grid invokes it — so finalization is
 * deferred identically whether the grid rendered or this drain did.
 */
export async function drainPipelinesToConsole(
  pipelines: Map<string, AsyncGenerator<RepoPipelineState>>,
  {
    onEvent,
    onFailure,
    getLogPath,
    onBeforeCompletionPrompt,
    maxConcurrent,
    verbose = false,
  }: DrainPipelinesToConsoleOptions = {},
): Promise<Map<string, { hasLockfile: boolean }>> {
  const completed = new Map<string, { hasLockfile: boolean }>();
  const outputAdapters = new Map<string, CommandStreamAdapter>();

  const emitVerboseOutput = (id: string, output: string): void => {
    if (!verbose) return;
    const adapter = getAdapter(outputAdapters, id);
    for (const line of adapter.push("stdout", output)) {
      if (line.line.trim().length === 0) continue;
      emitServiceEvent(onEvent, {
        type: "message",
        level: "info",
        message: `${id} │ ${line.line}`,
      });
    }
  };

  // A repo can settle successfully via `worktree-ready` (initialization moved to
  // the background) or `complete`; record the latest lockfile signal from either
  // but announce readiness only once.
  const recordSuccess = (id: string, hasLockfile: boolean): void => {
    const announced = completed.has(id);
    completed.set(id, { hasLockfile });
    if (!announced) {
      emitServiceEvent(onEvent, {
        type: "message",
        level: "success",
        message: `${id}: ready`,
      });
    }
  };

  for await (const { id, state } of runParallel(pipelines, {
    ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
  })) {
    switch (state.phase) {
      case "git":
        if (state.status === "output" && state.output) {
          emitVerboseOutput(id, state.output);
        }
        emitPipelineProgress(onEvent, id, state.step, state);
        break;
      case "initializer":
        if (state.status === "output" && state.output) {
          emitVerboseOutput(id, state.output);
        }
        emitPipelineProgress(onEvent, id, state.name, state);
        break;
      case "worktree-ready":
      case "complete":
        recordSuccess(id, state.hasLockfile);
        break;
      case "failed":
        await onFailure?.(id, state);
        emitServiceEvent(onEvent, {
          type: "message",
          level: "error",
          message: `${id}: ${state.error.message}`,
        });
        if (getLogPath) {
          emitServiceEvent(onEvent, {
            type: "message",
            level: "error",
            message: `${id}: setup log saved to ${await getLogPath(id)}`,
          });
        }
        break;
      // "cancelled" is a grid-only affordance; the console drain stays quiet.
    }
  }

  await onBeforeCompletionPrompt?.(completed);
  return completed;
}

export type PresentPipelinesOptions = {
  pipelines: Map<string, AsyncGenerator<RepoPipelineState>>;
  repoNames: string[];
  /** Render the setup grid when the terminal supports it; else drain to events. */
  interactive: boolean;
  onEvent?: ServiceEventSink;
  getLogPath?: (repoName: string) => Promise<string>;
  onFailure?: (
    repoName: string,
    state: Extract<RepoPipelineState, { phase: "failed" }>,
  ) => void | Promise<void>;
  workspacePath?: string;
  completeOnWorktreesReady?: boolean;
  backgroundInitialization?: boolean;
  onBeforeCompletionPrompt?: (
    repoResults: Map<string, { hasLockfile: boolean }>,
  ) => void | Promise<void>;
  /**
   * Cap on concurrently running pipelines. Resolved from config and
   * WORKFOREST_MAX_CONCURRENT when unset.
   */
  maxConcurrent?: number;
  /** Stream subprocess output in the console fallback. */
  verbose?: boolean;
  shouldUseGrid?: typeof shouldUseGrid;
  renderPipelinesGrid?: typeof renderPipelinesGrid;
};

/**
 * The single seam every parallel repo/task/cloud fan-out routes through: render
 * the interactive grid when the terminal supports it, otherwise drain the same
 * pipelines to inline service events. Both branches return the completed repos so
 * callers assemble their result identically.
 */
export async function presentPipelines({
  pipelines,
  repoNames,
  interactive,
  onEvent,
  getLogPath,
  onFailure,
  workspacePath,
  completeOnWorktreesReady,
  backgroundInitialization,
  onBeforeCompletionPrompt,
  maxConcurrent,
  verbose,
  shouldUseGrid: useGrid = shouldUseGrid,
  renderPipelinesGrid: renderGrid = renderPipelinesGrid,
}: PresentPipelinesOptions): Promise<Map<string, { hasLockfile: boolean }>> {
  const resolvedMaxConcurrent =
    maxConcurrent ?? (await resolveConfiguredMaxConcurrent());

  if (interactive && useGrid()) {
    return renderGrid({
      pipelines,
      repoNames,
      maxConcurrent: resolvedMaxConcurrent,
      ...(workspacePath !== undefined ? { workspacePath } : {}),
      ...(getLogPath !== undefined ? { getLogPath } : {}),
      ...(onFailure !== undefined ? { onFailure } : {}),
      ...(onBeforeCompletionPrompt !== undefined
        ? { onBeforeCompletionPrompt }
        : {}),
      ...(completeOnWorktreesReady !== undefined
        ? { completeOnWorktreesReady }
        : {}),
      ...(backgroundInitialization !== undefined
        ? { backgroundInitialization }
        : {}),
    });
  }

  return drainPipelinesToConsole(pipelines, {
    maxConcurrent: resolvedMaxConcurrent,
    ...(onEvent !== undefined ? { onEvent } : {}),
    ...(onFailure !== undefined ? { onFailure } : {}),
    ...(getLogPath !== undefined ? { getLogPath } : {}),
    ...(onBeforeCompletionPrompt !== undefined
      ? { onBeforeCompletionPrompt }
      : {}),
    ...(verbose !== undefined ? { verbose } : {}),
  });
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

export function createDefaultCompletionModal({
  screen,
  workspacePath,
  worktreeNames,
  completedCount,
  totalCount,
  setupWarnings,
  repoErrors,
  backgroundInitialization = false,
}: GridCompletionModalOptions): GridCompletionModalLike {
  const hasRepoErrors = repoErrors.length > 0;
  const hasSetupWarnings = setupWarnings.length > 0;
  const screenWidth = Number((screen as UnblessedScreen).width ?? 80);
  const screenHeight = Number((screen as UnblessedScreen).height ?? 24);
  const maxTextWidth = getCompletionModalMaxTextWidth({
    worktreeNames,
    setupWarnings,
    backgroundInitialization,
    ...(workspacePath ? { workspacePath } : {}),
  });
  const width = Math.min(
    Math.max(50, maxTextWidth + 7),
    Math.max(50, screenWidth - 8),
  );
  const contentWidth = Math.max(width - 6, 1);
  const contentLines = getCompletionModalContent({
    completedCount,
    totalCount,
    worktreeNames,
    setupWarnings,
    repoErrors,
    backgroundInitialization,
    contentWidth,
    ...(workspacePath ? { workspacePath } : {}),
  });
  const height = Math.min(
    Math.max(contentLines.length + 2, hasRepoErrors ? 12 : 10),
    Math.max(10, screenHeight - 4),
  );
  const left = Math.max(0, Math.floor((screenWidth - width) / 2));
  const top = Math.max(1, Math.floor((screenHeight - height) / 2));

  // The modal's surface reads from the theme's chrome background like every
  // other themed surface — never a hardcoded black, which would leave the
  // popover visibly off-theme against the rest of the cyberpunk UI.
  const surfaceBackground = toBlessed(activeTheme().chrome.background);
  const borderColor = hasRepoErrors
    ? colors().error
    : hasSetupWarnings
      ? colors().warning
      : colors().primary;
  const style: BoxOptions["style"] = {
    fg: colors().primary,
    bg: surfaceBackground,
    border: { fg: borderColor, bg: surfaceBackground },
  };

  const box = new Box({
    parent: screen as UnblessedScreen,
    top,
    left,
    width,
    height,
    tags: true,
    // The confetti layer paints each row to its exact inner width; disabling
    // wrap guarantees a stray wide row can never spill onto a second line and
    // shove the text up and down between animation frames.
    wrap: false,
    border: { type: "line", style: "round" },
    padding: { top: 0, bottom: 0, left: 1, right: 2 },
    content: contentLines.join("\n"),
    style,
  }) as CompletionModalBox;
  const titleBox = createCompletionModalTitle({
    screen,
    left,
    top,
    width,
    title: "Workspace Created",
    backgroundColor: surfaceBackground,
    borderColor,
  });

  if (hasRepoErrors) {
    return new StaticCompletionModal({ box, titleBox });
  }

  return new AnimatedCompletionModal({
    box,
    titleBox,
    screen,
    starField: new FallingStarField(contentWidth, contentLines.length),
    getContent: (starRows) =>
      getCompletionModalContent({
        completedCount,
        totalCount,
        worktreeNames,
        setupWarnings,
        repoErrors,
        backgroundInitialization,
        contentWidth,
        starRows,
        ...(workspacePath ? { workspacePath } : {}),
      }).join("\n"),
  });
}

function createCompletionModalTitle({
  screen,
  left,
  top,
  width,
  title,
  backgroundColor,
  borderColor,
}: {
  screen: GridScreenLike;
  left: number;
  top: number;
  width: number;
  title: string;
  backgroundColor: string;
  borderColor: string;
}): GridCompletionModalLike {
  const content = `\u2500 ${title} \u2500`;
  return new Box({
    parent: screen as UnblessedScreen,
    top,
    left: left + Math.max(Math.floor((width - stringWidth(content)) / 2), 0),
    width: stringWidth(content),
    height: 1,
    content,
    tags: true,
    style: { fg: borderColor, bg: backgroundColor },
  }) as GridCompletionModalLike;
}

export function getCompletionModalContent({
  completedCount,
  totalCount,
  workspacePath,
  worktreeNames,
  setupWarnings,
  repoErrors,
  backgroundInitialization = false,
  contentWidth = 68,
  starRows,
}: Omit<GridCompletionModalOptions, "screen"> & {
  contentWidth?: number;
  starRows?: string[][];
}): string[] {
  if (repoErrors.length > 0) {
    return [
      renderBlessedLine([
        terminalSpan("Repository setup needs attention", {
          role: "error",
          emphasis: "bold",
        }),
      ]),
      "",
      `${completedCount}/${totalCount} repositories completed. ${repoErrors.length} failed during git/worktree setup.`,
      "",
      ...formatCompletionFailures(repoErrors, "Repo errors"),
      ...formatCompletionFailures(setupWarnings, "Setup warnings"),
      "",
      paneMessage("Press any key for next steps", "muted"),
    ];
  }

  const workspaceLines = formatWorkspaceSummary({
    worktreeNames,
    contentWidth: Math.max(contentWidth - COMPLETION_MODAL_TEXT_PADDING * 2, 1),
    ...(workspacePath ? { workspacePath } : {}),
  });
  const infoLines = [
    "",
    ...workspaceLines,
    ...(backgroundInitialization
      ? [
          "",
          paneMessage("Initialization continues in the background.", "muted"),
          paneMessage("Run wf status --watch to check progress.", "muted"),
        ]
      : []),
    ...(setupWarnings.length > 0
      ? ["", ...formatCompletionFailures(setupWarnings, "Setup warnings")]
      : []),
  ];
  const textLines = createCompletionTextLines(infoLines);

  return renderCompletionModalLayers({
    width: contentWidth,
    textLines,
    textPadding: COMPLETION_MODAL_TEXT_PADDING,
    ...(starRows ? { starRows } : {}),
  });
}

function getCompletionModalMaxTextWidth({
  workspacePath,
  worktreeNames,
  setupWarnings,
  backgroundInitialization = false,
}: {
  workspacePath?: string;
  worktreeNames: string[];
  setupWarnings: GridCompletionFailure[];
  backgroundInitialization?: boolean;
}): number {
  const visibleLines = [
    ...formatWorkspaceSummary({
      worktreeNames,
      contentWidth: Number.POSITIVE_INFINITY,
      ...(workspacePath ? { workspacePath } : {}),
    }),
    ...(setupWarnings.length > 0
      ? formatCompletionFailures(setupWarnings, "Setup warnings")
      : []),
    ...(backgroundInitialization
      ? [
          "Initialization continues in the background.",
          "Run wf status --watch to check progress.",
        ]
      : []),
    "press any key",
  ].map(stripBlessedTags);

  return Math.max(...visibleLines.map((line) => stringWidth(line)), 0);
}

function createCompletionTextLines(infoLines: string[]): ModalTextLine[] {
  const contentHeight = Math.max(infoLines.length + 5, 9);
  const lines: ModalTextLine[] = Array.from({ length: contentHeight }, () => ({
    text: "",
  }));
  for (let i = 0; i < infoLines.length && i < lines.length; i++) {
    lines[i] = { text: infoLines[i] ?? "" };
  }

  const callToActionRow = Math.max(contentHeight - 2, 0);
  lines[callToActionRow] = {
    text: renderBlessedLine([
      terminalSpan("press any key", { role: "focus", emphasis: "bold" }),
    ]),
    align: "center",
  };

  return lines;
}

type CompletionModalBox = GridCompletionModalLike & {
  setContent(content: string): void;
};

class StaticCompletionModal implements GridCompletionModalLike {
  private readonly box: CompletionModalBox;
  private readonly titleBox: GridCompletionModalLike;

  constructor({
    box,
    titleBox,
  }: {
    box: CompletionModalBox;
    titleBox: GridCompletionModalLike;
  }) {
    this.box = box;
    this.titleBox = titleBox;
  }

  destroy(): void {
    this.titleBox.destroy();
    this.box.destroy();
  }
}

class AnimatedCompletionModal implements GridCompletionModalLike {
  private readonly box: CompletionModalBox;
  private readonly titleBox: GridCompletionModalLike;
  private readonly screen: GridScreenLike;
  private readonly starField: FallingStarField;
  private readonly getContent: (starRows: string[][]) => string;
  private animationTimer: ReturnType<typeof setInterval> | null = null;

  constructor({
    box,
    titleBox,
    screen,
    starField,
    getContent,
  }: {
    box: CompletionModalBox;
    titleBox: GridCompletionModalLike;
    screen: GridScreenLike;
    starField: FallingStarField;
    getContent: (starRows: string[][]) => string;
  }) {
    this.box = box;
    this.titleBox = titleBox;
    this.screen = screen;
    this.starField = starField;
    this.getContent = getContent;
    this.animationTimer = setInterval(() => {
      this.starField.tick(COMPLETION_CONFETTI_INTERVAL_MS);
      this.box.setContent(this.getContent(this.starField.rows));
      (this.screen as FullscreenScreen).render();
    }, COMPLETION_CONFETTI_INTERVAL_MS);
  }

  destroy(): void {
    if (this.animationTimer) {
      clearInterval(this.animationTimer);
      this.animationTimer = null;
    }
    this.titleBox.destroy();
    this.box.destroy();
  }
}

type ModalTextLine = {
  text: string;
  align?: "left" | "center";
};

function renderCompletionModalLayers({
  width,
  textLines,
  textPadding = 0,
  starRows,
}: {
  width: number;
  textLines: ModalTextLine[];
  textPadding?: number;
  starRows?: string[][];
}): string[] {
  const height = textLines.length;
  const background =
    starRows?.slice(0, height) ?? new FallingStarField(width, height).rows;

  return textLines.map(({ text, align = "left" }, row) => {
    const cells = (background[row] ?? []).slice(0, width);
    if (stripBlessedTags(text).length === 0) {
      return trimTrailingSpaces(cells.join(""));
    }

    // Overlay the (tag-bearing) text onto the confetti row by removing exactly
    // the columns the text covers — `visibleLength` cells, each one column wide
    // — and splicing the text into the gap. Removing precisely as many cells as
    // the text is wide keeps every composed row at most `width` columns, so it
    // never wraps. (Earlier code capped the removal at an inner padded width
    // while still inserting the full text, so any line wider than that padding
    // overflowed and wrapped, jumping the text between frames.)
    const visibleLength = stringWidth(stripBlessedTags(text));
    const left =
      align === "center"
        ? Math.max(Math.floor((width - visibleLength) / 2), 0)
        : Math.min(textPadding, Math.max(width - visibleLength, 0));
    const right = Math.min(left + visibleLength, width);
    return trimTrailingSpaces(
      [...cells.slice(0, left), text, ...cells.slice(right)].join(""),
    );
  });
}

function trimTrailingSpaces(line: string): string {
  return line.replace(/\s+$/u, "");
}

class FallingStarField {
  readonly width: number;
  readonly height: number;
  private readonly pieces: FallingStarPiece[];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    const pieceCount = getConfettiPieceCount(width, height);
    const initialRows = getInitialConfettiRows(pieceCount, height);
    this.pieces = Array.from({ length: pieceCount }, (_, index) =>
      createFallingStarPiece({
        slot: index,
        slotCount: pieceCount,
        width,
        initialY: initialRows[index] ?? 0,
      }),
    );
  }

  get rows(): string[][] {
    const rows = Array.from({ length: this.height }, () =>
      Array.from({ length: this.width }, () => " "),
    );
    for (const piece of this.pieces) {
      const row = Math.floor(piece.y);
      const column = Math.floor(piece.x);
      if (row < 0 || row >= this.height || column < 0 || column >= this.width) {
        continue;
      }
      const targetRow = rows[row];
      if (targetRow) {
        targetRow[column] = renderStarCell(piece);
      }
    }
    return rows;
  }

  tick(elapsedMs: number): void {
    for (const piece of this.pieces) {
      piece.directionElapsedMs += elapsedMs;
      if (piece.directionElapsedMs >= piece.directionChangeMs) {
        piece.direction = getConfettiDirection(piece);
        piece.directionElapsedMs = 0;
        piece.directionChangeMs = getRandomDirectionChangeMs();
      }

      piece.fallElapsedMs += elapsedMs;
      while (piece.fallElapsedMs >= piece.fallMs) {
        piece.fallElapsedMs -= piece.fallMs;
        piece.y += 1;
        piece.x = clamp(piece.x + piece.direction, 0, this.width - 1);
        if (piece.x - piece.originX > piece.horizontalRange) {
          piece.direction = -1;
          piece.x = clamp(
            piece.originX + piece.horizontalRange,
            0,
            this.width - 1,
          );
        } else if (piece.originX - piece.x > piece.horizontalRange) {
          piece.direction = 1;
          piece.x = clamp(
            piece.originX - piece.horizontalRange,
            0,
            this.width - 1,
          );
        }
        if (COMPLETION_CONFETTI_CHARACTER_SAMPLING === "cycle") {
          piece.particleIndex =
            (piece.particleIndex + 1) % confettiGlyphs().length;
        }
      }

      if (piece.y >= this.height) {
        this.resetPiece(piece);
      }
    }
  }

  private resetPiece(piece: FallingStarPiece): void {
    Object.assign(
      piece,
      createFallingStarPiece({
        slot: piece.slot,
        slotCount: this.pieces.length,
        width: this.width,
        initialY: 0,
      }),
    );
  }
}

type FallingStarPiece = {
  slot: number;
  x: number;
  originX: number;
  y: number;
  fallMs: number;
  fallElapsedMs: number;
  horizontalRange: number;
  direction: -1 | 1;
  directionChangeMs: number;
  directionElapsedMs: number;
  particleIndex: number;
  color: string;
};

function createFallingStarPiece({
  slot,
  slotCount,
  width,
  initialY,
}: {
  slot: number;
  slotCount: number;
  width: number;
  initialY: number;
}): FallingStarPiece {
  const x = getConfettiSlotColumn({ slot, slotCount, width });
  return {
    slot,
    x,
    originX: x,
    y: initialY,
    fallMs: getRandomFallMs(),
    fallElapsedMs: 0,
    horizontalRange: Math.min(
      COMPLETION_CONFETTI_HORIZONTAL_RANGE,
      Math.max(1, 4),
    ),
    direction: getRandomHorizontalDirection(),
    directionChangeMs: getRandomDirectionChangeMs(),
    directionElapsedMs: 0,
    particleIndex: getRandomParticleIndex(),
    color: getRandomStarColor(),
  };
}

function getConfettiPieceCount(width: number, height: number): number {
  const volume = width * height;
  return clamp(
    Math.round(volume / COMPLETION_CONFETTI_CELLS_PER_PIECE),
    Math.min(width, 4),
    Math.min(width, 48),
  );
}

function getInitialConfettiRows(pieceCount: number, height: number): number[] {
  if (height <= 1) return Array.from({ length: pieceCount }, () => 0);
  const rows = Array.from({ length: pieceCount }, (_, index) =>
    Math.floor((index / pieceCount) * height),
  );
  for (let i = rows.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    const current = rows[i] ?? 0;
    rows[i] = rows[j] ?? current;
    rows[j] = current;
  }
  return rows;
}

function getConfettiSlotColumn({
  slot,
  slotCount,
  width,
}: {
  slot: number;
  slotCount: number;
  width: number;
}): number {
  const baseColumn =
    slotCount === 1 ? 0 : Math.round((slot / (slotCount - 1)) * (width - 1));
  const slotWidth = slotCount === 0 ? width : width / slotCount;
  const jitter = Math.min(
    COMPLETION_CONFETTI_HORIZONTAL_JITTER,
    Math.max(0, Math.floor((slotWidth - 1) / 2)),
  );
  return clamp(baseColumn + randomInt(-jitter, jitter), 0, width - 1);
}

function renderStarCell(piece: FallingStarPiece): string {
  const particle = confettiGlyphs()[piece.particleIndex];
  return `{${piece.color}-fg}${particle}{/${piece.color}-fg}`;
}

function getRandomParticleIndex(): number {
  return Math.floor(Math.random() * confettiGlyphs().length);
}

function getRandomStarColor(): string {
  const palette = confettiColorTokens();
  // Fall back to a theme token (never a hardcoded color) if a theme somehow
  // ships an empty confetti palette.
  return (
    palette[Math.floor(Math.random() * palette.length)] ??
    palette[0] ??
    colors().focus
  );
}

function getRandomHorizontalDirection(): -1 | 1 {
  return Math.random() < 0.5 ? -1 : 1;
}

function getRandomFallMs(): number {
  const range =
    COMPLETION_CONFETTI_FALL_MAX_MS - COMPLETION_CONFETTI_FALL_MIN_MS;
  const center = Math.random() < 0.5 ? 0.25 : 0.75;
  const mean = COMPLETION_CONFETTI_FALL_MIN_MS + range * center;
  return getNormalSampleInRange({
    min: COMPLETION_CONFETTI_FALL_MIN_MS,
    max: COMPLETION_CONFETTI_FALL_MAX_MS,
    mean,
    standardDeviation: range / 12,
  });
}

function getNormalSampleInRange({
  min,
  max,
  mean,
  standardDeviation,
}: {
  min: number;
  max: number;
  mean: number;
  standardDeviation: number;
}): number {
  const u1 = Math.max(Math.random(), Number.EPSILON);
  const u2 = Math.random();
  const standardNormal =
    Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.round(clamp(mean + standardNormal * standardDeviation, min, max));
}

function getConfettiDirection(piece: FallingStarPiece): -1 | 1 {
  if (piece.x - piece.originX >= piece.horizontalRange) return -1;
  if (piece.originX - piece.x >= piece.horizontalRange) return 1;
  return getRandomHorizontalDirection();
}

function getRandomDirectionChangeMs(): number {
  return randomInt(
    COMPLETION_CONFETTI_DIRECTION_CHANGE_MIN_MS,
    COMPLETION_CONFETTI_DIRECTION_CHANGE_MAX_MS,
  );
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatWorkspaceSummary({
  workspacePath,
  worktreeNames,
  contentWidth,
}: {
  workspacePath?: string;
  worktreeNames: string[];
  contentWidth: number;
}): string[] {
  const lines: string[] = [];
  if (workspacePath) {
    lines.push(
      renderBlessedLine([
        terminalSpan(
          truncatePlainText(
            compactHome(workspacePath),
            Math.max(contentWidth, 8),
          ),
          {
            role: "primary",
            emphasis: "bold",
          },
        ),
      ]),
    );
  }

  for (const worktreeName of worktreeNames.slice(0, 6)) {
    lines.push(
      renderBlessedLine([
        terminalSpan("•", { role: "focus" }),
        " ",
        terminalSpan(
          truncatePlainText(worktreeName, Math.max(contentWidth - 2, 8)),
          {
            emphasis: "bold",
          },
        ),
      ]),
    );
  }
  if (worktreeNames.length > 6) {
    lines.push(
      renderBlessedLine([
        "  ",
        terminalSpan(`+${worktreeNames.length - 6} more`, { role: "muted" }),
      ]),
    );
  }
  return lines;
}

function stripBlessedTags(value: string): string {
  return value.replace(/\{[^}]*\}/g, "");
}

function truncatePlainText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(maxLength - 1, 0))}…`;
}

function formatCompletionFailures(
  failures: GridCompletionFailure[],
  label: string,
): string[] {
  if (failures.length === 0) return [];

  const visibleFailures = failures.slice(0, 3);
  const lines = [paneMessage(label, "warning")];
  for (const failure of visibleFailures) {
    const step = failure.step ? ` (${failure.step})` : "";
    lines.push(renderBlessedLine(["• ", failure.repoName, step]));
    lines.push(renderBlessedLine(["  ", failure.message]));
  }
  if (failures.length > visibleFailures.length) {
    lines.push(
      renderBlessedLine(`  +${failures.length - visibleFailures.length} more`),
    );
  }
  return lines;
}

function recordCompletionFailure(
  repoName: string,
  state: Extract<RepoPipelineState, { phase: "failed" }>,
  failures: {
    setupWarnings: GridCompletionFailure[];
    repoErrors: GridCompletionFailure[];
  },
): void {
  const failure = {
    repoName,
    ...(state.step ? { step: state.step } : {}),
    message: state.error.message,
  };

  if (state.step?.startsWith("initializer:")) {
    failures.setupWarnings.push(failure);
  } else {
    failures.repoErrors.push(failure);
  }
}
