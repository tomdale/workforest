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

export type ConfirmOptions = PromptBaseOptions & {
  initialValue?: boolean;
};

export async function confirm(
  message: string,
  options: ConfirmOptions = {},
): Promise<boolean> {
  const { initialValue = false, throwOnCancel } = options;

  return new Promise((resolve, reject) => {
    const renderer = new FrameRenderer();
    let value = initialValue;

    function renderFrame(): void {
      const yes = value ? chalk.underline("Yes") : chalk.dim("Yes");
      const no = value ? chalk.dim("No") : chalk.underline("No");
      const lines: string[] = [
        `  ${S_STEP_ACTIVE}  ${message}`,
        `  ${barColor(S_BAR)}  ${yes} / ${no}`,
        `  ${barColor(S_BAR_END)}`,
      ];
      renderer.render(lines);
    }

    function commitDone(): void {
      const display = value ? "Yes" : "No";
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

    let pendingEscape = "";

    function onData(data: Buffer): void {
      const input = pendingEscape + data.toString();
      pendingEscape = "";
      let i = 0;
      let changed = false;

      while (i < input.length) {
        const ch = input[i];

        if (ch === "\x03") {
          handleCancel();
          return;
        }

        if (ch === "\r" || ch === "\n") {
          commitDone();
          cleanup();
          resolve(value);
          return;
        }

        if (ch === "\x1B") {
          if (input.length - i < 3) {
            pendingEscape = input.slice(i);
            break;
          }
          const seq = input.slice(i, i + 3);
          if (seq === "\x1B[D") {
            value = true;
            changed = true;
            i += 3;
            continue;
          }
          if (seq === "\x1B[C") {
            value = false;
            changed = true;
            i += 3;
            continue;
          }
          i++;
          continue;
        }

        if (ch === "y" || ch === "Y") {
          value = true;
          commitDone();
          cleanup();
          resolve(value);
          return;
        }

        if (ch === "n" || ch === "N") {
          value = false;
          commitDone();
          cleanup();
          resolve(value);
          return;
        }

        if (ch === "h") {
          value = true;
          changed = true;
        } else if (ch === "l") {
          value = false;
          changed = true;
        } else if (ch === "\t") {
          value = !value;
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
