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
/** Pair a color with optional emphasis into a {@link ThemeRoleStyle}. */
const style = (
  color: ThemeColor,
  ...emphasis: TerminalEmphasis[]
): ThemeRoleStyle => (emphasis.length ? { color, emphasis } : { color });

/** Text weight/decoration a role carries in addition to its color. */
export type TerminalEmphasis = "bold" | "underline" | "inverse";

/**
 * A role's full text style: a {@link ThemeColor} plus any emphasis applied
 * wherever the role is used. Emphasis lives on the role (not just the call
 * site) so a rule like "the command name is bold" is defined once, in the
 * theme, rather than repeated at every span that draws it.
 */
export type ThemeRoleStyle = Readonly<{
  color: ThemeColor;
  emphasis?: readonly TerminalEmphasis[];
}>;

/** Semantic text roles. Chrome and decorative roles are grouped separately. */
export type ThemePalette = Readonly<{
  /** Focus, active selection, and progress. */
  focus: ThemeRoleStyle;
  success: ThemeRoleStyle;
  warning: ThemeRoleStyle;
  error: ThemeRoleStyle;
  /** Hints, labels, inactive chrome. */
  muted: ThemeRoleStyle;
  /** Primary content. */
  primary: ThemeRoleStyle;
  /**
   * A dimmed {@link primary}: same hue, lower intensity. For secondary content
   * that should still read as "primary-colored" but recede — e.g. metadata on
   * unselected rows.
   */
  dim: ThemeRoleStyle;
  /**
   * Secondary neon accent. Pairs against {@link primary} for duotone contrast —
   * metadata, separators, active markers — and must not encode state.
   */
  accent: ThemeRoleStyle;
  /**
   * The `wf` program name in help output. Bold is part of the role, so the
   * program name reads distinctly from the {@link subcommand} that follows it
   * even though they share a hue.
   */
  command: ThemeRoleStyle;
  /**
   * Subcommand words in help output (e.g. `template`, `new`). A dedicated role,
   * separate from {@link accent} arguments, so subcommands can be recolored on
   * their own even while they currently share the {@link command} hue.
   */
  subcommand: ThemeRoleStyle;
  /**
   * Markdown headings in a rendered description. Carries the heading color only;
   * heading level is conveyed by emphasis applied in the Markdown style map
   * (h1 bold, deeper levels plain).
   */
  heading: ThemeRoleStyle;
  /**
   * Inline code that is not a command — a file name, path, or config key like
   * `template.jsonc` or `branchPrefix`. Distinct from {@link accent} argument
   * placeholders and from the {@link command}/{@link subcommand} roles that a
   * command invocation inside inline code resolves to.
   */
  code: ThemeRoleStyle;
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
  // U+2714 (heavy check mark), bare with no variation selector. @unblessed's
  // width table used to mark U+2714 double-width while real terminals render
  // it single-width, desyncing the renderer's screen model one column for
  // the rest of the row; a pnpm patch
  // (patches/@unblessed__core@1.0.0-alpha.23.patch, guarded by
  // src/terminal/unblessed-width.test.ts) fixes the table so this is now
  // safe. The variation-selector form (U+2714 U+FE0E, "✔︎") is still unsafe:
  // @unblessed spends an extra column on the selector itself, so it must
  // never be used here.
  success: "✔",
  warning: "▲",
  error: "✗",
  statusRunning: "↻", // ⟳
  statusComplete: "✔",
  statusFailed: "✗",
  statusPending: "○",
  statusCancelled: "⊘",
};

/**
 * The one theme the whole app wears. Fullscreen surfaces intentionally use
 * named terminal colors for their core roles so they respect the user's
 * terminal palette. On the default Workforest palette, red renders as the warm
 * orange row/rule color and cyan renders as the bright border/metadata accent.
 */
const THEME: Theme = {
  palette: {
    focus: style(named("white")),
    success: style(named("cyan")),
    warning: style(named("yellow")),
    error: style(named("red")),
    muted: style(rgb(90, 70, 100)),
    primary: style(named("red")),
    dim: style(rgb(130, 90, 90)),
    accent: style(named("cyan")),
    command: style(named("yellow"), "bold"),
    subcommand: style(named("yellow")),
    heading: style(named("magenta")),
    code: style(named("green")),
  },
  chrome: {
    background: rgb(18, 20, 22),
    border: named("cyan"),
  },
  decoration: {
    confettiColors: [
      named("cyan"),
      named("red"),
      named("yellow"),
      named("magenta"),
      named("blue"),
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
 * 8/16-color terminals. Roles keep their meaning (success is still "success");
 * only the color depth changes.
 */
const INLINE_ANSI_PALETTE: ThemePalette = {
  focus: style(named("whiteBright")),
  success: style(named("cyan")),
  warning: style(named("yellow")),
  error: style(named("red")),
  muted: style(named("gray")),
  primary: style(named("red")),
  dim: style(named("gray")),
  accent: style(named("blueBright")),
  command: style(named("yellow"), "bold"),
  subcommand: style(named("yellow")),
  heading: style(named("magenta")),
  code: style(named("green")),
};

/** The 16-color ANSI palette used for inline (non-fullscreen) terminal output. */
export function inlinePalette(): ThemePalette {
  return INLINE_ANSI_PALETTE;
}

/**
 * Narrow an arbitrary string to a palette role. Used to validate the semantic
 * role names authors write in Markdown annotations (`{muted}`, `[text]{error}`)
 * before applying them.
 */
export function isThemeRole(name: string): name is keyof ThemePalette {
  return Object.hasOwn(INLINE_ANSI_PALETTE, name);
}
