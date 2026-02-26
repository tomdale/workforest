import chalk from "chalk";
import { confirm as rawConfirm } from "./confirm.ts";
import { multiSelect as rawMultiSelect } from "./multi-select.ts";
import { select as rawSelect } from "./select.ts";
import { spinner as rawSpinner } from "./spinner.ts";
import {
  barColor,
  S_BAR,
  S_BAR_END,
  S_BAR_H,
  S_BAR_START,
  S_ERROR,
  S_INFO,
  S_STEP_CANCEL,
  S_SUCCESS,
  S_WARNING,
} from "./symbols.ts";
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
    defaultValue: hasDefault ? options.defaultValue : undefined,
    placeholder: hasDefault ? undefined : (options.placeholder ?? "(none)"),
    validate: options.validate
      ? (v) => options.validate?.(v) ?? undefined
      : undefined,
    throwOnCancel: options.throwOnCancel,
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
      hint: o.description,
    })),
    hotkeys: options.hotkeys,
    throwOnCancel: options.throwOnCancel,
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
      hint: o.description,
    })),
    initialValues: options.initialValues,
    required: options.required,
    throwOnCancel: options.throwOnCancel,
  });
}

export async function promptConfirm(
  message: string,
  defaultYes = false,
  options?: { throwOnCancel?: boolean },
): Promise<boolean> {
  return rawConfirm(message, {
    initialValue: defaultYes,
    throwOnCancel: options?.throwOnCancel,
  });
}

// ── Output functions ──

export function intro(title: string): void {
  process.stdout.write(`  ${barColor(S_BAR_START)}  ${title}\n`);
}

export function outro(message: string): void {
  process.stdout.write(`  ${barColor(S_BAR_END)}  ${message}\n`);
}

export function cancel(message = "Cancelled"): void {
  process.stdout.write(`  ${S_STEP_CANCEL}  ${chalk.red(message)}\n`);
}

export function note(content: string, title?: string): void {
  const lines = content.split("\n");
  const maxLen = Math.max(
    title ? title.length : 0,
    ...lines.map((l) => stripAnsi(l).length),
  );
  const pad = maxLen + 2;

  if (title) {
    const rule = S_BAR_H.repeat(Math.max(0, pad - title.length - 1));
    process.stdout.write(
      `  ${barColor(S_BAR_START)}  ${title} ${barColor(rule)}\n`,
    );
  } else {
    process.stdout.write(
      `  ${barColor(S_BAR_START)}${barColor(S_BAR_H.repeat(pad + 1))}\n`,
    );
  }

  process.stdout.write(`  ${barColor(S_BAR)}\n`);

  for (const line of lines) {
    process.stdout.write(`  ${barColor(S_BAR)}  ${line}\n`);
  }

  process.stdout.write(`  ${barColor(S_BAR)}\n`);
  process.stdout.write(
    `  ${barColor(S_BAR_END)}${barColor(S_BAR_H.repeat(pad + 1))}\n`,
  );
}

// ── Log functions ──

export const promptLog = {
  info(message: string): void {
    process.stdout.write(`  ${barColor(S_BAR)}  ${S_INFO} ${message}\n`);
  },
  warn(message: string): void {
    process.stdout.write(
      `  ${barColor(S_BAR)}  ${S_WARNING} ${chalk.yellow(message)}\n`,
    );
  },
  error(message: string): void {
    process.stdout.write(
      `  ${barColor(S_BAR)}  ${S_ERROR} ${chalk.red(message)}\n`,
    );
  },
  success(message: string): void {
    process.stdout.write(
      `  ${barColor(S_BAR)}  ${S_SUCCESS} ${chalk.green(message)}\n`,
    );
  },
};

// ── Spinner ──

export const spinner = rawSpinner;

// ── Helpers ──

function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes requires matching control chars
  return str.replace(/\x1B\[[0-9;]*m/g, "");
}
