import { Box, NodeRuntime, Screen, setRuntime } from "@unblessed/node";

setRuntime(new NodeRuntime());

export type FullscreenScreen = Screen;
export type FullscreenStatusLine = {
  setContent(content: string): void;
  destroy(): void;
};

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
    style: { fg: "gray" },
  });
}

export function waitForFullscreenKey(screen: FullscreenScreen): Promise<void> {
  return new Promise((resolve) => {
    screen.once("keypress", () => {
      resolve();
    });
  });
}
