import { selectPrompt } from "../../terminal/inline-widgets.ts";
import { printCancelled } from "./symbols.ts";
import { terminalSymbols } from "./terminal-symbols.ts";
import { CancelError, type PromptBaseOptions } from "./types.ts";

export type SelectOption<T> = {
  value: T;
  label: string;
  hint?: string;
};

export type SelectHotkey<T> = {
  key: string;
  value: T;
  hint: string;
};

export type SelectOptions<T> = PromptBaseOptions & {
  options: SelectOption<T>[];
  hotkeys?: SelectHotkey<T>[];
};

export async function select<T>(
  message: string,
  options: SelectOptions<T>,
): Promise<T> {
  const result = await selectPrompt(
    message,
    options.options,
    terminalSymbols(),
    options.hotkeys,
  );

  if (result.type === "submitted") return result.value;

  if (options.throwOnCancel) {
    throw new CancelError();
  }

  printCancelled();
  process.exit(0);
}
