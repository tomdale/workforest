import { InlineSurface } from "../../terminal/inline-surface.ts";
import {
  renderTerminalLineAnsi,
  terminalLine,
  terminalSpan,
} from "../../terminal/render-model.ts";
import { TerminalSession } from "../../terminal/session.ts";
import { terminalSymbol } from "../../terminal/theme.ts";
import { S_BAR, SPINNER_FRAMES, SPINNER_INTERVAL } from "./symbols.ts";

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
    surface.render([
      renderTerminalLineAnsi(
        terminalLine([
          "  ",
          terminalSpan(S_BAR, { role: "muted" }),
          "  ",
          terminalSpan(SPINNER_FRAMES[frameIndex] ?? "", { role: "accent" }),
          " ",
          currentMessage,
        ]),
      ),
    ]);
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
          process.stdout.write(
            `${renderTerminalLineAnsi(
              terminalLine([
                "  ",
                terminalSpan(S_BAR, { role: "muted" }),
                "  ",
                terminalSpan(terminalSymbol.success, { role: "success" }),
                " ",
                msg,
              ]),
            )}\n`,
          );
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
