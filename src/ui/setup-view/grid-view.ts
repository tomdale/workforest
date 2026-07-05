/**
 * The interactive setup grid: renders a run's event stream as a paged,
 * zoomable grid of per-repo panes with a status line footer. Rendering is
 * rebuild-from-snapshot: every throttled frame recomputes pane content from
 * the reduced snapshot, which makes resize reflow, zoom, and paging trivially
 * correct because no pane accumulates append-only state.
 *
 * All terminal specifics live behind {@link SetupViewEnvironment}, mirroring
 * the GridRenderEnvironment pattern, so the whole interaction model is
 * vitest-testable without a TTY.
 */

import { Box } from "@unblessed/node";
import {
  createFullscreenScreen,
  createFullscreenStage,
  createFullscreenStatusLine,
  type FullscreenScreen,
  fullTerminalViewport,
} from "../../terminal/fullscreen-surface.ts";
import { activeTheme, toBlessed } from "../../terminal/theme-system.ts";
import type { RunEvent } from "../../workspace/run-log/events.ts";
import {
  createRunReducer,
  type RepoRunSnapshot,
  type RunSnapshot,
} from "../../workspace/run-log/reducer.ts";
import {
  createDefaultCompletionModal,
  type GridScreenLike,
} from "../grid-consumer.ts";
import { GridLayout } from "../grid-layout.ts";
import {
  buildHelpLines,
  buildStatusLine,
  paneLabel,
  renderPaneLines,
  type SetupViewMode,
  WORKSPACE_PANE_NAME,
  workspacePaneSnapshot,
} from "./model.ts";
import {
  computeGridCapacity,
  fitGridDimensions,
  panePriorityForStatus,
  selectVisiblePanes,
} from "./pager.ts";
import { TerminalTailStore } from "./terminal-tail.ts";

export type SetupKeyEvent = Readonly<{ name?: string; ctrl?: boolean }>;

export interface SetupPaneLike {
  setLabel(label: string): void;
  setContent(content: string): void;
  setFocused?(focused: boolean): void;
  getContentSize?(): { width: number; height: number };
}

export interface SetupGridLike {
  getPane(index: number): SetupPaneLike | undefined;
  reflow?(): void;
  setZoomedPane?(index: number | null): void;
  setVisiblePane?(index: number): void;
  hidePane?(index: number): void;
  render(): void;
  destroy(): void;
}

export interface SetupScreenLike {
  onKeypress(
    handler: (ch: string | undefined, key: SetupKeyEvent | undefined) => void,
  ): void;
  onResize?(handler: () => void): void;
  /** Terminal size in cells; drives pane capacity and grid shape. */
  getSize?(): { width: number; height: number };
  render(): void;
  destroy(): void;
}

export interface SetupStatusLineLike {
  setContent(content: string): void;
  destroy(): void;
}

export type SetupFailureSummary = Readonly<{
  repoName: string;
  step?: string;
  message: string;
}>;

export type SetupCompletionModalOptions = Readonly<{
  targetDir?: string;
  worktreeNames: readonly string[];
  completedCount: number;
  totalCount: number;
  failures: readonly SetupFailureSummary[];
}>;

export interface SetupCompletionModalLike {
  destroy(): void;
}

export interface SetupHelpOverlayLike {
  destroy(): void;
}

export interface SetupViewEnvironment {
  createScreen(): SetupScreenLike;
  createGrid(options: {
    screen: SetupScreenLike;
    rows: number;
    cols: number;
  }): SetupGridLike;
  createStatusLine?(options: { screen: SetupScreenLike }): SetupStatusLineLike;
  createCompletionModal?(
    options: SetupCompletionModalOptions,
  ): SetupCompletionModalLike;
  createHelpOverlay?(options: {
    lines: readonly string[];
  }): SetupHelpOverlayLike;
  renderIntervalMs?: number;
  now?(): number;
}

export type SetupGridOutcome =
  | "ready"
  | "failed"
  | "cancelled"
  | "detached"
  | "quit"
  | "aborted";

export type RenderSetupGridOptions = Readonly<{
  /** The run's merged event stream; must end at (or after) `run-end`. */
  events: AsyncGenerator<RunEvent>;
  repoNames: readonly string[];
  mode: SetupViewMode;
  targetDir?: string;
  /** Allow `d` to detach (until-ready mode only). Defaults to true. */
  canDetach?: boolean;
  /** Invoked on the first Ctrl-C/q press in until-ready mode. */
  onCancelRequest?: () => void | Promise<void>;
  /** Second Ctrl-C press handler; defaults to process.exit. */
  forceExit?: (code: number) => void;
  /** Resolving this promise ends the grid (e.g. the driver failed). */
  abort?: Promise<void>;
  environment?: SetupViewEnvironment;
}>;

export type SetupGridResult = Readonly<{
  outcome: SetupGridOutcome;
  snapshot: RunSnapshot;
}>;

const DEFAULT_RENDER_INTERVAL_MS = 33;
const ELAPSED_TICK_MS = 1_000;

/** Sizing fallback for environments that expose no terminal size. */
const DEFAULT_VIEWPORT = { width: 120, height: 40 } as const;

/**
 * Render a setup run until it reaches a terminal state (or the user detaches,
 * cancels, or quits). Returns the outcome plus the final reduced snapshot so
 * callers can print the persistent scrollback summary after teardown.
 */
export async function renderSetupGrid(
  options: RenderSetupGridOptions,
): Promise<SetupGridResult> {
  const environment =
    options.environment ?? createDefaultSetupViewEnvironment();
  const now = environment.now ?? Date.now;
  const renderIntervalMs =
    environment.renderIntervalMs ?? DEFAULT_RENDER_INTERVAL_MS;
  const mode = options.mode;
  const canDetach = mode === "until-ready" && (options.canDetach ?? true);
  const forceExit =
    options.forceExit ??
    ((code: number): void => {
      process.exit(code);
    });

  const reducer = createRunReducer();
  // Replays the same events through a headless VT100 emulator so panes can
  // render the live styled screen instead of the reducer's plain tail; see
  // TerminalTailStore's own doc comment for why a second pass is needed.
  const tailStore = new TerminalTailStore();
  const screen = environment.createScreen();
  // Created lazily on the first frame, after the grid: terminal surfaces
  // paint in creation order, so a status line created before the grid's
  // full-screen backdrop would be buried under it.
  let statusLine: SetupStatusLineLike | null = null;

  let grid: SetupGridLike | null = null;
  let gridShape: { rows: number; cols: number } | null = null;
  let gridSlots = 0;
  let modal: SetupCompletionModalLike | null = null;

  let page = 0;
  let focusIndex = 0;
  let zoomedPane: string | null = null;
  let cancelRequested = false;
  let lastVisible: string[] = [];
  let lastPageCount = 1;
  let helpOverlay: SetupHelpOverlayLike | null = null;
  // Set once the run reaches a terminal state and the completion modal is
  // about to swallow every key. Guards renderFrame from recreating a status
  // line the modal has already made moot (see its destroy below).
  let terminalStateReached = false;

  const closeHelp = (): void => {
    helpOverlay?.destroy();
    helpOverlay = null;
  };

  // A named closure rather than an inline `statusLine?.destroy()` at the
  // call site: TS narrows a closured `let` that only nested functions
  // reassign down to the type of its last direct assignment in the reading
  // scope, which for `statusLine` is the initial `null` — so the outer scope
  // sees it as exactly `null` (not `SetupStatusLineLike | null`) after
  // renderFrame's lazy creation has run, and `.destroy()` fails to typecheck.
  // Reading it from its own closure, like `destroy()` already does, sidesteps
  // that by using the declared type instead.
  const hideStatusLine = (): void => {
    statusLine?.destroy();
    statusLine = null;
  };

  const toggleHelp = (): void => {
    if (helpOverlay) {
      closeHelp();
      screen.render();
      return;
    }
    helpOverlay =
      environment.createHelpOverlay?.({
        lines: buildHelpLines({ mode, canDetach }),
      }) ?? null;
    if (helpOverlay) screen.render();
  };

  let destroyed = false;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  let ackResolve: (() => void) | null = null;

  let finish: (outcome: "detached" | "quit") => void = () => undefined;
  const finished = new Promise<"detached" | "quit">((resolve) => {
    finish = (outcome) => resolve(outcome);
  });

  const paneSnapshotOf = (
    snapshot: RunSnapshot,
    name: string,
  ): RepoRunSnapshot => {
    if (name === WORKSPACE_PANE_NAME) {
      const workspace = workspacePaneSnapshot(snapshot);
      if (workspace) return workspace;
    }
    return (
      snapshot.repos.get(name) ?? {
        repo: name,
        status: "pending",
        steps: [],
        tail: [],
      }
    );
  };

  const paneOrderOf = (snapshot: RunSnapshot): string[] => {
    const names = [...options.repoNames];
    for (const name of snapshot.repos.keys()) {
      if (!names.includes(name)) names.push(name);
    }
    if (workspacePaneSnapshot(snapshot) !== null) {
      names.push(WORKSPACE_PANE_NAME);
    }
    return names;
  };

  const ensureGrid = (dims: { rows: number; cols: number }): SetupGridLike => {
    if (
      grid &&
      gridShape &&
      gridShape.rows === dims.rows &&
      gridShape.cols === dims.cols
    ) {
      return grid;
    }
    grid?.destroy();
    grid = environment.createGrid({
      screen,
      rows: dims.rows,
      cols: dims.cols,
    });
    gridShape = dims;
    gridSlots = dims.rows * dims.cols;
    return grid;
  };

  const renderFrame = (): void => {
    if (destroyed) return;
    dirty = false;
    const nowMs = now();
    const snapshot = reducer.snapshot();
    const order = paneOrderOf(snapshot);
    const bounds = computeGridCapacity(screen.getSize?.() ?? DEFAULT_VIEWPORT);
    const selection = selectVisiblePanes({
      order,
      priorityOf: (name) =>
        panePriorityForStatus(paneSnapshotOf(snapshot, name).status),
      page,
      capacity: bounds.capacity,
    });
    page = selection.page;

    let visible: readonly string[];
    let pageCount: number;
    if (
      zoomedPane !== null &&
      lastVisible.includes(zoomedPane) &&
      lastVisible.length <= bounds.capacity
    ) {
      // Freeze the pane assignment while zoomed so priority reshuffles do
      // not swap the pane out from under the user. A resize that shrinks
      // capacity below the frozen set drops the freeze so panes always fit.
      visible = lastVisible;
      pageCount = lastPageCount;
    } else {
      visible = selection.visible;
      pageCount = selection.pageCount;
      lastVisible = [...selection.visible];
      lastPageCount = selection.pageCount;
      if (zoomedPane !== null && !visible.includes(zoomedPane)) {
        zoomedPane = null;
      }
    }
    focusIndex = Math.min(focusIndex, Math.max(visible.length - 1, 0));

    const activeGrid = ensureGrid(
      fitGridDimensions(Math.max(visible.length, 1), bounds),
    );
    // Once the completion modal is up it swallows every key, so recreating
    // the status line (e.g. on a resize) would show hints and a ticking
    // elapsed time that nothing can act on.
    if (!terminalStateReached) {
      statusLine ??= environment.createStatusLine?.({ screen }) ?? null;
    }
    const zoomIndex = zoomedPane !== null ? visible.indexOf(zoomedPane) : -1;
    activeGrid.setZoomedPane?.(zoomIndex >= 0 ? zoomIndex : null);
    for (let index = 0; index < gridSlots; index += 1) {
      if (index < visible.length) {
        activeGrid.setVisiblePane?.(index);
      } else {
        activeGrid.hidePane?.(index);
      }
    }

    visible.forEach((name, index) => {
      const pane = activeGrid.getPane(index);
      if (!pane) return;
      const paneSnapshot = paneSnapshotOf(snapshot, name);
      pane.setLabel(paneLabel(paneSnapshot, nowMs));
      const size = pane.getContentSize?.() ?? { width: 60, height: 12 };
      pane.setContent(
        renderPaneLines(
          paneSnapshot,
          size,
          nowMs,
          tailStore.linesFor(name),
        ).join("\n"),
      );
      pane.setFocused?.(index === focusIndex && visible.length > 1);
    });

    if (!terminalStateReached) {
      statusLine?.setContent(
        buildStatusLine({
          snapshot,
          repoNames: options.repoNames,
          page,
          pageCount,
          zoomed: zoomedPane !== null,
          mode,
          canDetach,
          cancelRequested,
          nowMs,
        }),
      );
    }

    activeGrid.render();
  };

  const scheduleRender = (): void => {
    if (destroyed) return;
    dirty = true;
    if (renderIntervalMs <= 0) {
      renderFrame();
      return;
    }
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      if (dirty) renderFrame();
    }, renderIntervalMs);
  };

  // Live elapsed times tick even when no events arrive. Disabled alongside
  // render throttling (renderIntervalMs <= 0) so tests stay deterministic.
  // Cleared early once the run hits a terminal state: the completion modal
  // freezes the display and nothing should keep ticking behind it.
  const ticker =
    renderIntervalMs > 0
      ? setInterval(() => {
          scheduleRender();
        }, ELAPSED_TICK_MS)
      : null;
  ticker?.unref?.();

  const moveFocus = (delta: number): void => {
    const count = Math.max(lastVisible.length, 1);
    focusIndex = Math.min(Math.max(focusIndex + delta, 0), count - 1);
    scheduleRender();
  };

  const keyNameOf = (
    ch: string | undefined,
    key: SetupKeyEvent | undefined,
  ): string | null => {
    if (key?.ctrl && key.name === "c") return "ctrl-c";
    // "?" arrives as the character of a shifted "/" keypress, so the char is
    // the reliable signal rather than the key name.
    if (ch === "?") return "?";
    const name = key?.name ?? ch;
    if (name === "return" || name === "linefeed") return "enter";
    return name ?? null;
  };

  screen.onKeypress((ch, key) => {
    if (destroyed) return;
    if (ackResolve) {
      const resolve = ackResolve;
      ackResolve = null;
      resolve();
      return;
    }

    const name = keyNameOf(ch, key);

    if (helpOverlay && name !== "?") {
      // Any key dismisses the help overlay; the keypress is consumed so a
      // stray "q" while reading the keymap cannot cancel the run.
      closeHelp();
      screen.render();
      return;
    }

    switch (name) {
      case "?":
        toggleHelp();
        break;
      case "left":
      case "h":
        moveFocus(-1);
        break;
      case "right":
      case "l":
        moveFocus(1);
        break;
      case "up":
      case "k":
        moveFocus(-(gridShape?.cols ?? 1));
        break;
      case "down":
      case "j":
        moveFocus(gridShape?.cols ?? 1);
        break;
      case "enter":
        if (zoomedPane === null) {
          zoomedPane = lastVisible[focusIndex] ?? null;
          scheduleRender();
        }
        break;
      case "z":
        zoomedPane =
          zoomedPane === null ? (lastVisible[focusIndex] ?? null) : null;
        scheduleRender();
        break;
      case "escape":
        if (zoomedPane !== null) {
          zoomedPane = null;
          scheduleRender();
        } else if (mode === "watch") {
          finish("quit");
        }
        break;
      case "[":
        page = Math.max(page - 1, 0);
        focusIndex = 0;
        scheduleRender();
        break;
      case "]":
        page += 1;
        focusIndex = 0;
        scheduleRender();
        break;
      case "d":
        if (canDetach && !cancelRequested) {
          finish("detached");
        }
        break;
      case "q":
      case "ctrl-c":
        if (mode === "watch") {
          finish("quit");
          break;
        }
        if (!cancelRequested) {
          cancelRequested = true;
          void Promise.resolve(options.onCancelRequest?.()).catch(
            () => undefined,
          );
          scheduleRender();
        } else {
          forceExit(130);
        }
        break;
      default:
        break;
    }
  });

  screen.onResize?.(() => {
    if (destroyed) return;
    grid?.reflow?.();
    scheduleRender();
  });

  const waitForKeypress = (): Promise<void> =>
    new Promise((resolve) => {
      ackResolve = resolve;
    });

  const failuresOf = (snapshot: RunSnapshot): SetupFailureSummary[] =>
    [...snapshot.repos.values()]
      .filter((repo) => repo.status === "failed")
      .map((repo) => ({
        repoName: repo.repo,
        ...(repo.failedStep !== undefined ? { step: repo.failedStep } : {}),
        message: repo.error ?? "Repository setup failed.",
      }));

  const showCompletionModal = (snapshot: RunSnapshot): void => {
    closeHelp();
    const failures = failuresOf(snapshot);
    modal =
      environment.createCompletionModal?.({
        ...(options.targetDir !== undefined
          ? { targetDir: options.targetDir }
          : {}),
        worktreeNames: options.repoNames.filter(
          (name) => snapshot.repos.get(name)?.status !== "failed",
        ),
        completedCount: options.repoNames.filter(
          (name) => snapshot.repos.get(name)?.status === "ready",
        ).length,
        totalCount: options.repoNames.length,
        failures,
      }) ?? null;
    screen.render();
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    if (ticker) clearInterval(ticker);
    closeHelp();
    modal?.destroy();
    modal = null;
    statusLine?.destroy();
    grid?.destroy();
    grid = null;
    screen.destroy();
    tailStore.dispose();
    void Promise.resolve(options.events.return(undefined)).catch(
      () => undefined,
    );
  };

  let runEnded = false;
  const pump = (async (): Promise<void> => {
    for await (const event of options.events) {
      reducer.apply(event);
      await tailStore.apply(event);
      scheduleRender();
      if (event.kind === "run-end") {
        runEnded = true;
        return;
      }
    }
  })();

  try {
    renderFrame();

    const raced = await Promise.race([
      pump.then(() => ({ kind: "pump" as const })),
      finished.then((outcome) => ({ kind: "finish" as const, outcome })),
      ...(options.abort
        ? [options.abort.then(() => ({ kind: "abort" as const }))]
        : []),
    ]);

    if (raced.kind === "finish") {
      return { outcome: raced.outcome, snapshot: reducer.snapshot() };
    }
    if (raced.kind === "abort") {
      return { outcome: "aborted", snapshot: reducer.snapshot() };
    }

    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    // Drain any writes still parsing so the last frame reflects fully
    // processed output rather than whatever had landed mid-chunk.
    await tailStore.flush();
    renderFrame();
    const snapshot = reducer.snapshot();
    const outcome = resolveOutcome(snapshot, cancelRequested, runEnded);

    if (outcome === "cancelled" || outcome === "aborted") {
      return { outcome, snapshot };
    }

    // Terminal state: keep the grid and completion modal up until the user
    // dismisses them, so both the celebration and failure panes stay readable
    // for as long as anyone wants to look. The modal swallows every key from
    // here on, so the status line's hints and ticking elapsed time would be
    // dead and misleading if left running behind it.
    terminalStateReached = true;
    if (ticker) clearInterval(ticker);
    hideStatusLine();
    showCompletionModal(snapshot);
    await Promise.race([waitForKeypress(), finished]);
    return { outcome, snapshot };
  } finally {
    destroy();
    void pump.catch(() => undefined);
  }
}

function resolveOutcome(
  snapshot: RunSnapshot,
  cancelRequested: boolean,
  runEnded: boolean,
): SetupGridOutcome {
  if (cancelRequested) return "cancelled";
  if (snapshot.outcome === "ready") return "ready";
  if (snapshot.outcome === "failed") return "failed";
  if (snapshot.outcome === "cancelled") return "cancelled";
  if (!runEnded) {
    const repos = [...snapshot.repos.values()];
    if (repos.some((repo) => repo.status === "failed")) return "failed";
    if (repos.length > 0 && repos.every((repo) => repo.status === "ready")) {
      return "ready";
    }
    return "aborted";
  }
  return "failed";
}

function createDefaultSetupViewEnvironment(): SetupViewEnvironment {
  const theme = activeTheme();
  const border = toBlessed(theme.chrome.border);
  const focus = toBlessed(theme.palette.focus);
  const background = toBlessed(theme.chrome.background);

  let rawScreen: FullscreenScreen | null = null;
  let stage: Box | null = null;

  const axis = (
    value: number | string | undefined,
    fallback: number,
  ): number =>
    Number.isFinite(Number(value)) && Number(value) > 0
      ? Math.floor(Number(value))
      : fallback;

  return {
    createScreen(): SetupScreenLike {
      const screen = createFullscreenScreen();
      rawScreen = screen;
      return {
        onKeypress: (handler) => {
          screen.on(
            "keypress",
            (ch: string | undefined, key: SetupKeyEvent | undefined) => {
              handler(ch, key);
            },
          );
        },
        onResize: (handler) => {
          screen.on("resize", handler);
        },
        getSize: () => ({
          width: axis(screen.width, DEFAULT_VIEWPORT.width),
          height: axis(screen.height, DEFAULT_VIEWPORT.height),
        }),
        render: () => screen.render(),
        destroy: () => screen.destroy(),
      };
    },
    createGrid({ rows, cols }): SetupGridLike {
      const screen = rawScreen;
      if (!screen) {
        throw new Error("createGrid called before createScreen.");
      }
      // One stage for the whole run, shared across grid reshapes. A fresh
      // stage per grid would stack a new full-screen backdrop over surfaces
      // created earlier (the status line), burying them; the shared stage is
      // torn down with the screen.
      stage ??= createFullscreenStage(screen, fullTerminalViewport);
      const grid = new GridLayout({
        screen,
        parent: stage,
        rows,
        cols,
        top: 0,
        left: 0,
        width: "100%",
        height: "100%-1",
        borderColor: border,
        focusBorderColor: focus,
        backgroundColor: background,
        contentColor: toBlessed(theme.palette.dim),
        focusContentColor: toBlessed(theme.palette.focus),
      });
      return {
        getPane: (index) => grid.getPane(index),
        reflow: () => grid.reflow(),
        setZoomedPane: (index) => grid.setZoomedPane(index),
        setVisiblePane: (index) => grid.setVisiblePane(index),
        hidePane: (index) => grid.hidePane(index),
        render: () => screen.render(),
        destroy: () => grid.destroy(),
      };
    },
    createStatusLine(): SetupStatusLineLike {
      const screen = rawScreen;
      if (!screen) {
        throw new Error("createStatusLine called before createScreen.");
      }
      return createFullscreenStatusLine(screen);
    },
    createCompletionModal(
      modalOptions: SetupCompletionModalOptions,
    ): SetupCompletionModalLike {
      const screen = rawScreen;
      if (!screen) {
        throw new Error("createCompletionModal called before createScreen.");
      }
      return createDefaultCompletionModal({
        screen: screen as GridScreenLike,
        ...(modalOptions.targetDir !== undefined
          ? { workspacePath: modalOptions.targetDir }
          : {}),
        worktreeNames: [...modalOptions.worktreeNames],
        completedCount: modalOptions.completedCount,
        totalCount: modalOptions.totalCount,
        setupWarnings: [],
        repoErrors: modalOptions.failures.map((failure) => ({
          repoName: failure.repoName,
          ...(failure.step !== undefined ? { step: failure.step } : {}),
          message: failure.message,
        })),
      });
    },
    createHelpOverlay({ lines }): SetupHelpOverlayLike {
      const screen = rawScreen;
      if (!screen) {
        throw new Error("createHelpOverlay called before createScreen.");
      }
      const stripTags = (value: string): string =>
        value.replace(/\{[^}]*\}/g, "");
      const contentWidth = Math.max(
        ...lines.map((line) => stripTags(line).length),
        10,
      );
      const width = Math.min(
        contentWidth + 6,
        Math.max(axis(screen.width, DEFAULT_VIEWPORT.width) - 4, 20),
      );
      const height = Math.min(
        lines.length + 2,
        Math.max(axis(screen.height, DEFAULT_VIEWPORT.height) - 2, 5),
      );
      const box = new Box({
        parent: screen,
        top: Math.max(
          Math.floor(
            (axis(screen.height, DEFAULT_VIEWPORT.height) - height) / 2,
          ),
          0,
        ),
        left: Math.max(
          Math.floor((axis(screen.width, DEFAULT_VIEWPORT.width) - width) / 2),
          0,
        ),
        width,
        height,
        tags: true,
        wrap: false,
        border: { type: "line", style: "round" },
        padding: { top: 0, bottom: 0, left: 2, right: 2 },
        content: lines.join("\n"),
        style: {
          fg: toBlessed(theme.palette.primary),
          bg: background,
          border: { fg: focus, bg: background },
        },
      });
      return { destroy: () => box.destroy() };
    },
    renderIntervalMs: DEFAULT_RENDER_INTERVAL_MS,
  };
}
