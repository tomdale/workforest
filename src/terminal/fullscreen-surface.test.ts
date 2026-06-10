import { describe, expect, it, vi } from "vitest";
import {
  createFullscreenKeypress,
  FULLSCREEN_QUIT_KEYS,
  type FullscreenScreen,
} from "./fullscreen-surface.ts";

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
