import {
  filterFuzzyChoices,
  fuzzySelectPrompt,
} from "../../terminal/inline-widgets.ts";
import { printCancelled } from "./symbols.ts";
import { terminalSymbols } from "./terminal-symbols.ts";
import { CancelError, type PromptBaseOptions } from "./types.ts";

export type FuzzySelectOption<T> = {
  value: T;
  label: string;
  hint?: string;
};

export type FuzzySelectOptions<T> = PromptBaseOptions & {
  options: FuzzySelectOption<T>[];
};

export function filterFuzzySelectOptions<T>(
  options: FuzzySelectOption<T>[],
  query: string,
): FuzzySelectOption<T>[] {
  return filterFuzzyChoices(options, query);
}

export async function fuzzySelect<T>(
  message: string,
  options: FuzzySelectOptions<T>,
): Promise<T> {
  const result = await fuzzySelectPrompt(
    message,
    options.options,
    terminalSymbols(),
  );

  if (result.type === "submitted") return result.value;

  if (options.throwOnCancel) {
    throw new CancelError();
  }

  printCancelled();
  process.exit(0);
}
