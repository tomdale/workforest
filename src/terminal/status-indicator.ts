import {
  renderTerminalLineAnsi,
  type TerminalStyleRole,
  terminalLine,
  terminalSpan,
} from "./render-model.ts";
import { terminalColor, terminalSymbol } from "./theme.ts";

/**
 * Semantic tone for a state indicator. Each tone fixes a glyph + color from the
 * one theme, so "failed" looks identical whether it labels a task, a repository,
 * or a cache entry. Domain code maps its own state strings onto a tone — it never
 * reaches for a glyph or color directly — which keeps state encoding consistent
 * across every command.
 */
export type StatusTone =
  | "success"
  | "error"
  | "warning"
  | "pending"
  | "cancelled"
  | "info";

/** Map from status tone to its glyph. */
export const TONE_GLYPH: Record<StatusTone, string> = {
  success: terminalSymbol.success,
  error: terminalSymbol.error,
  warning: terminalSymbol.warning,
  pending: terminalSymbol.statusPending,
  cancelled: terminalSymbol.statusCancelled,
  info: terminalSymbol.info,
};

/** Map from status tone to the role that colors it. */
export const TONE_ROLE: Record<StatusTone, TerminalStyleRole> = {
  success: "success",
  error: "error",
  warning: "warning",
  pending: "muted",
  cancelled: "muted",
  info: "accent",
};

/** Map from status tone to the role for message text (or undefined for unstyled). */
function messageRole(tone: StatusTone): TerminalStyleRole | undefined {
  return tone === "info" ? undefined : TONE_ROLE[tone];
}

const TONES: Record<
  StatusTone,
  { glyph: string; color: (value: string) => string }
> = {
  success: {
    glyph: terminalSymbol.success,
    color: terminalColor.success,
  },
  error: { glyph: terminalSymbol.error, color: terminalColor.error },
  warning: { glyph: terminalSymbol.warning, color: terminalColor.warning },
  pending: { glyph: terminalSymbol.statusPending, color: terminalColor.muted },
  cancelled: {
    glyph: terminalSymbol.statusCancelled,
    color: terminalColor.muted,
  },
  info: { glyph: terminalSymbol.info, color: terminalColor.accent },
};

/** Convert a log kind to its corresponding tone. */
export function kindToTone(
  kind: "info" | "success" | "warning" | "error",
): StatusTone {
  return kind;
}

/**
 * Render a status line with the inline grammar: `  │  {glyph} {message}`.
 * The bar and message use role-based styling so output is consistent across
 * surfaces using terminalLine/terminalSpan/renderTerminalLineAnsi.
 */
export function statusLine(tone: StatusTone, message: string): string {
  const role = TONE_ROLE[tone];
  const msgRole = messageRole(tone);

  return renderTerminalLineAnsi(
    terminalLine([
      "  ",
      terminalSpan("│", { role: "muted" }),
      "  ",
      terminalSpan(TONE_GLYPH[tone], { role }),
      " ",
      msgRole === undefined
        ? message
        : terminalSpan(message, { role: msgRole }),
    ]),
  );
}

/** The colored status glyph on its own (e.g. a cyan ✔︎). */
export function statusGlyph(tone: StatusTone): string {
  const { glyph, color } = TONES[tone];
  return color(glyph);
}

/** `{glyph} {label}`, with both the glyph and label painted in the tone's color. */
export function statusLabel(tone: StatusTone, label: string): string {
  const { glyph, color } = TONES[tone];
  return `${color(glyph)} ${color(label)}`;
}
