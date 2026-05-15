import chalk from "chalk";
import { multiSelectPrompt } from "../../terminal/inline-widgets.ts";
import { S_STEP_CANCEL } from "./symbols.ts";
import { terminalSymbols } from "./terminal-symbols.ts";
import { CancelError, type PromptBaseOptions } from "./types.ts";

export type MultiSelectOption<T> = {
  value: T;
  label: string;
  hint?: string;
};

export type MultiSelectOptions<T> = PromptBaseOptions & {
  options: MultiSelectOption<T>[];
  initialValues?: T[];
  required?: boolean;
  allowAll?: boolean;
};

export async function multiSelect<T>(
  message: string,
  options: MultiSelectOptions<T>,
): Promise<T[]> {
  const result = await multiSelectPrompt(message, options.options, {
    symbols: terminalSymbols(),
    ...(options.initialValues !== undefined
      ? { initialValues: options.initialValues }
      : {}),
    ...(options.required !== undefined ? { required: options.required } : {}),
    ...(options.allowAll !== undefined ? { allowAll: options.allowAll } : {}),
  });

  if (result.type === "submitted") return result.value;

  if (options.throwOnCancel) {
    throw new CancelError();
  }

  process.stdout.write(`  ${S_STEP_CANCEL}  ${chalk.red("Cancelled")}\n`);
  process.exit(0);
}
