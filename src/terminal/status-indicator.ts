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

const TONES: Record<
  StatusTone,
  { glyph: string; color: (value: string) => string }
> = {
  success: {
    glyph: terminalSymbol.statusComplete,
    color: terminalColor.success,
  },
  error: { glyph: terminalSymbol.statusFailed, color: terminalColor.error },
  warning: { glyph: terminalSymbol.warning, color: terminalColor.warning },
  pending: { glyph: terminalSymbol.statusPending, color: terminalColor.muted },
  cancelled: {
    glyph: terminalSymbol.statusCancelled,
    color: terminalColor.muted,
  },
  info: { glyph: terminalSymbol.info, color: terminalColor.accent },
};

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
