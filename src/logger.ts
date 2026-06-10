import { terminalColor, terminalSymbol } from "./terminal/theme.ts";

/**
 * Simple logger for console output.
 * In TUI mode, callers should handle log messages via generators/WorkspaceState
 * rather than calling these functions directly.
 */
export const log = {
  info: (...messages: unknown[]) => {
    console.log(terminalColor.accent(terminalSymbol.info), ...messages);
  },
  warn: (...messages: unknown[]) => {
    console.warn(terminalColor.warning(terminalSymbol.warning), ...messages);
  },
  error: (...messages: unknown[]) => {
    console.error(terminalColor.error(terminalSymbol.error), ...messages);
  },
  success: (...messages: unknown[]) => {
    console.log(terminalColor.success(terminalSymbol.success), ...messages);
  },
};
