import { Box, NodeRuntime, Screen, setRuntime } from "@unblessed/node";
import { activeTheme, toBlessed } from "./theme-system.ts";

setRuntime(new NodeRuntime());

export type FullscreenScreen = Screen;
export type FullscreenStatusLine = {
  setContent(content: string): void;
  destroy(): void;
};

export type FullscreenKeypressRace<T> =
  | { type: "keypress" }
  | { type: "result"; result: T };

export type FullscreenKeypress = {
  readonly received: boolean;
  wait(): Promise<void>;
  race<T>(pending: Promise<T>): Promise<FullscreenKeypressRace<T>>;
};

export const FULLSCREEN_QUIT_KEYS = ["escape", "q", "C-c"] as const;

/**
 * Upper bounds on a centered full-screen surface. Beyond these the terminal is
 * letterboxed: the TUI renders at the cap, centered, and the surrounding margin
 * falls back to the terminal default. Output-heavy split-pane grids opt out and
 * keep using the full terminal.
 */
export const FULLSCREEN_MAX_WIDTH = 112;
export const FULLSCREEN_MAX_HEIGHT = 34;

/** A centered, max-capped rectangle within the screen, in cell coordinates. */
export type FullscreenViewport = {
  top: number;
  left: number;
  width: number;
  height: number;
};

export function createFullscreenScreen(): FullscreenScreen {
  return new Screen({
    smartCSR: true,
    fullUnicode: true,
    title: "workforest",
  });
}

/**
 * The centered region a capped surface should occupy. Each axis is clamped to
 * its max and centered in the terminal; when the terminal is within the cap the
 * offset collapses to 0 and the size to the terminal, so small terminals behave
 * exactly as before.
 */
export function fullscreenViewport(screen: {
  width: number | string;
  height: number | string;
}): FullscreenViewport {
  const [left, width] = centerAxis(Number(screen.width), FULLSCREEN_MAX_WIDTH);
  const [top, height] = centerAxis(
    Number(screen.height),
    FULLSCREEN_MAX_HEIGHT,
  );
  return { top, left, width, height };
}

/** Returns `[offset, size]` for one centered, capped axis. */
function centerAxis(available: number, max: number): [number, number] {
  // A non-finite dimension (e.g. an unsized fake screen in tests) leaves the
  // axis uncapped at the max rather than collapsing to zero.
  const total = Number.isFinite(available) && available > 0 ? available : max;
  const size = Math.min(total, max);
  return [Math.floor((total - size) / 2), size];
}

/**
 * A centered, capped container for a capped surface, returned on top of a
 * full-terminal backdrop painted in the theme background. The whole terminal is
 * filled with the background color; the returned stage is the centered region
 * the surface renders into, so the letterbox margin reads as the same themed
 * backdrop rather than whatever the terminal was showing. Capped surfaces append
 * their content to the stage, so percentage widths, `bottom`/`right`, and
 * `center` anchors all resolve against the capped region. The backdrop is a
 * child of the screen and the stage a child of the backdrop, so destroying the
 * screen tears both down.
 */
export function createFullscreenStage(
  screen: FullscreenScreen,
  viewport: FullscreenViewport = fullscreenViewport(screen),
): Box {
  const background = toBlessed(activeTheme().chrome.background);
  const backdrop = new Box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    // @unblessed only paints a cell it actually writes a glyph to, and it trims
    // trailing whitespace — so a bg style alone, or a space-filled backdrop,
    // leaves the letterbox margin at the terminal default. Filling every cell
    // with a glyph whose fg matches the bg paints the whole terminal in the
    // theme background while staying invisible, so the margin matches the
    // centered surface instead of whatever the terminal was showing.
    wrap: false,
    style: { bg: background, fg: background },
  });
  backdrop.setContent(backdropFill(screen));
  const stage = new Box({
    parent: backdrop,
    top: viewport.top,
    left: viewport.left,
    width: viewport.width,
    height: viewport.height,
  });

  const reflow = (): void => {
    const next = fullscreenViewport(screen);
    backdrop.setContent(backdropFill(screen));
    stage.top = next.top;
    stage.left = next.left;
    stage.width = next.width;
    stage.height = next.height;
    screen.render();
  };
  screen.on("resize", reflow);

  const destroyStage = stage.destroy.bind(stage);
  stage.destroy = (): void => {
    screen.off("resize", reflow);
    destroyStage();
  };

  return stage;
}

/** A full-terminal block of (invisible) fill glyphs, one line per row. */
function backdropFill(screen: {
  width: number | string;
  height: number | string;
}): string {
  const cols = axisSize(Number(screen.width), FULLSCREEN_MAX_WIDTH);
  const rows = axisSize(Number(screen.height), FULLSCREEN_MAX_HEIGHT);
  return Array.from({ length: rows }, () => ".".repeat(cols)).join("\n");
}

/** A usable cell count for one axis, falling back to the cap when unknown. */
function axisSize(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function createFullscreenStatusLine(
  screen: FullscreenScreen,
): FullscreenStatusLine {
  return new Box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    padding: { left: 1 },
    style: { fg: toBlessed(activeTheme().palette.muted) },
  });
}

export function createFullscreenKeypress(
  screen: FullscreenScreen,
  keys?: readonly string[],
): FullscreenKeypress {
  let received = false;
  let resolveKeypress!: () => void;
  const keypressPromise = new Promise<void>((resolve) => {
    resolveKeypress = resolve;
  });

  const receive = (): void => {
    if (received) return;
    received = true;
    resolveKeypress();
  };

  if (keys) {
    screen.key([...keys], receive);
  } else {
    screen.once("keypress", receive);
  }

  return {
    get received() {
      return received;
    },
    wait: () => keypressPromise,
    race: async <T>(
      pending: Promise<T>,
    ): Promise<FullscreenKeypressRace<T>> => {
      if (received) return { type: "keypress" };

      return Promise.race([
        keypressPromise.then(() => ({ type: "keypress" as const })),
        pending.then((result) =>
          received
            ? { type: "keypress" as const }
            : { type: "result" as const, result },
        ),
      ]);
    },
  };
}
