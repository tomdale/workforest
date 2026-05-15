import chalk from "chalk";
import { confirmPrompt } from "../../terminal/inline-widgets.ts";
import { S_STEP_CANCEL } from "./symbols.ts";
import { terminalSymbols } from "./terminal-symbols.ts";
import { CancelError, type PromptBaseOptions } from "./types.ts";

export type ConfirmOptions = PromptBaseOptions & {
  initialValue?: boolean;
};

export async function confirm(
  message: string,
  options: ConfirmOptions = {},
): Promise<boolean> {
  const result = await confirmPrompt(
    message,
    options.initialValue ?? false,
    terminalSymbols(),
  );

  if (result.type === "submitted") return result.value;

  if (options.throwOnCancel) {
    throw new CancelError();
  }

  process.stdout.write(`  ${S_STEP_CANCEL}  ${chalk.red("Cancelled")}\n`);
  process.exit(0);
}
