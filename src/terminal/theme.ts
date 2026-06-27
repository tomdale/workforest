import { activeTheme, inlinePalette, toChalk } from "./theme-system.ts";

/**
 * The inline (non-fullscreen) face of the theme. Reports, log lines, prompts,
 * and help text style themselves through these stylers, projected from the
 * 16-color ANSI {@link inlinePalette} via {@link toChalk}. Inline output uses
 * named ANSI colors (not truecolor) so it honors the user's terminal palette and
 * degrades cleanly; the fullscreen surfaces keep their truecolor theme. Both
 * resolve the same semantic roles, so "success" means the same thing on a plain
 * `wf list` as in the front-door TUI — only the color depth differs. Glyphs are
 * shared via {@link activeTheme}.
 */
const palette = inlinePalette();
const role = (key: keyof typeof palette) => toChalk(palette[key]);

export const terminalColor = {
  focus: role("focus"),
  primary: role("primary"),
  accent: role("accent"),
  agent: role("focus"),
  success: role("success"),
  warning: role("warning"),
  error: role("error"),
  muted: role("muted"),
  dim: role("dim"),
};

/**
 * Help-text token colors, mapped onto palette roles so help stays on the theme.
 * Descriptions render unstyled so body copy keeps the terminal's default ink.
 */
export const helpColor = {
  heading: terminalColor.accent,
  program: terminalColor.focus,
  command: terminalColor.accent,
  option: terminalColor.warning,
  argument: terminalColor.accent,
  description: (value: string) => value,
  metadata: terminalColor.muted,
};

/** The canonical glyph vocabulary, re-exported from the one theme. */
export const terminalSymbol = activeTheme().symbols;
