import { textPrompt } from "../../terminal/inline-widgets.ts";
import { printCancelled } from "./symbols.ts";
import { terminalSymbols } from "./terminal-symbols.ts";
import { CancelError, type PromptBaseOptions } from "./types.ts";

export type TextOptions = PromptBaseOptions & {
  validate?: (input: string) => string | undefined;
  defaultValue?: string;
  placeholder?: string;
};

export async function text(
  message: string,
  options: TextOptions = {},
): Promise<string> {
  const { validate, defaultValue, placeholder, throwOnCancel } = options;

  const result = await textPrompt(message, {
    symbols: terminalSymbols(),
    ...(validate !== undefined ? { validate } : {}),
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    ...(placeholder !== undefined ? { placeholder } : {}),
  });

  if (result.type === "submitted") return result.value;

  if (throwOnCancel) {
    throw new CancelError();
  }

  printCancelled();
  process.exit(0);
}
