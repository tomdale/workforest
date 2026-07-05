import { NodeRuntime, setRuntime, unicode } from "@unblessed/node";
import { describe, expect, it } from "vitest";

// Pins patches/@unblessed__core@1.0.0-alpha.23.patch: upstream hardcodes
// U+2714-U+2716 as double-width, while wcwidth and real terminals render
// them single-width (see src/ui/setup-view/terminal-tail.ts and
// src/terminal/theme-system.ts, both of which now emit these glyphs bare on
// the strength of this being fixed). If this test fails, an @unblessed
// upgrade has dropped the patch's dist files; rebase
// patches/@unblessed__core@1.0.0-alpha.23.patch onto the new version.
describe("@unblessed/core patched width table", () => {
  it("treats the heavy check mark and cross as single-width", () => {
    // unicode.charWidth reaches into a runtime-config lookup that throws
    // "Runtime not initialized" until a Node/browser runtime is registered;
    // fullscreen-surface.ts does this same call for the app's real Screen.
    setRuntime(new NodeRuntime());

    expect(unicode.charWidth("✔", 0)).toBe(1); // U+2714 heavy check mark
    expect(unicode.charWidth("✖", 0)).toBe(1); // U+2716 heavy multiplication x
    expect(unicode.charWidth("✓", 0)).toBe(1); // U+2713 check mark (never wide)
  });
});
