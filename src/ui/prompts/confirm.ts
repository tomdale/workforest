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

    function onData(data: Buffer): void {
      const key = data.toString();

      if (key === "\x03") {
        handleCancel();
        return;
      }

      if (key === "\r" || key === "\n") {
        commitDone();
        cleanup();
        resolve(value);
        return;
      }

      // Left arrow or h — select Yes
      if (key === "\x1B[D" || key === "h") {
        value = true;
        renderFrame();
        return;
      }

      // Right arrow or l — select No
      if (key === "\x1B[C" || key === "l") {
        value = false;
        renderFrame();
        return;
      }

      // y/Y — select Yes and submit
      if (key === "y" || key === "Y") {
        value = true;
        commitDone();
        cleanup();
        resolve(value);
        return;
      }

      // n/N — select No and submit
      if (key === "n" || key === "N") {
        value = false;
        commitDone();
        cleanup();
        resolve(value);
        return;
      }

      // Tab toggles
      if (key === "\t") {
        value = !value;
        renderFrame();
        return;
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
