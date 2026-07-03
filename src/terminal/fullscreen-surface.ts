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
 * falls back to the terminal default.
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

export type FullscreenViewportResolver = (screen: {
  width: number | string;
  height: number | string;
}) => FullscreenViewport;

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

/**
 * The full terminal region. Split-pane command output uses this with the
 * standard fullscreen stage/backdrop implementation because it needs all
 * available space rather than the centered, capped picker/wizard surface.
 */
export function fullTerminalViewport(screen: {
  width: number | string;
  height: number | string;
}): FullscreenViewport {
  return {
    top: 0,
    left: 0,
    width: axisSize(Number(screen.width), FULLSCREEN_MAX_WIDTH),
    height: axisSize(Number(screen.height), FULLSCREEN_MAX_HEIGHT),
  };
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
  viewport:
    | FullscreenViewport
    | FullscreenViewportResolver = fullscreenViewport,
): Box {
  const resolveViewport =
    typeof viewport === "function" ? viewport : () => viewport;
  const initialViewport = resolveViewport(screen);
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
    top: initialViewport.top,
    left: initialViewport.left,
    width: initialViewport.width,
    height: initialViewport.height,
  });

  const reflow = (): void => {
    const next = resolveViewport(screen);
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
  const theme = activeTheme();
  const background = toBlessed(theme.chrome.background);
  const box = new Box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    style: {
      fg: toBlessed(theme.palette.muted.color),
      bg: background,
    },
  });
  return {
    setContent(content: string): void {
      box.setContent(paintFullStatusLine(screen, content, background));
    },
    destroy(): void {
      box.destroy();
    },
  };
}

function paintFullStatusLine(
  screen: { width: number | string },
  content: string,
  background: string,
): string {
  const width = axisSize(Number(screen.width), FULLSCREEN_MAX_WIDTH);
  const text = ` ${content}`;
  const visibleWidth = stripBlessedTags(text).length;
  const fillWidth = Math.max(width - visibleWidth, 0);
  if (fillWidth === 0) return text;
  return `${text}{${background}-fg}{${background}-bg}${".".repeat(fillWidth)}{/${background}-bg}{/${background}-fg}`;
}

function stripBlessedTags(value: string): string {
  return value.replace(/\{[^}]*\}/g, "");
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
