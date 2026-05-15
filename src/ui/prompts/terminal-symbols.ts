import type { TerminalSymbols } from "../../terminal/inline-widgets.ts";
import {
  barColor,
  S_BAR,
  S_BAR_END,
  S_BAR_H,
  S_BAR_START,
  S_CHECK_OFF,
  S_CHECK_ON,
  S_ERROR,
  S_INFO,
  S_RADIO_OFF,
  S_RADIO_ON,
  S_STEP_ACTIVE,
  S_STEP_CANCEL,
  S_STEP_DONE,
  S_SUCCESS,
  S_WARNING,
} from "./symbols.ts";

export function terminalSymbols(): TerminalSymbols {
  return {
    active: S_STEP_ACTIVE,
    done: S_STEP_DONE,
    cancel: S_STEP_CANCEL,
    bar: barColor(S_BAR),
    barEnd: barColor(S_BAR_END),
    barStart: barColor(S_BAR_START),
    barHorizontal: barColor(S_BAR_H),
    radioOn: S_RADIO_ON,
    radioOff: S_RADIO_OFF,
    checkOn: S_CHECK_ON,
    checkOff: S_CHECK_OFF,
    info: S_INFO,
    warning: S_WARNING,
    error: S_ERROR,
    success: S_SUCCESS,
  };
}
