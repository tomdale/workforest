import {
  renderTerminalLineAnsi,
  type TerminalStyleRole,
  terminalLine,
  terminalSpan,
} from "./terminal/render-model.ts";
import { terminalSymbol } from "./terminal/theme.ts";
import { S_BAR } from "./ui/prompts/symbols.ts";

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
  const messageRole = logMessageRole(kind);
  stream(
    renderTerminalLineAnsi(
      terminalLine([
        "  ",
        terminalSpan(S_BAR, { role: "muted" }),
        "  ",
        terminalSpan(logGlyph(kind), { role: logGlyphRole(kind) }),
        " ",
        messageRole === undefined
          ? text
          : terminalSpan(text, { role: messageRole }),
      ]),
    ),
  );
}

export const log = {
  info: (...messages: unknown[]) => emit(console.log, "info", messages),
  warn: (...messages: unknown[]) => emit(console.warn, "warning", messages),
  error: (...messages: unknown[]) => emit(console.error, "error", messages),
  success: (...messages: unknown[]) => emit(console.log, "success", messages),
};

function logGlyph(kind: "error" | "info" | "success" | "warning"): string {
  return {
    error: terminalSymbol.error,
    info: terminalSymbol.info,
    success: terminalSymbol.success,
    warning: terminalSymbol.warning,
  }[kind];
}

function logGlyphRole(
  kind: "error" | "info" | "success" | "warning",
): TerminalStyleRole {
  return kind === "info" ? "accent" : kind;
}

function logMessageRole(
  kind: "error" | "info" | "success" | "warning",
): TerminalStyleRole | undefined {
  return kind === "info" ? undefined : kind;
}
