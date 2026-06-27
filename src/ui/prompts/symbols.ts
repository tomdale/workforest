import { terminalColor, terminalSymbol } from "../../terminal/theme.ts";

// Box drawing
export const S_BAR_START = "┌";
export const S_BAR = "│";
export const S_BAR_END = "└";
export const S_BAR_H = "─";

// Prompt state
export const S_STEP_ACTIVE = terminalColor.accent(terminalSymbol.active);
export const S_STEP_DONE = terminalColor.muted(terminalSymbol.done);
export const S_STEP_CANCEL = terminalColor.error(terminalSymbol.cancel);

// Select / radio
export const S_RADIO_ON = terminalColor.accent(terminalSymbol.radioOn);
export const S_RADIO_OFF = terminalColor.muted(terminalSymbol.radioOff);

// Checkbox
export const S_CHECK_ON = terminalColor.accent(terminalSymbol.checkOn);
export const S_CHECK_OFF = terminalColor.muted(terminalSymbol.checkOff);

// Spinner frames
export const SPINNER_FRAMES = ["◒", "◐", "◓", "◑"];
export const SPINNER_INTERVAL = 80;

// Log prefixes
export const S_INFO = terminalColor.accent(terminalSymbol.info);
export const S_SUCCESS = terminalColor.success(terminalSymbol.success);
export const S_WARNING = terminalColor.warning(terminalSymbol.warning);
export const S_ERROR = terminalColor.error(terminalSymbol.error);

// Colors applied to structural elements
export const barColor = terminalColor.muted;

export function printCancelled(message = "Cancelled"): void {
  process.stdout.write(`  ${S_STEP_CANCEL}  ${terminalColor.error(message)}\n`);
}
