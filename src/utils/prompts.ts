import readline from "node:readline";

export type PromptTextOptions = {
  validate?: (input: string) => string | null;
  defaultValue?: string;
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
 * Prompt for yes/no confirmation
 * Returns true for yes, false for no
 */
export async function promptConfirm(
  message: string,
  defaultYes = false,
): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const hint = defaultYes ? "[Y/n]" : "[y/N]";

  try {
    while (true) {
      const answer = await new Promise<string>((resolve) => {
        rl.question(`${message} ${hint}: `, resolve);
      });

      const trimmed = answer.trim().toLowerCase();

      if (trimmed === "") {
        return defaultYes;
      }

      if (trimmed === "y" || trimmed === "yes") {
        return true;
      }

      if (trimmed === "n" || trimmed === "no") {
        return false;
      }

      console.log('  Please enter "y" or "n"');
    }
  } finally {
    rl.close();
  }
}

/**
 * Prompt for text input with optional validation
 */
export async function promptText(
  message: string,
  options: PromptTextOptions = {},
): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const { validate, defaultValue } = options;
  const prompt = defaultValue
    ? `${message} [${defaultValue}]: `
    : `${message}: `;

  try {
    while (true) {
      const answer = await new Promise<string>((resolve) => {
        rl.question(prompt, resolve);
      });

      const value = answer.trim() || defaultValue || "";

      if (validate) {
        const error = validate(value);
        if (error) {
          console.log(`  Error: ${error}`);
          continue;
        }
      }

      return value;
    }
  } finally {
    rl.close();
  }
}

/**
 * Prompt for single selection from a numbered list
 */
export async function promptSelect<T>(
  message: string,
  options: PromptSelectOptions<T>,
): Promise<T> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const { options: selectOptions } = options;

  console.log(message);
  for (const [i, opt] of selectOptions.entries()) {
    const desc = opt.description ? ` - ${opt.description}` : "";
    console.log(`  ${i + 1}. ${opt.label}${desc}`);
  }

  try {
    while (true) {
      const answer = await new Promise<string>((resolve) => {
        rl.question("Selection: ", resolve);
      });

      const num = Number.parseInt(answer.trim(), 10);
      const selected = selectOptions[num - 1];
      if (Number.isNaN(num) || num < 1 || !selected) {
        console.log(
          `  Please enter a number between 1 and ${selectOptions.length}`,
        );
        continue;
      }

      return selected.value;
    }
  } finally {
    rl.close();
  }
}

/**
 * Prompt for multiple selection from a numbered list
 * Accepts comma-separated numbers or "all"
 */
export async function promptMultiSelect<T>(
  message: string,
  options: PromptMultiSelectOptions<T>,
): Promise<T[]> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const { options: selectOptions, allowAll = true } = options;

  console.log(message);
  for (const [i, opt] of selectOptions.entries()) {
    const desc = opt.description ? ` - ${opt.description}` : "";
    console.log(`  ${i + 1}. ${opt.label}${desc}`);
  }

  const hint = allowAll
    ? "(comma-separated numbers or 'all')"
    : "(comma-separated numbers)";

  try {
    while (true) {
      const answer = await new Promise<string>((resolve) => {
        rl.question(`Selection ${hint}: `, resolve);
      });

      const trimmed = answer.trim().toLowerCase();

      if (allowAll && trimmed === "all") {
        return selectOptions.map((opt) => opt.value);
      }

      const parts = trimmed
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const indices: number[] = [];
      let valid = true;

      for (const part of parts) {
        const num = Number.parseInt(part, 10);
        if (Number.isNaN(num) || num < 1 || num > selectOptions.length) {
          console.log(
            `  Invalid selection: ${part}. Please enter numbers between 1 and ${selectOptions.length}`,
          );
          valid = false;
          break;
        }
        if (!indices.includes(num - 1)) {
          indices.push(num - 1);
        }
      }

      if (!valid) {
        continue;
      }

      if (indices.length === 0) {
        console.log("  Please select at least one option");
        continue;
      }

      return indices
        .map((i) => selectOptions[i])
        .filter((opt) => opt !== undefined)
        .map((opt) => opt.value);
    }
  } finally {
    rl.close();
  }
}
