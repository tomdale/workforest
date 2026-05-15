import chalk from "chalk";
import { InlineSurface } from "../../terminal/inline-surface.ts";
import { TerminalSession } from "../../terminal/session.ts";
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

export async function withSpinner<T>(
  message: string,
  task: (spinner: Spinner) => Promise<T>,
  successMessage?: string,
): Promise<T> {
  const s = spinner();
  let stopped = false;

  s.start(message);

  try {
    const result = await task(s);
    s.stop(successMessage);
    stopped = true;
    return result;
  } finally {
    if (!stopped) {
      s.stop();
    }
  }
}

export function spinner(): Spinner {
  let frameIndex = 0;
  let currentMessage = "";
  let interval: ReturnType<typeof setInterval> | null = null;
  let session: TerminalSession | null = null;
  const surface = new InlineSurface(process.stdout);

  function draw(): void {
    const frame = chalk.cyan(SPINNER_FRAMES[frameIndex]);
    surface.render([`  ${barColor(S_BAR)}  ${frame} ${currentMessage}`]);
    frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
  }

  function teardown(): void {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    session?.teardown();
    session = null;
  }

  return {
    start(msg = "") {
      if (session) return;
      currentMessage = msg;
      session = new TerminalSession({ cursor: "hide" });
      draw();
      interval = setInterval(draw, SPINNER_INTERVAL);
    },

    stop(msg) {
      try {
        if (interval) {
          clearInterval(interval);
          interval = null;
        }
        surface.clear();
        if (msg) {
          process.stdout.write(`  ${barColor(S_BAR)}  ${S_SUCCESS} ${msg}\n`);
        }
      } finally {
        teardown();
      }
    },

    message(text) {
      currentMessage = text;
    },
  };
}
