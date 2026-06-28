import { describe, expect, it, vi } from "vitest";

const { boxes, MockBox } = vi.hoisted(() => {
  class HoistedMockBox {
    top: number | string | undefined;
    left: number | string | undefined;
    width: number | string | undefined;
    height: number | string | undefined;
    content = "";
    destroyed = false;

    constructor(options: {
      top?: number | string;
      left?: number | string;
      width?: number | string;
      height?: number | string;
    }) {
      this.top = options.top;
      this.left = options.left;
      this.width = options.width;
      this.height = options.height;
      boxes.push(this);
    }

    setContent(content: string): void {
      this.content = content;
    }

    destroy(): void {
      this.destroyed = true;
    }
  }
  const boxes: HoistedMockBox[] = [];
  return { boxes, MockBox: HoistedMockBox };
});

vi.mock("@unblessed/node", () => ({
  Box: MockBox,
  NodeRuntime: class {},
  Screen: class {},
  setRuntime: vi.fn(),
}));

import {
  createFullscreenKeypress,
  createFullscreenStage,
  FULLSCREEN_MAX_HEIGHT,
  FULLSCREEN_MAX_WIDTH,
  FULLSCREEN_QUIT_KEYS,
  type FullscreenScreen,
  fullscreenViewport,
} from "./fullscreen-surface.ts";

function createMockScreen(
  width: number,
  height: number,
): FullscreenScreen & {
  width: number;
  height: number;
  emitResize(): void;
  listenerCount(event: string): number;
  render: ReturnType<typeof vi.fn>;
} {
  const listeners = new Map<string, Set<() => void>>();
  return {
    width,
    height,
    render: vi.fn(),
    on: vi.fn((event: string, listener: () => void) => {
      const set = listeners.get(event) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(event, set);
      return undefined;
    }),
    off: vi.fn((event: string, listener: () => void) => {
      listeners.get(event)?.delete(listener);
      return undefined;
    }),
    emitResize: () => {
      for (const listener of listeners.get("resize") ?? []) listener();
    },
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
  } as unknown as FullscreenScreen & {
    width: number;
    height: number;
    emitResize(): void;
    listenerCount(event: string): number;
    render: ReturnType<typeof vi.fn>;
  };
}

function lineLengths(content: string): number[] {
  return content.split("\n").map((line) => line.length);
}

describe("fullscreenViewport", () => {
  it("collapses to the terminal when it is within the cap", () => {
    expect(fullscreenViewport({ width: 100, height: 30 })).toEqual({
      top: 0,
      left: 0,
      width: 100,
      height: 30,
    });
  });

  it("treats a terminal exactly at the cap as full-bleed", () => {
    expect(
      fullscreenViewport({
        width: FULLSCREEN_MAX_WIDTH,
        height: FULLSCREEN_MAX_HEIGHT,
      }),
    ).toEqual({
      top: 0,
      left: 0,
      width: FULLSCREEN_MAX_WIDTH,
      height: FULLSCREEN_MAX_HEIGHT,
    });
  });

  it("caps and centers a terminal larger than the cap", () => {
    // 220 - 112 = 108 → 54 of margin each side; 60 - 34 = 26 → 13 each side.
    expect(fullscreenViewport({ width: 220, height: 60 })).toEqual({
      top: 13,
      left: 54,
      width: FULLSCREEN_MAX_WIDTH,
      height: FULLSCREEN_MAX_HEIGHT,
    });
  });

  it("floors an odd leftover margin so the rect stays on whole cells", () => {
    // One past the cap on each axis → floor(0.5) = 0 offset, size stays capped.
    expect(
      fullscreenViewport({
        width: FULLSCREEN_MAX_WIDTH + 1,
        height: FULLSCREEN_MAX_HEIGHT + 1,
      }),
    ).toEqual({
      top: 0,
      left: 0,
      width: FULLSCREEN_MAX_WIDTH,
      height: FULLSCREEN_MAX_HEIGHT,
    });
  });

  it("falls back to the cap when a dimension is not a usable number", () => {
    // An unsized fake screen (NaN dimensions) gets the max, never a zero rect.
    expect(fullscreenViewport({ width: Number.NaN, height: 0 })).toEqual({
      top: 0,
      left: 0,
      width: FULLSCREEN_MAX_WIDTH,
      height: FULLSCREEN_MAX_HEIGHT,
    });
  });
});

describe("createFullscreenStage", () => {
  it("reflows the capped stage and backdrop when the screen resizes", () => {
    boxes.length = 0;
    const screen = createMockScreen(220, 60);

    const stage = createFullscreenStage(screen);
    const backdrop = boxes[0];

    expect(stage.left).toBe(54);
    expect(stage.top).toBe(13);
    expect(stage.width).toBe(FULLSCREEN_MAX_WIDTH);
    expect(stage.height).toBe(FULLSCREEN_MAX_HEIGHT);
    expect(backdrop?.content.split("\n")).toHaveLength(60);
    expect(lineLengths(backdrop?.content ?? "")).toEqual(Array(60).fill(220));

    screen.width = 80;
    screen.height = 24;
    screen.emitResize();

    expect(stage.left).toBe(0);
    expect(stage.top).toBe(0);
    expect(stage.width).toBe(80);
    expect(stage.height).toBe(24);
    expect(backdrop?.content.split("\n")).toHaveLength(24);
    expect(lineLengths(backdrop?.content ?? "")).toEqual(Array(24).fill(80));
    expect(screen.render).toHaveBeenCalledTimes(1);
  });

  it("removes the resize listener when the stage is destroyed", () => {
    boxes.length = 0;
    const screen = createMockScreen(220, 60);

    const stage = createFullscreenStage(screen);
    expect(screen.listenerCount("resize")).toBe(1);

    stage.destroy();

    expect(screen.listenerCount("resize")).toBe(0);
  });
});

describe("createFullscreenKeypress", () => {
  it("gives a received keypress priority over already queued work", async () => {
    let receive!: () => void;
    const screen = {
      key: vi.fn((_keys: string[], handler: () => void) => {
        receive = handler;
      }),
    } as unknown as FullscreenScreen;
    const keypress = createFullscreenKeypress(screen, FULLSCREEN_QUIT_KEYS);
    const pending = Promise.resolve("output");

    await Promise.resolve();
    receive();

    await expect(keypress.race(pending)).resolves.toEqual({
      type: "keypress",
    });
    expect(keypress.received).toBe(true);
    await expect(keypress.wait()).resolves.toBeUndefined();
  });

  it("returns pending work while no keypress has been received", async () => {
    const screen = {
      once: vi.fn(),
    } as unknown as FullscreenScreen;
    const keypress = createFullscreenKeypress(screen);

    await expect(keypress.race(Promise.resolve("output"))).resolves.toEqual({
      type: "result",
      result: "output",
    });
    expect(keypress.received).toBe(false);
  });
});
