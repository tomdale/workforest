import { kindToTone, statusLine } from "./terminal/status-indicator.ts";

/**
 * Simple logger for console output. Lines share the inline prompt grammar — a
 * muted left bar, a colored status glyph, then the message — so a one-off
 * `log.success` reads as part of the same surface as an interactive prompt.
 * In TUI mode, callers should route messages through generators/WorkspaceState
 * rather than calling these directly.
 */
function emit(
  stream: (line: string) => void,
  kind: "error" | "info" | "success" | "warning",
  messages: readonly unknown[],
): void {
  const text = messages.map((message) => String(message)).join(" ");
  stream(statusLine(kindToTone(kind), text));
}

export const log = {
  info: (...messages: unknown[]) => emit(console.log, "info", messages),
  warn: (...messages: unknown[]) => emit(console.warn, "warning", messages),
  error: (...messages: unknown[]) => emit(console.error, "error", messages),
  success: (...messages: unknown[]) => emit(console.log, "success", messages),
};
