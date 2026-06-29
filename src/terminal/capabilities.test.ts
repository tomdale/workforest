import { describe, expect, it } from "vitest";
import { shouldUseFullscreenTui } from "./capabilities.ts";

describe("terminal capabilities", () => {
  it("requires a capable TTY and honors TUI-disabling env vars", () => {
    const tty = {
      stdin: { isTTY: true },
      stdout: { isTTY: true, columns: 100, rows: 30 },
      env: {},
    };

    expect(shouldUseFullscreenTui(tty)).toBe(true);
    expect(
      shouldUseFullscreenTui({
        ...tty,
        stdout: { isTTY: true, columns: 79, rows: 30 },
      }),
    ).toBe(false);
    expect(
      shouldUseFullscreenTui({
        ...tty,
        stdout: { isTTY: true, columns: 100, rows: 19 },
      }),
    ).toBe(false);
    expect(
      shouldUseFullscreenTui({
        ...tty,
        env: { CI: "1" },
      }),
    ).toBe(false);
    expect(
      shouldUseFullscreenTui({
        ...tty,
        env: { WORKFOREST_NO_TUI: "1" },
      }),
    ).toBe(false);
  });
});
