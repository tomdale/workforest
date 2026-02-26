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

    function onData(data: Buffer): void {
      const key = data.toString();
      errorMessage = "";

      if (key === "\x03") {
        // Ctrl+C
        handleCancel();
        return;
      }

      if (key === "\r" || key === "\n") {
        submit();
        return;
      }

      if (key === "\x7F" || key === "\b") {
        // Backspace
        if (cursor > 0) {
          value = value.slice(0, cursor - 1) + value.slice(cursor);
          cursor--;
        }
        renderFrame();
        return;
      }

      // Delete key (escape sequence)
      if (key === "\x1B[3~") {
        if (cursor < value.length) {
          value = value.slice(0, cursor) + value.slice(cursor + 1);
        }
        renderFrame();
        return;
      }

      // Arrow keys
      if (key === "\x1B[D") {
        // Left
        if (cursor > 0) cursor--;
        renderFrame();
        return;
      }
      if (key === "\x1B[C") {
        // Right
        if (cursor < value.length) cursor++;
        renderFrame();
        return;
      }

      // Home
      if (key === "\x1B[H" || key === "\x01") {
        cursor = 0;
        renderFrame();
        return;
      }

      // End
      if (key === "\x1B[F" || key === "\x05") {
        cursor = value.length;
        renderFrame();
        return;
      }

      // Ignore other escape sequences
      if (key.startsWith("\x1B")) {
        return;
      }

      // Regular character input
      if (key.length === 1 && key >= " ") {
        value = value.slice(0, cursor) + key + value.slice(cursor);
        cursor++;
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
