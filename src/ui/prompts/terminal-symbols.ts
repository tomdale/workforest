import type { TerminalSymbols } from "../../terminal/inline-widgets.ts";
import { terminalSpan } from "../../terminal/render-model.ts";
import { terminalSymbol } from "../../terminal/theme.ts";
import { S_BAR, S_BAR_END, S_BAR_H, S_BAR_START } from "./symbols.ts";

export function terminalSymbols(): TerminalSymbols {
  return {
    active: terminalSpan(terminalSymbol.active, { role: "accent" }),
    done: terminalSpan(terminalSymbol.done, { role: "muted" }),
    cancel: terminalSpan(terminalSymbol.cancel, { role: "error" }),
    bar: terminalSpan(S_BAR, { role: "muted" }),
    barEnd: terminalSpan(S_BAR_END, { role: "muted" }),
    barStart: terminalSpan(S_BAR_START, { role: "muted" }),
    barHorizontal: terminalSpan(S_BAR_H, { role: "muted" }),
    radioOn: terminalSpan(terminalSymbol.radioOn, { role: "accent" }),
    radioOff: terminalSpan(terminalSymbol.radioOff, { role: "muted" }),
    checkOn: terminalSpan(terminalSymbol.checkOn, { role: "accent" }),
    checkOff: terminalSpan(terminalSymbol.checkOff, { role: "muted" }),
    info: terminalSpan(terminalSymbol.info, { role: "accent" }),
    warning: terminalSpan(terminalSymbol.warning, { role: "warning" }),
    error: terminalSpan(terminalSymbol.error, { role: "error" }),
    success: terminalSpan(terminalSymbol.success, { role: "success" }),
  };
}
