import { terminalColor } from "./terminal/theme.ts";
import {
  barColor,
  S_BAR,
  S_ERROR,
  S_INFO,
  S_SUCCESS,
  S_WARNING,
} from "./ui/prompts/symbols.ts";

/**
 * Simple logger for console output. Lines share the inline prompt grammar — a
 * muted left bar, a colored status glyph, then the message — so a one-off
 * `log.success` reads as part of the same surface as an interactive prompt.
 * In TUI mode, callers should route messages through generators/WorkspaceState
 * rather than calling these directly.
 */
function emit(
  stream: (line: string) => void,
  glyph: string,
  tint: ((value: string) => string) | undefined,
  messages: readonly unknown[],
): void {
  const text = messages.map((message) => String(message)).join(" ");
  stream(`  ${barColor(S_BAR)}  ${glyph} ${tint ? tint(text) : text}`);
}

export const log = {
  info: (...messages: unknown[]) =>
    emit(console.log, S_INFO, undefined, messages),
  warn: (...messages: unknown[]) =>
    emit(console.warn, S_WARNING, terminalColor.warning, messages),
  error: (...messages: unknown[]) =>
    emit(console.error, S_ERROR, terminalColor.error, messages),
  success: (...messages: unknown[]) =>
    emit(console.log, S_SUCCESS, terminalColor.success, messages),
};
