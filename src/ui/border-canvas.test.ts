import { describe, expect, it } from "vitest";
import { composeBorderCanvas } from "./border-canvas.ts";

const BASE = "blue";
const FOCUS = "magenta";

function stripTags(value: string): string {
  return value.replace(/\{[^}]*\}/g, "");
}

/** Fails loudly instead of silently producing `undefined` (noUncheckedIndexedAccess). */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`index ${index} out of bounds (length ${items.length})`);
  }
  return item;
}

/**
 * Map each row to a per-column color label: "none" for an untagged space,
 * otherwise the color the glyph at that column is wrapped in. Lets tests
 * assert exactly which cells are focus-colored without caring how runs are
 * chunked.
 */
function colorsByColumn(row: string): string[] {
  const colors: string[] = [];
  const tagRun = /\{([^}]+)-fg\}([^{]*)\{\/\1-fg\}/g;
  let cursor = 0;
  for (const match of row.matchAll(tagRun)) {
    const start = match.index;
    for (let i = cursor; i < start; i++) {
      colors.push("none");
    }
    const color = at(match, 1);
    const content = at(match, 2);
    for (const _glyph of content) {
      colors.push(color);
    }
    cursor = start + at(match, 0).length;
  }
  for (let i = cursor; i < row.length; i++) {
    colors.push("none");
  }
  return colors;
}

describe("composeBorderCanvas", () => {
  it("returns [] for non-positive canvas dimensions", () => {
    expect(
      composeBorderCanvas({
        width: 0,
        height: 5,
        rects: [],
        baseColor: BASE,
        focusColor: FOCUS,
      }),
    ).toEqual([]);
    expect(
      composeBorderCanvas({
        width: 5,
        height: 0,
        rects: [],
        baseColor: BASE,
        focusColor: FOCUS,
      }),
    ).toEqual([]);
  });

  it("renders a single rect spanning the whole canvas with rounded corners", () => {
    const rows = composeBorderCanvas({
      width: 5,
      height: 3,
      rects: [
        { rect: { top: 0, left: 0, width: 5, height: 3 }, focused: false },
      ],
      baseColor: BASE,
      focusColor: FOCUS,
    });

    expect(rows).toHaveLength(3);
    expect(rows.every((row) => stripTags(row).length === 5)).toBe(true);
    expect(rows.map(stripTags)).toEqual(["╭───╮", "│   │", "╰───╯"]);
  });

  it("merges a 2x2 grid of rects into shared junctions with no doubled lines", () => {
    const quadrant = (top: number, left: number) => ({
      rect: { top, left, width: 3, height: 3 },
      focused: false,
    });
    const rows = composeBorderCanvas({
      width: 5,
      height: 5,
      rects: [quadrant(0, 0), quadrant(0, 2), quadrant(2, 0), quadrant(2, 2)],
      baseColor: BASE,
      focusColor: FOCUS,
    });

    expect(rows.map(stripTags)).toEqual([
      "╭─┬─╮",
      "│ │ │",
      "├─┼─┤",
      "│ │ │",
      "╰─┴─╯",
    ]);
  });

  it("colors a focused rect's outline with focusColor, including shared edges", () => {
    const quadrant = (top: number, left: number, focused: boolean) => ({
      rect: { top, left, width: 3, height: 3 },
      focused,
    });
    const rows = composeBorderCanvas({
      width: 5,
      height: 5,
      rects: [
        quadrant(0, 0, false),
        quadrant(0, 2, false),
        quadrant(2, 0, false),
        quadrant(2, 2, true), // bottom-right pane is focused
      ],
      baseColor: BASE,
      focusColor: FOCUS,
    });

    // Glyphs are unaffected by focus; only color changes.
    expect(rows.map(stripTags)).toEqual([
      "╭─┬─╮",
      "│ │ │",
      "├─┼─┤",
      "│ │ │",
      "╰─┴─╯",
    ]);

    const colorGrid = rows.map(colorsByColumn);
    expect(colorGrid).toEqual([
      [BASE, BASE, BASE, BASE, BASE],
      [BASE, "none", BASE, "none", BASE],
      [BASE, BASE, FOCUS, FOCUS, FOCUS],
      [BASE, "none", FOCUS, "none", FOCUS],
      [BASE, BASE, FOCUS, FOCUS, FOCUS],
    ]);
  });

  it("degrades junctions correctly when a pane in a 2x2 arrangement is absent", () => {
    // Same 2x2 layout as above, but the bottom-right pane is missing: its
    // corner of the shared gridlines should fall back to plain corners
    // instead of T/cross junctions, and its unique cells go blank.
    const quadrant = (top: number, left: number) => ({
      rect: { top, left, width: 3, height: 3 },
      focused: false,
    });
    const rows = composeBorderCanvas({
      width: 5,
      height: 5,
      rects: [quadrant(0, 0), quadrant(0, 2), quadrant(2, 0)],
      baseColor: BASE,
      focusColor: FOCUS,
    });

    expect(rows.map(stripTags)).toEqual([
      "╭─┬─╮",
      "│ │ │",
      "├─┼─╯",
      "│ │  ",
      "╰─╯  ",
    ]);
  });

  it("renders a rect exactly matching the canvas the same as a full-canvas single rect (zoom)", () => {
    const rows = composeBorderCanvas({
      width: 4,
      height: 4,
      rects: [
        { rect: { top: 0, left: 0, width: 4, height: 4 }, focused: false },
      ],
      baseColor: BASE,
      focusColor: FOCUS,
    });

    expect(rows.map(stripTags)).toEqual(["╭──╮", "│  │", "│  │", "╰──╯"]);
  });

  it("emits minimal tag runs: one open/close pair for a fully unfocused top row", () => {
    const rows = composeBorderCanvas({
      width: 5,
      height: 3,
      rects: [
        { rect: { top: 0, left: 0, width: 5, height: 3 }, focused: false },
      ],
      baseColor: BASE,
      focusColor: FOCUS,
    });

    const topRow = at(rows, 0);
    expect(topRow).toBe(`{${BASE}-fg}╭───╮{/${BASE}-fg}`);
    expect(topRow.match(/\{/g)).toHaveLength(2);
  });
});
