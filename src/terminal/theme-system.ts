import chalk from "chalk";

/**
 * The single source of truth for every color and symbol the app draws. There is
 * exactly one theme; surfaces read tokens by *semantic role* — they never
 * hardcode a color or glyph — so the role→meaning mapping stays fixed (success
 * is always "success", whatever color the theme paints it) and every surface
 * renders consistently. Fullscreen surfaces resolve roles to truecolor; inline
 * output resolves the same roles to 16-color ANSI ({@link inlinePalette}).
 *
 * State is carried by these semantic role tokens, not by the theme's chrome
 * accent. Decorative confetti may be as colorful as it likes, but those colors
 * must not encode state.
 */

export type Rgb = readonly [number, number, number];

/**
 * A color is either one of the terminal's 16 named ANSI colors — which honor the
 * user's own terminal palette and degrade cleanly — or an explicit truecolor RGB
 * triple for a specific shade. The fullscreen theme uses RGB for its precise
 * cyberpunk palette; the inline palette uses named ANSI colors (see
 * {@link inlinePalette}).
 */
export type ThemeColor =
  | Readonly<{ kind: "named"; name: NamedColor }>
  | Readonly<{ kind: "rgb"; rgb: Rgb }>;

/**
 * The 16 ANSI colors: the 8 standard colors, `gray` (a.k.a. bright black), and
 * the 7 remaining bright variants. Named colors honor the user's own terminal
 * palette and degrade cleanly on 8/16-color terminals, so the inline theme is
 * built from these rather than truecolor RGB.
 */
export type NamedColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "gray"
  | "redBright"
  | "greenBright"
  | "yellowBright"
  | "blueBright"
  | "magentaBright"
  | "cyanBright"
  | "whiteBright";

const named = (name: NamedColor): ThemeColor => ({
  kind: "named",
  name,
});
const rgb = (r: number, g: number, b: number): ThemeColor => ({
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

/** Semantic symbol roles; the concrete glyphs live in {@link DEFAULT_SYMBOLS}. */
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
  redBright: "#ff5555",
  greenBright: "#55ff55",
  yellowBright: "#ffff55",
  blueBright: "#5555ff",
  magentaBright: "#ff55ff",
  cyanBright: "#55ffff",
  whiteBright: "#ffffff",
};

/**
 * A color string @unblessed understands: a base ANSI name (`red`, `gray`) or a
 * `#rrggbb` hex. The `*Bright` names aren't part of blessed's color vocabulary,
 * so they fall back to their hex; only the inline (chalk) path uses them anyway.
 */
export function toBlessed(color: ThemeColor): string {
  if (color.kind === "rgb") return toHex(color);
  return color.name.endsWith("Bright") ? toHex(color) : color.name;
}

function toHex(color: ThemeColor): string {
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

/**
 * The canonical glyph vocabulary — the literal characters every surface draws,
 * defined in exactly one place. The inline layer (theme.ts) re-exports them.
 */
const DEFAULT_SYMBOLS: ThemeSymbols = {
  active: "◆",
  done: "◇",
  cancel: "⊘",
  radioOn: "●",
  radioOff: "○",
  checkOn: "◼",
  checkOff: "◻",
  info: "●",
  success: "✔︎",
  warning: "▲",
  error: "✗",
  statusRunning: "↻", // ⟳
  statusComplete: "✔︎",
  statusFailed: "✗",
  statusPending: "○",
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

/**
 * The inline (non-fullscreen) palette. It carries the same semantic roles as
 * {@link THEME} but in the 16 named ANSI colors instead of truecolor RGB, so
 * plain `wf` output honors the user's terminal palette and degrades cleanly on
 * 8/16-color terminals — where the fullscreen theme's truecolor reds would be
 * approximated unpredictably. Roles keep their meaning (success is still
 * "success"); only the color depth changes. ANSI has one grey, so `muted` and
 * `dim` share it, and `primary`/`error` both land on red exactly as the
 * truecolor theme collapses them onto the cyberpunk red.
 */
const INLINE_ANSI_PALETTE: ThemePalette = {
  focus: named("whiteBright"),
  success: named("cyan"),
  warning: named("yellow"),
  error: named("red"),
  muted: named("gray"),
  primary: named("red"),
  dim: named("gray"),
  accent: named("cyan"),
};

/** The 16-color ANSI palette used for inline (non-fullscreen) terminal output. */
export function inlinePalette(): ThemePalette {
  return INLINE_ANSI_PALETTE;
}
