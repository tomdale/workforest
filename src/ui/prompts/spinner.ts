import chalk from "chalk";
import {
  barColor,
  S_BAR,
  S_SUCCESS,
  SPINNER_FRAMES,
  SPINNER_INTERVAL,
} from "./symbols.ts";

export type Spinner = {
  start(message?: string): void;
  stop(message?: string): void;
  message(text: string): void;
};

export function spinner(): Spinner {
  let frameIndex = 0;
  let currentMessage = "";
  let interval: ReturnType<typeof setInterval> | null = null;
  let lineCount = 0;

  function erase(): void {
    if (lineCount > 0) {
      process.stdout.write(`\x1B[${lineCount}A`);
      for (let i = 0; i < lineCount; i++) {
        process.stdout.write("\x1B[2K");
        if (i < lineCount - 1) {
          process.stdout.write("\x1B[1B");
        }
      }
      if (lineCount > 1) {
        process.stdout.write(`\x1B[${lineCount - 1}A`);
      }
      lineCount = 0;
    }
  }

  function draw(): void {
    erase();
    const frame = chalk.cyan(SPINNER_FRAMES[frameIndex]);
    const line = `  ${barColor(S_BAR)}  ${frame} ${currentMessage}`;
    process.stdout.write(`${line}\n`);
    lineCount = 1;
    frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
  }

  return {
    start(msg = "") {
      currentMessage = msg;
      process.stdout.write("\x1B[?25l"); // hide cursor
      draw();
      interval = setInterval(draw, SPINNER_INTERVAL);
    },

    stop(msg) {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      erase();
      if (msg) {
        process.stdout.write(`  ${barColor(S_BAR)}  ${S_SUCCESS} ${msg}\n`);
      }
      process.stdout.write("\x1B[?25h"); // show cursor
    },

    message(text) {
      currentMessage = text;
    },
  };
}
