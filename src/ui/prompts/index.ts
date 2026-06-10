import {
  cancel as terminalCancel,
  intro as terminalIntro,
  note as terminalNote,
  outro as terminalOutro,
} from "../../terminal/inline-widgets.ts";
import { terminalColor } from "../../terminal/theme.ts";
import { confirm as rawConfirm } from "./confirm.ts";
import { fuzzySelect as rawFuzzySelect } from "./fuzzy-select.ts";
import { multiSelect as rawMultiSelect } from "./multi-select.ts";
import { select as rawSelect } from "./select.ts";
import {
  spinner as rawSpinner,
  withSpinner as rawWithSpinner,
} from "./spinner.ts";
import {
  barColor,
  S_BAR,
  S_ERROR,
  S_INFO,
  S_SUCCESS,
  S_WARNING,
} from "./symbols.ts";
import { terminalSymbols } from "./terminal-symbols.ts";
import { text as rawText } from "./text.ts";

export type { PromptBaseOptions } from "./types.ts";
// Re-export types
export { CancelError } from "./types.ts";

// ── Type definitions matching src/utils/prompts.ts ──

export type PromptTextOptions = {
  validate?: (input: string) => string | null;
  defaultValue?: string;
  placeholder?: string;
  throwOnCancel?: boolean;
};

export type PromptSelectOption<T> = {
  label: string;
  description?: string;
  value: T;
};

export type PromptSelectOptions<T> = {
  options: PromptSelectOption<T>[];
  hotkeys?: { key: string; value: T; hint: string }[];
  throwOnCancel?: boolean;
};

export type PromptFuzzySelectOptions<T> = {
  options: PromptSelectOption<T>[];
  throwOnCancel?: boolean;
};

export type PromptMultiSelectOptions<T> = {
  options: PromptSelectOption<T>[];
  allowAll?: boolean;
  initialValues?: T[];
  required?: boolean;
  throwOnCancel?: boolean;
};

// ── Prompt wrappers ──

export function isInteractive(): boolean {
  return process.stdin.isTTY === true;
}

export async function promptText(
  message: string,
  options: PromptTextOptions = {},
): Promise<string> {
  const hasDefault =
    options.defaultValue !== undefined && options.defaultValue !== "";

  const result = await rawText(message, {
    ...(hasDefault ? { defaultValue: options.defaultValue } : {}),
    ...(hasDefault ? {} : { placeholder: options.placeholder ?? "(none)" }),
    ...(options.validate
      ? { validate: (v: string) => options.validate?.(v) ?? undefined }
      : {}),
    ...(options.throwOnCancel !== undefined
      ? { throwOnCancel: options.throwOnCancel }
      : {}),
  });

  return result;
}

export async function promptSelect<T>(
  message: string,
  options: PromptSelectOptions<T>,
): Promise<T> {
  return rawSelect(message, {
    options: options.options.map((o) => ({
      value: o.value,
      label: o.label,
      ...(o.description ? { hint: o.description } : {}),
    })),
    ...(options.hotkeys !== undefined ? { hotkeys: options.hotkeys } : {}),
    ...(options.throwOnCancel !== undefined
      ? { throwOnCancel: options.throwOnCancel }
      : {}),
  });
}

export async function promptFuzzySelect<T>(
  message: string,
  options: PromptFuzzySelectOptions<T>,
): Promise<T> {
  return rawFuzzySelect(message, {
    options: options.options.map((o) => ({
      value: o.value,
      label: o.label,
      ...(o.description ? { hint: o.description } : {}),
    })),
    ...(options.throwOnCancel !== undefined
      ? { throwOnCancel: options.throwOnCancel }
      : {}),
  });
}

export async function promptMultiSelect<T>(
  message: string,
  options: PromptMultiSelectOptions<T>,
): Promise<T[]> {
  return rawMultiSelect(message, {
    options: options.options.map((o) => ({
      value: o.value,
      label: o.label,
      ...(o.description ? { hint: o.description } : {}),
    })),
    ...(options.initialValues !== undefined
      ? { initialValues: options.initialValues }
      : {}),
    ...(options.required !== undefined ? { required: options.required } : {}),
    ...(options.allowAll !== undefined ? { allowAll: options.allowAll } : {}),
    ...(options.throwOnCancel !== undefined
      ? { throwOnCancel: options.throwOnCancel }
      : {}),
  });
}

export async function promptConfirm(
  message: string,
  defaultYes = false,
  options?: { throwOnCancel?: boolean },
): Promise<boolean> {
  return rawConfirm(message, {
    initialValue: defaultYes,
    ...(options?.throwOnCancel !== undefined
      ? { throwOnCancel: options.throwOnCancel }
      : {}),
  });
}

// ── Output functions ──

export function intro(title: string): void {
  terminalIntro(title, terminalSymbols());
}

export function outro(message: string): void {
  terminalOutro(message, terminalSymbols());
}

export function cancel(message = "Cancelled"): void {
  terminalCancel(message, terminalSymbols());
}

export function note(content: string, title?: string): void {
  terminalNote(content, title, terminalSymbols());
}

// ── Log functions ──

export const promptLog = {
  info(message: string): void {
    process.stdout.write(`  ${barColor(S_BAR)}  ${S_INFO} ${message}\n`);
  },
  warn(message: string): void {
    process.stdout.write(
      `  ${barColor(S_BAR)}  ${S_WARNING} ${terminalColor.warning(message)}\n`,
    );
  },
  error(message: string): void {
    process.stdout.write(
      `  ${barColor(S_BAR)}  ${S_ERROR} ${terminalColor.error(message)}\n`,
    );
  },
  success(message: string): void {
    process.stdout.write(
      `  ${barColor(S_BAR)}  ${S_SUCCESS} ${terminalColor.success(message)}\n`,
    );
  },
};

// ── Spinner ──

export const spinner = rawSpinner;
export const withSpinner = rawWithSpinner;

// ── Helpers ──
