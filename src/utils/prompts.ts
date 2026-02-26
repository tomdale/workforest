import * as p from "@clack/prompts";

export type PromptTextOptions = {
  validate?: (input: string) => string | null;
  defaultValue?: string;
  placeholder?: string;
};

export type PromptSelectOption<T> = {
  label: string;
  description?: string;
  value: T;
};

export type PromptSelectOptions<T> = {
  options: PromptSelectOption<T>[];
};

export type PromptMultiSelectOptions<T> = {
  options: PromptSelectOption<T>[];
  allowAll?: boolean;
};

/**
 * Check if stdin is interactive (TTY)
 */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true;
}

/**
 * Prompt for yes/no confirmation using clack
 * Returns true for yes, false for no
 */
export async function promptConfirm(
  message: string,
  defaultYes = false,
): Promise<boolean> {
  const result = await p.confirm({ message, initialValue: defaultYes });
  if (p.isCancel(result)) {
    p.cancel("Cancelled");
    process.exit(0);
  }
  return result;
}

/**
 * Prompt for text input with optional validation using clack
 */
export async function promptText(
  message: string,
  options: PromptTextOptions = {},
): Promise<string> {
  const hasDefault =
    options.defaultValue !== undefined && options.defaultValue !== "";
  const placeholderText = hasDefault
    ? undefined
    : (options.placeholder ?? "(none)");
  const result = await p.text({
    message,
    ...(hasDefault
      ? { defaultValue: options.defaultValue }
      : { placeholder: placeholderText }),
    validate: options.validate
      ? (v) => options.validate?.(v) ?? undefined
      : undefined,
  });
  if (p.isCancel(result)) {
    p.cancel("Cancelled");
    process.exit(0);
  }
  // Clack returns the placeholder text when the user submits without typing
  if (placeholderText && result === placeholderText) {
    return "";
  }
  return result;
}

/**
 * Prompt for single selection from a list using clack
 */
export async function promptSelect<T>(
  message: string,
  options: PromptSelectOptions<T>,
): Promise<T> {
  const result = await p.select({
    message,
    options: options.options.map((o) => ({
      value: o.value,
      label: o.label,
      hint: o.description,
    })),
  });
  if (p.isCancel(result)) {
    p.cancel("Cancelled");
    process.exit(0);
  }
  return result;
}

/**
 * Prompt for multiple selection from a list using clack
 */
export async function promptMultiSelect<T>(
  message: string,
  options: PromptMultiSelectOptions<T>,
): Promise<T[]> {
  const result = await p.multiselect({
    message,
    options: options.options.map((o) => ({
      value: o.value,
      label: o.label,
      hint: o.description,
    })),
  });
  if (p.isCancel(result)) {
    p.cancel("Cancelled");
    process.exit(0);
  }
  return result;
}
