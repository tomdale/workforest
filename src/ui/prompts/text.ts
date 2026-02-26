import chalk from "chalk";
import { FrameRenderer } from "./renderer.ts";
import {
  barColor,
  S_BAR,
  S_BAR_END,
  S_STEP_ACTIVE,
  S_STEP_CANCEL,
  S_STEP_DONE,
} from "./symbols.ts";
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

  return new Promise((resolve, reject) => {
    const renderer = new FrameRenderer();
    let value = defaultValue ?? "";
    let cursor = value.length;
    let errorMessage = "";

    function renderFrame(): void {
      const lines: string[] = [];

      // Header line
      lines.push(`  ${S_STEP_ACTIVE}  ${message}`);

      // Input line
      const displayValue = value || chalk.dim(placeholder ?? "");
      if (errorMessage) {
        lines.push(`  ${barColor(S_BAR)}  ${chalk.yellow(errorMessage)}`);
        lines.push(`  ${barColor(S_BAR)}  ${value}`);
      } else {
        lines.push(`  ${barColor(S_BAR)}  ${displayValue}`);
      }

      // Footer
      lines.push(`  ${barColor(S_BAR_END)}`);

      renderer.render(lines);
    }

    function commitDone(): void {
      const displayValue = value || chalk.dim(defaultValue ?? "");
      renderer.commit([
        `  ${S_STEP_DONE}  ${message} ${chalk.dim("·")} ${displayValue}`,
      ]);
    }

    function handleCancel(): void {
      renderer.clear();
      if (throwOnCancel) {
        cleanup();
        reject(new CancelError());
      } else {
        printCancel();
        cleanup();
        process.exit(0);
      }
    }

    function submit(): void {
      // If empty and we have a default, use it
      const finalValue = value || defaultValue || "";

      if (validate) {
        const error = validate(finalValue);
        if (error) {
          errorMessage = error;
          renderFrame();
          return;
        }
      }

      value = finalValue;
      commitDone();
      cleanup();
      resolve(value);
    }

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write("\x1B[?25l"); // hide cursor

    renderFrame();

    let pendingEscape = "";

    function onData(data: Buffer): void {
      const input = pendingEscape + data.toString();
      pendingEscape = "";
      errorMessage = "";

      // Process input character by character, extracting escape sequences
      let i = 0;
      let changed = false;

      while (i < input.length) {
        const ch = input[i];

        if (ch === "\x03") {
          handleCancel();
          return;
        }

        if (ch === "\r" || ch === "\n") {
          submit();
          return;
        }

        if (ch === "\x7F" || ch === "\b") {
          if (cursor > 0) {
            value = value.slice(0, cursor - 1) + value.slice(cursor);
            cursor--;
            changed = true;
          }
          i++;
          continue;
        }

        // Escape sequences
        if (ch === "\x1B") {
          if (input.length - i < 3) {
            pendingEscape = input.slice(i);
            break;
          }
          const rest = input.slice(i);

          if (rest.startsWith("\x1B[3~")) {
            if (cursor < value.length) {
              value = value.slice(0, cursor) + value.slice(cursor + 1);
              changed = true;
            }
            i += 4;
            continue;
          }
          if (rest.startsWith("\x1B[D")) {
            if (cursor > 0) cursor--;
            changed = true;
            i += 3;
            continue;
          }
          if (rest.startsWith("\x1B[C")) {
            if (cursor < value.length) cursor++;
            changed = true;
            i += 3;
            continue;
          }
          if (rest.startsWith("\x1B[H")) {
            cursor = 0;
            changed = true;
            i += 3;
            continue;
          }
          if (rest.startsWith("\x1B[F")) {
            cursor = value.length;
            changed = true;
            i += 3;
            continue;
          }

          // Skip unknown escape sequences
          i++;
          while (i < input.length && input[i] >= " " && input[i] <= "/") i++;
          if (i < input.length) i++; // skip final byte
          continue;
        }

        // Ctrl+A (Home)
        if (ch === "\x01") {
          cursor = 0;
          changed = true;
          i++;
          continue;
        }

        // Ctrl+E (End)
        if (ch === "\x05") {
          cursor = value.length;
          changed = true;
          i++;
          continue;
        }

        // Regular printable character
        if (ch >= " ") {
          value = value.slice(0, cursor) + ch + value.slice(cursor);
          cursor++;
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

function printCancel(message = "Cancelled"): void {
  process.stdout.write(`  ${S_STEP_CANCEL}  ${chalk.red(message)}\n`);
}
