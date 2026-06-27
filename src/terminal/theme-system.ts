import chalk from "chalk";
import { terminalSymbol } from "./theme.ts";

/**
 * The single source of truth for every color and symbol a fullscreen surface
 * draws. There is exactly one theme; surfaces read tokens by *semantic role* —
 * they never hardcode a color or glyph — so the role→meaning mapping stays fixed
 * (success is always "success", whatever color the theme paints it) and every
 * surface renders identically no matter how it was launched.
 *
 * State is carried by these semantic role tokens, not by the theme's chrome
 * accent. Decorative confetti may be as colorful as it likes, but those colors
 * must not encode state.
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
  /**
   * A dimmed {@link primary}: same hue, lower intensity. For secondary content
   * that should still read as "primary-colored" but recede — e.g. metadata on
   * unselected rows.
   */
  dim: ThemeColor;
  /**
   * Secondary neon accent. Pairs against {@link primary} for duotone contrast —
   * metadata, separators, active markers — and must not encode state.
   */
  accent: ThemeColor;
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

const CYBERPUNK_BACKGROUND: Rgb = [18, 20, 22];
// Electric neon red — high saturation, pushed bright so it reads as a glow.
// Blue is kept low (near the green channel) so it stays a true red instead of
// drifting pink/magenta.
const CYBERPUNK_RED: Rgb = [255, 28, 28];
// Electric cyan. Pulled down from near-white so it reads as a vivid, saturated
// cyan rather than a pale wash — apparent vibrancy peaks below max lightness.
const CYBERPUNK_CYAN: Rgb = [34, 211, 238];
const CYBERPUNK_WHITE: Rgb = [245, 240, 242];

/**
 * The one theme the whole app wears. Red dominates: it is the primary text color
 * and the ambient chrome (borders/background). The focused/selected element
 * flips to white (surfaces render it bold) so selection reads against the red.
 * Cyan and amber stay reserved for success/warning state, which red can't carry
 * once it's the default text color. Confetti goes deliberately colorful.
 */
const THEME: Theme = {
  palette: {
    focus: rgb(...CYBERPUNK_WHITE),
    success: rgb(...CYBERPUNK_CYAN),
    warning: rgb(255, 196, 0),
    error: rgb(...CYBERPUNK_RED),
    cancel: rgb(...CYBERPUNK_RED),
    muted: rgb(90, 70, 100),
    primary: rgb(...CYBERPUNK_RED),
    // A reddish grey: mostly neutral, warmed by a red tint (green == blue, so no
    // pink/salmon lean). Recedes behind the vivid primary while staying clearly
    // warmer than the neutral muted grey used for template repos.
    dim: rgb(130, 90, 90),
    accent: rgb(...CYBERPUNK_CYAN),
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

export function activeTheme(): Theme {
  return THEME;
}
