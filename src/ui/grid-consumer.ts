import {
  Box,
  type BoxOptions,
  type Screen as UnblessedScreen,
} from "@unblessed/node";
import stringWidth from "string-width";
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
import { fullscreenColor } from "../terminal/theme.ts";
import { runParallel } from "../utils/task-generator.ts";
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
  environment?: GridRenderEnvironment;
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
const COMPLETION_CONFETTI_PARTICLES = ["◜", "◝", "◞", "◟"] as const;
const COMPLETION_CONFETTI_COLORS = [
  "cyan",
  "green",
  "yellow",
  "magenta",
  "blue",
  "white",
] as const;
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
        borderColor: fullscreenColor.accent,
      }),
    createStatusLine: ({ screen }) =>
      createFullscreenStatusLine(
        screen as FullscreenScreen,
      ) as FullscreenStatusLine,
    createCompletionModal: createDefaultCompletionModal,
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
  workspacePath,
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
  const setupWarnings: GridCompletionFailure[] = [];
  const repoErrors: GridCompletionFailure[] = [];
  let pendingRender: Promise<void> | null = null;
  let pendingRenderTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  let awaitingCompletionAck = false;
  let completionModal: GridCompletionModalLike | null = null;

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
          recordCompletionFailure(id, state, {
            setupWarnings,
            repoErrors,
          });
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

    statusLine?.setContent("");
    completionModal =
      environment.createCompletionModal?.({
        screen,
        ...(workspacePath ? { workspacePath } : {}),
        worktreeNames: repoNames.filter(
          (repoName) =>
            !repoErrors.some((failure) => failure.repoName === repoName),
        ),
        completedCount: repoResults.size,
        totalCount: repoNames.length,
        setupWarnings,
        repoErrors,
      }) ?? null;
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

export function createDefaultCompletionModal({
  screen,
  workspacePath,
  worktreeNames,
  completedCount,
  totalCount,
  setupWarnings,
  repoErrors,
}: GridCompletionModalOptions): GridCompletionModalLike {
  const hasRepoErrors = repoErrors.length > 0;
  const hasSetupWarnings = setupWarnings.length > 0;
  const screenWidth = Number((screen as UnblessedScreen).width ?? 80);
  const screenHeight = Number((screen as UnblessedScreen).height ?? 24);
  const maxTextWidth = getCompletionModalMaxTextWidth({
    worktreeNames,
    setupWarnings,
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
    contentWidth,
    ...(workspacePath ? { workspacePath } : {}),
  });
  const height = Math.min(
    Math.max(contentLines.length + 2, hasRepoErrors ? 12 : 10),
    Math.max(10, screenHeight - 4),
  );
  const left = Math.max(0, Math.floor((screenWidth - width) / 2));
  const top = Math.max(1, Math.floor((screenHeight - height) / 2));

  const style: BoxOptions["style"] = hasRepoErrors
    ? {
        fg: fullscreenColor.primary,
        bg: "black",
        border: { fg: fullscreenColor.error },
      }
    : hasSetupWarnings
      ? {
          fg: fullscreenColor.primary,
          bg: "black",
          border: { fg: fullscreenColor.warning },
        }
      : {
          fg: fullscreenColor.primary,
          bg: "black",
          border: { fg: fullscreenColor.accent },
        };

  const box = new Box({
    parent: screen as UnblessedScreen,
    top,
    left,
    width,
    height,
    tags: true,
    border: { type: "line" },
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
}: {
  screen: GridScreenLike;
  left: number;
  top: number;
  width: number;
  title: string;
}): GridCompletionModalLike {
  return new Box({
    parent: screen as UnblessedScreen,
    top,
    left: left + Math.max(Math.floor((width - stringWidth(title)) / 2), 0),
    width: stringWidth(title),
    height: 1,
    content: title,
    tags: true,
    style: { fg: fullscreenColor.muted },
  }) as GridCompletionModalLike;
}

function getCompletionModalContent({
  completedCount,
  totalCount,
  workspacePath,
  worktreeNames,
  setupWarnings,
  repoErrors,
  contentWidth = 68,
  starRows,
}: Omit<GridCompletionModalOptions, "screen"> & {
  contentWidth?: number;
  starRows?: string[][];
}): string[] {
  if (repoErrors.length > 0) {
    return [
      "{red-fg}{bold}Repository setup needs attention{/bold}{/red-fg}",
      "",
      `${completedCount}/${totalCount} repositories completed. ${repoErrors.length} failed during git/worktree setup.`,
      "",
      ...formatCompletionFailures(repoErrors, "Repo errors"),
      ...formatCompletionFailures(setupWarnings, "Setup warnings"),
      "",
      "{gray-fg}Press any key for next steps{/gray-fg}",
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
}: {
  workspacePath?: string;
  worktreeNames: string[];
  setupWarnings: GridCompletionFailure[];
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
    text: "{bold}{cyan-fg}press any key{/cyan-fg}{/bold}",
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
    if (stripBlessedTags(text).length === 0) {
      return renderCells(background[row] ?? [], width);
    }

    const visibleLength = stringWidth(stripBlessedTags(text));
    const paddedWidth = Math.max(width - textPadding * 2, 1);
    const left =
      align === "center"
        ? Math.max(Math.floor((width - visibleLength) / 2), 0)
        : Math.min(textPadding, Math.max(width - visibleLength, 0));
    const replacementWidth =
      align === "center" ? visibleLength : Math.min(visibleLength, paddedWidth);
    const rowCells = background[row] ?? [];
    return renderCells(
      [
        ...rowCells.slice(0, left),
        text,
        ...rowCells.slice(Math.min(left + replacementWidth, width)),
      ],
      width,
    );
  });
}

function renderCells(cells: string[], width: number): string {
  const line = cells.join("");
  const trimmed = line.replace(/\s+$/u, "");
  const visibleWidth = stringWidth(stripBlessedTags(trimmed));
  if (visibleWidth <= width) return trimmed;
  return cells.slice(0, width).join("").replace(/\s+$/u, "");
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
            (piece.particleIndex + 1) % COMPLETION_CONFETTI_PARTICLES.length;
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
  color: (typeof COMPLETION_CONFETTI_COLORS)[number];
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
  const particle = COMPLETION_CONFETTI_PARTICLES[piece.particleIndex];
  return `{${piece.color}-fg}${particle}{/${piece.color}-fg}`;
}

function getRandomParticleIndex(): number {
  return Math.floor(Math.random() * COMPLETION_CONFETTI_PARTICLES.length);
}

function getRandomStarColor(): (typeof COMPLETION_CONFETTI_COLORS)[number] {
  return (
    COMPLETION_CONFETTI_COLORS[
      Math.floor(Math.random() * COMPLETION_CONFETTI_COLORS.length)
    ] ?? "cyan"
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
      `{bold}{white-fg}${escapeBlessedTags(
        truncatePlainText(workspacePath, Math.max(contentWidth, 8)),
      )}{/white-fg}{/bold}`,
    );
  }

  for (const worktreeName of worktreeNames.slice(0, 6)) {
    lines.push(
      `{cyan-fg}•{/cyan-fg} {bold}${escapeBlessedTags(
        truncatePlainText(worktreeName, Math.max(contentWidth - 2, 8)),
      )}{/bold}`,
    );
  }
  if (worktreeNames.length > 6) {
    lines.push(`  {gray-fg}+${worktreeNames.length - 6} more{/gray-fg}`);
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
  const lines = [`{yellow-fg}${label}{/yellow-fg}`];
  for (const failure of visibleFailures) {
    const step = failure.step ? ` (${failure.step})` : "";
    lines.push(
      `• ${escapeBlessedTags(failure.repoName)}${escapeBlessedTags(step)}`,
    );
    lines.push(`  ${escapeBlessedTags(failure.message)}`);
  }
  if (failures.length > visibleFailures.length) {
    lines.push(`  +${failures.length - visibleFailures.length} more`);
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
