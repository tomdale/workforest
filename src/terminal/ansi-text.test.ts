import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { stripNonSgr, truncateAnsi } from "./ansi-text.ts";

describe("truncateAnsi", () => {
  it("returns an empty string for non-positive widths", () => {
    expect(truncateAnsi("hello", 0)).toBe("");
    expect(truncateAnsi("hello", -3)).toBe("");
  });

  it("returns the value unchanged when it already fits exactly", () => {
    expect(truncateAnsi("hello", 5)).toBe("hello");
  });

  it("truncates a plain string to an ellipsis at exactly the target width", () => {
    const result = truncateAnsi("hello world", 5);
    expect(result.endsWith("…")).toBe(true);
    expect(stringWidth(result)).toBe(5);
  });

  it("truncates SGR-styled text by display width and stays well-formed", () => {
    const styled = "\x1b[31mHello World\x1b[39m";
    const result = truncateAnsi(styled, 5);
    // Display width (escapes cost nothing) lands exactly on the target,
    // and slice-ansi re-closes the color it opened.
    expect(stringWidth(result)).toBe(5);
    expect(result.endsWith("…")).toBe(true);
    expect(result).toContain("\x1b[31m");
    expect(result).toContain("\x1b[39m");
  });

  it("never exceeds the target width for wide glyphs", () => {
    const wide = "古古古古"; // each glyph is 2 columns wide
    const result = truncateAnsi(wide, 5);
    expect(stringWidth(result)).toBeLessThanOrEqual(5);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("stripNonSgr", () => {
  it("keeps SGR color sequences", () => {
    const value = "\x1b[31mred\x1b[39m";
    expect(stripNonSgr(value)).toBe(value);
  });

  it("removes non-SGR CSI sequences like cursor/line clears", () => {
    expect(stripNonSgr("\x1b[2Kcleared")).toBe("cleared");
    expect(stripNonSgr("\x1b[?25hcursor")).toBe("cursor");
  });

  it("removes OSC sequences such as a title change", () => {
    expect(stripNonSgr("\x1b]0;title\x07after")).toBe("after");
  });

  it("removes carriage returns while keeping newlines and tabs", () => {
    expect(stripNonSgr("a\r\nb\tc")).toBe("a\nb\tc");
  });

  it("keeps SGR intact alongside stripped litter in the same string", () => {
    const input = "\x1b[31mred\x1b[2K\x1b]0;title\x07\x1b[39m\r\n";
    expect(stripNonSgr(input)).toBe("\x1b[31mred\x1b[39m\n");
  });
});
