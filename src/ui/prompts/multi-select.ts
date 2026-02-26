import chalk from "chalk";
import { FrameRenderer } from "./renderer.ts";
import {
  barColor,
  S_BAR,
  S_BAR_END,
  S_CHECK_OFF,
  S_CHECK_ON,
  S_STEP_ACTIVE,
  S_STEP_CANCEL,
  S_STEP_DONE,
} from "./symbols.ts";
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
};

export async function multiSelect<T>(
  message: string,
  options: MultiSelectOptions<T>,
): Promise<T[]> {
  const {
    options: items,
    initialValues,
    required = true,
    throwOnCancel,
  } = options;

  return new Promise((resolve, reject) => {
    const renderer = new FrameRenderer();
    let cursorIndex = 0;
    const checked = new Set<number>(
      initialValues
        ? items
            .map((item, i) => (initialValues.includes(item.value) ? i : -1))
            .filter((i) => i >= 0)
        : [],
    );

    function renderFrame(): void {
      const lines: string[] = [];
      lines.push(`  ${S_STEP_ACTIVE}  ${message}`);

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const isCursor = i === cursorIndex;
        const isChecked = checked.has(i);
        const check = isChecked ? S_CHECK_ON : S_CHECK_OFF;
        const label = isCursor ? item.label : chalk.dim(item.label);
        const hint = item.hint ? chalk.dim(` ${item.hint}`) : "";
        lines.push(`  ${barColor(S_BAR)}  ${check} ${label}${hint}`);
      }

      lines.push(`  ${barColor(S_BAR_END)}`);
      renderer.render(lines);
    }

    function commitDone(): void {
      const selected = items
        .filter((_, i) => checked.has(i))
        .map((item) => item.label);
      const display = selected.length > 0 ? selected.join(", ") : "none";
      renderer.commit([
        `  ${S_STEP_DONE}  ${message} ${chalk.dim("·")} ${display}`,
      ]);
    }

    function handleCancel(): void {
      renderer.clear();
      if (throwOnCancel) {
        cleanup();
        reject(new CancelError());
      } else {
        process.stdout.write(`  ${S_STEP_CANCEL}  ${chalk.red("Cancelled")}\n`);
        cleanup();
        process.exit(0);
      }
    }

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write("\x1B[?25l"); // hide cursor

    renderFrame();

    function onData(data: Buffer): void {
      const input = data.toString();
      let i = 0;
      let changed = false;

      while (i < input.length) {
        const ch = input[i];

        if (ch === "\x03") {
          handleCancel();
          return;
        }

        if (ch === "\r" || ch === "\n") {
          if (required && checked.size === 0) {
            return;
          }
          commitDone();
          cleanup();
          resolve(
            items
              .filter((_, idx) => checked.has(idx))
              .map((item) => item.value),
          );
          return;
        }

        if (ch === "\x1B" && i + 2 < input.length) {
          const seq = input.slice(i, i + 3);
          if (seq === "\x1B[A") {
            cursorIndex = (cursorIndex - 1 + items.length) % items.length;
            changed = true;
            i += 3;
            continue;
          }
          if (seq === "\x1B[B") {
            cursorIndex = (cursorIndex + 1) % items.length;
            changed = true;
            i += 3;
            continue;
          }
          i++;
          continue;
        }

        if (ch === " ") {
          if (checked.has(cursorIndex)) {
            checked.delete(cursorIndex);
          } else {
            checked.add(cursorIndex);
          }
          changed = true;
        } else if (ch === "k") {
          cursorIndex = (cursorIndex - 1 + items.length) % items.length;
          changed = true;
        } else if (ch === "j") {
          cursorIndex = (cursorIndex + 1) % items.length;
          changed = true;
        } else if (ch === "a") {
          if (checked.size === items.length) {
            checked.clear();
          } else {
            for (let idx = 0; idx < items.length; idx++) {
              checked.add(idx);
            }
          }
          changed = true;
        }

        i++;
      }

      if (changed) {
        renderFrame();
      }
    }

    function cleanup(): void {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      process.stdout.write("\x1B[?25h"); // show cursor
    }

    stdin.on("data", onData);
  });
}
