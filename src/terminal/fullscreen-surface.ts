import { Box, NodeRuntime, Screen, setRuntime } from "@unblessed/node";
import { activeTheme, toBlessed } from "./theme-system.ts";

setRuntime(new NodeRuntime());

export type FullscreenScreen = Screen;
export type FullscreenStatusLine = {
  setContent(content: string): void;
  destroy(): void;
};

export type FullscreenKeypressRace<T> =
  | { type: "keypress" }
  | { type: "result"; result: T };

export type FullscreenKeypress = {
  readonly received: boolean;
  wait(): Promise<void>;
  race<T>(pending: Promise<T>): Promise<FullscreenKeypressRace<T>>;
};

export const FULLSCREEN_QUIT_KEYS = ["escape", "q", "C-c"] as const;

export function createFullscreenScreen(): FullscreenScreen {
  return new Screen({
    smartCSR: true,
    fullUnicode: true,
    title: "workforest",
  });
}

export function createFullscreenStatusLine(
  screen: FullscreenScreen,
): FullscreenStatusLine {
  return new Box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    padding: { left: 1 },
    style: { fg: toBlessed(activeTheme().palette.muted) },
  });
}

export function createFullscreenKeypress(
  screen: FullscreenScreen,
  keys?: readonly string[],
): FullscreenKeypress {
  let received = false;
  let resolveKeypress!: () => void;
  const keypressPromise = new Promise<void>((resolve) => {
    resolveKeypress = resolve;
  });

  const receive = (): void => {
    if (received) return;
    received = true;
    resolveKeypress();
  };

  if (keys) {
    screen.key([...keys], receive);
  } else {
    screen.once("keypress", receive);
  }

  return {
    get received() {
      return received;
    },
    wait: () => keypressPromise,
    race: async <T>(
      pending: Promise<T>,
    ): Promise<FullscreenKeypressRace<T>> => {
      if (received) return { type: "keypress" };

      return Promise.race([
        keypressPromise.then(() => ({ type: "keypress" as const })),
        pending.then((result) =>
          received
            ? { type: "keypress" as const }
            : { type: "result" as const, result },
        ),
      ]);
    },
  };
}
