import chalk from "chalk";
import { terminalSymbol } from "./theme.ts";

/**
 * The single source of truth for every color and symbol a themeable fullscreen
 * surface draws. Surfaces read tokens by *semantic role* — they never hardcode a
 * color or glyph. A theme supplies the concrete value for each role, so a
 * different theme can shift hues and glyphs while the role→meaning mapping stays
 * fixed (success is always "success", whatever color the theme paints it).
 *
 * State is carried by these semantic role tokens, not by the theme's chrome
 * accent. Decorative confetti may be as colorful as a theme likes, but those
 * colors must not encode state.
 */

export type Rgb = readonly [number, number, number];

/**
 * A color is either one of the terminal's 16 named ANSI colors — which honor the
 * user's own terminal palette and degrade cleanly — or an explicit truecolor RGB
 * triple for themes that want a specific shade. The default theme uses named
 * colors so it looks identical to the pre-theme app on every terminal.
 */
export type ThemeColor =
  | Readonly<{ kind: "named"; name: NamedColor }>
  | Readonly<{ kind: "rgb"; rgb: Rgb }>;

export type NamedColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "gray";

export const named = (name: NamedColor): ThemeColor => ({
  kind: "named",
  name,
});
export const rgb = (r: number, g: number, b: number): ThemeColor => ({
  kind: "rgb",
  rgb: [r, g, b],
});

/** Semantic color roles. Chrome and decorative roles are grouped separately. */
export type ThemePalette = Readonly<{
  /** Focus, active selection, and progress. */
  focus: ThemeColor;
  success: ThemeColor;
  warning: ThemeColor;
  error: ThemeColor;
  /** Cancellation and destructive emphasis. */
  cancel: ThemeColor;
  /** Hints, labels, inactive chrome. */
  muted: ThemeColor;
  /** Primary content. */
  primary: ThemeColor;
}>;

export type ThemeChrome = Readonly<{
  background: ThemeColor;
  border: ThemeColor;
}>;

export type ThemeDecoration = Readonly<{
  /** Confetti fill colors — purely decorative, must not signify state. */
  confettiColors: readonly ThemeColor[];
  /** Confetti particle glyphs cycled during the celebration. */
  confettiGlyphs: readonly string[];
}>;

/** Semantic symbol roles. Default values come from {@link terminalSymbol}. */
export type ThemeSymbols = Readonly<{
  active: string;
  done: string;
  cancel: string;
  radioOn: string;
  radioOff: string;
  checkOn: string;
  checkOff: string;
  info: string;
  success: string;
  warning: string;
  error: string;
  /** Grid pane status glyphs. */
  statusRunning: string;
  statusComplete: string;
  statusFailed: string;
  statusPending: string;
  statusCancelled: string;
}>;

export type Theme = Readonly<{
  id: string;
  name: string;
  palette: ThemePalette;
  chrome: ThemeChrome;
  decoration: ThemeDecoration;
  symbols: ThemeSymbols;
}>;

const NAMED_HEX: Record<NamedColor, string> = {
  black: "#000000",
  red: "#ff0000",
  green: "#00ff00",
  yellow: "#ffff00",
  blue: "#0000ff",
  magenta: "#ff00ff",
  cyan: "#00ffff",
  white: "#ffffff",
  gray: "#808080",
};

/** A color string @unblessed understands: a named color or a `#rrggbb` hex. */
export function toBlessed(color: ThemeColor): string {
  return color.kind === "named" ? color.name : toHex(color);
}

export function toHex(color: ThemeColor): string {
  if (color.kind === "named") return NAMED_HEX[color.name];
  const [r, g, b] = color.rgb;
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Wrap text in an @unblessed foreground tag for the given color. */
export function fg(color: ThemeColor, text: string): string {
  const token = toBlessed(color);
  return `{${token}-fg}${text}{/${token}-fg}`;
}

/** Wrap text in an @unblessed background tag for the given color. */
export function bg(color: ThemeColor, text: string): string {
  const token = toBlessed(color);
  return `{${token}-bg}${text}{/${token}-bg}`;
}

/** Project a color onto a chalk styler for inline (non-fullscreen) output. */
export function toChalk(color: ThemeColor): (value: string) => string {
  if (color.kind === "rgb") {
    const [r, g, b] = color.rgb;
    return (value: string) => chalk.rgb(r, g, b)(value);
  }
  const styler = color.name === "gray" ? chalk.gray : chalk[color.name];
  return (value: string) => styler(value);
}

const DEFAULT_SYMBOLS: ThemeSymbols = {
  active: terminalSymbol.active,
  done: terminalSymbol.done,
  cancel: terminalSymbol.cancel,
  radioOn: terminalSymbol.radioOn,
  radioOff: terminalSymbol.radioOff,
  checkOn: terminalSymbol.checkOn,
  checkOff: terminalSymbol.checkOff,
  info: terminalSymbol.info,
  success: terminalSymbol.success,
  warning: terminalSymbol.warning,
  error: terminalSymbol.error,
  statusRunning: "↻", // ⟳
  statusComplete: terminalSymbol.success,
  statusFailed: terminalSymbol.error,
  statusPending: terminalSymbol.radioOff,
  statusCancelled: "⊘",
};

/**
 * Reproduces the pre-theme appearance exactly: the same named ANSI colors and
 * glyphs the fullscreen surfaces used before theming existed. Selecting this
 * theme must be a visual no-op.
 */
export const DEFAULT_THEME: Theme = {
  id: "default",
  name: "Default",
  palette: {
    focus: named("cyan"),
    success: named("green"),
    warning: named("yellow"),
    error: named("red"),
    cancel: named("red"),
    muted: named("gray"),
    primary: named("white"),
  },
  chrome: {
    background: named("black"),
    border: named("cyan"),
  },
  decoration: {
    confettiColors: [
      named("cyan"),
      named("green"),
      named("yellow"),
      named("magenta"),
      named("blue"),
      named("white"),
    ],
    confettiGlyphs: ["◜", "◝", "◞", "◟"], // ◜ ◝ ◞ ◟
  },
  symbols: DEFAULT_SYMBOLS,
};

const CYBERPUNK_BACKGROUND: Rgb = [18, 20, 22];
const CYBERPUNK_RED: Rgb = [251, 10, 38];
const CYBERPUNK_CYAN: Rgb = [0, 245, 255];

/**
 * Cyberpunk red: red is ambient chrome (border/background); cyan and the other
 * semantic roles still carry state. Confetti goes deliberately colorful.
 */
export const CYBERPUNK_RED_THEME: Theme = {
  id: "cyberpunk-red",
  name: "Cyberpunk red",
  palette: {
    focus: rgb(...CYBERPUNK_CYAN),
    success: rgb(...CYBERPUNK_CYAN),
    warning: rgb(255, 196, 0),
    error: rgb(...CYBERPUNK_RED),
    cancel: rgb(...CYBERPUNK_RED),
    muted: rgb(120, 110, 116),
    primary: rgb(245, 240, 242),
  },
  chrome: {
    background: rgb(...CYBERPUNK_BACKGROUND),
    border: rgb(...CYBERPUNK_RED),
  },
  decoration: {
    confettiColors: [
      rgb(...CYBERPUNK_CYAN),
      rgb(...CYBERPUNK_RED),
      rgb(255, 196, 0),
      rgb(255, 0, 170),
      rgb(140, 80, 255),
      named("white"),
    ],
    confettiGlyphs: ["◜", "◝", "◞", "◟"],
  },
  symbols: DEFAULT_SYMBOLS,
};

export const THEMES: readonly Theme[] = [DEFAULT_THEME, CYBERPUNK_RED_THEME];

let currentTheme: Theme = DEFAULT_THEME;

export function activeTheme(): Theme {
  return currentTheme;
}

export function setActiveTheme(theme: Theme | string): void {
  if (typeof theme === "string") {
    const match = THEMES.find((candidate) => candidate.id === theme);
    if (!match) throw new Error(`Unknown theme: ${theme}`);
    currentTheme = match;
    return;
  }
  currentTheme = theme;
}
