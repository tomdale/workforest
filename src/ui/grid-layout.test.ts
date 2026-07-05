import { describe, expect, it, vi } from "vitest";

type FakeBoxRecord = {
  top: number;
  left: number;
  width: number;
  height: number;
  hidden: boolean;
  content: string;
  style: { fg?: string };
};

const created = vi.hoisted(() => ({
  boxes: [] as FakeBoxRecord[],
}));

// @unblessed/node requires a real TTY; replace it with recorders so layout
// math (bounds, reflow, zoom, visibility, canvas composition) is observable
// without a terminal.
vi.mock("@unblessed/node", () => {
  class FakeBox {
    top: number;
    left: number;
    width: number;
    height: number;
    hidden = false;
    content = "";
    style: { fg?: string };

    constructor(options: {
      top?: number;
      left?: number;
      width?: number;
      height?: number;
      style?: { fg?: string };
    }) {
      this.top = options.top ?? 0;
      this.left = options.left ?? 0;
      this.width = options.width ?? 0;
      this.height = options.height ?? 0;
      this.style = options.style ?? {};
      created.boxes.push(this as unknown as FakeBoxRecord);
    }

    setContent(content: string): void {
      this.content = content;
    }
    hide(): void {
      this.hidden = true;
    }
    show(): void {
      this.hidden = false;
    }
    key(): void {}
    scroll(): void {}
    setScrollPerc(): void {}
    destroy(): void {}
  }

  return {
    Box: FakeBox,
    ScrollableBox: FakeBox,
    Screen: FakeBox,
    setRuntime: (): void => {},
    NodeRuntime: class {},
  };
});

import type { Screen } from "@unblessed/node";
import { calculateGridDimensions, GridLayout } from "./grid-layout.ts";

function stripTags(value: string): string {
  return value.replace(/\{[^}]*\}/g, "");
}

type MutableSize = { width: number; height: number };

type GridHandles = {
  grid: GridLayout;
  parent: MutableSize;
  /** The shared border canvas: created before any pane, holds every gridline. */
  canvas: () => FakeBoxRecord;
  /** Pane `index`'s own content box (its ScrollableBox), not the canvas. */
  contentOf: (index: number) => FakeBoxRecord;
};

function createGrid(options: {
  rows: number;
  cols: number;
  width?: number;
  height?: number;
  contentColor?: string;
  focusContentColor?: string;
}): GridHandles {
  created.boxes.length = 0;
  const parent = { width: options.width ?? 10, height: options.height ?? 6 };
  const screen = {
    render: vi.fn(),
    width: parent.width,
    height: parent.height,
  };
  const grid = new GridLayout({
    screen: screen as unknown as Screen,
    parent: parent as unknown as Screen,
    rows: options.rows,
    cols: options.cols,
    borderColor: "cyan",
    focusBorderColor: "magenta",
    ...(options.contentColor ? { contentColor: options.contentColor } : {}),
    ...(options.focusContentColor
      ? { focusContentColor: options.focusContentColor }
      : {}),
  });
  return {
    grid,
    parent,
    canvas: () => {
      const box = created.boxes[0];
      if (!box) throw new Error("No canvas box recorded.");
      return box;
    },
    contentOf: (index: number) => {
      const box = created.boxes[1 + index];
      if (!box) throw new Error(`No content box recorded for pane ${index}.`);
      return box;
    },
  };
}

describe("calculateGridDimensions", () => {
  it.each([
    [0, { rows: 1, cols: 1 }],
    [1, { rows: 1, cols: 1 }],
    [2, { rows: 1, cols: 2 }],
    [3, { rows: 2, cols: 2 }],
    [4, { rows: 2, cols: 2 }],
    [5, { rows: 2, cols: 3 }],
    [6, { rows: 2, cols: 3 }],
    [7, { rows: 3, cols: 3 }],
    [9, { rows: 3, cols: 3 }],
  ])("maps %i repos to grid dimensions", (repoCount, dimensions) => {
    expect(calculateGridDimensions(repoCount)).toEqual(dimensions);
  });
});

describe("GridLayout border canvas", () => {
  it("creates the shared canvas before any pane's content box, sized to the frame", () => {
    const { canvas, contentOf } = createGrid({
      rows: 2,
      cols: 2,
      width: 5,
      height: 5,
    });
    expect(canvas()).toMatchObject({ top: 0, left: 0, width: 5, height: 5 });
    // Order matters: the canvas must exist before pane content boxes are
    // constructed, so gridlines paint underneath their content, not over it.
    expect(contentOf(0)).toBeDefined();
  });

  it("merges a 2x2 grid into one canvas with shared junctions, no doubled lines", () => {
    const { canvas } = createGrid({ rows: 2, cols: 2, width: 5, height: 5 });
    expect(stripTags(canvas().content).split("\n")).toEqual([
      "╭─┬─╮",
      "│ │ │",
      "├─┼─┤",
      "│ │ │",
      "╰─┴─╯",
    ]);
  });

  it("recomposes the canvas so a hidden pane degrades its junctions", () => {
    const { grid, canvas } = createGrid({
      rows: 2,
      cols: 2,
      width: 5,
      height: 5,
    });

    grid.hidePane(3);
    expect(stripTags(canvas().content).split("\n")).toEqual([
      "╭─┬─╮",
      "│ │ │",
      "├─┼─╯",
      "│ │  ",
      "╰─╯  ",
    ]);

    grid.setVisiblePane(3);
    expect(stripTags(canvas().content).split("\n")).toEqual([
      "╭─┬─╮",
      "│ │ │",
      "├─┼─┤",
      "│ │ │",
      "╰─┴─╯",
    ]);
  });

  it("colors a focused pane's outline without changing any glyph", () => {
    const { grid, canvas } = createGrid({
      rows: 2,
      cols: 2,
      width: 5,
      height: 5,
    });
    const before = canvas().content;

    grid.getPane(3)?.setFocused(true);
    const after = canvas().content;

    expect(after).not.toBe(before);
    expect(stripTags(after)).toBe(stripTags(before));
    expect(after).toContain("{magenta-fg}");
  });

  it("collapses to a single full-frame rect while zoomed", () => {
    const { grid, canvas } = createGrid({
      rows: 1,
      cols: 2,
      width: 10,
      height: 6,
    });

    grid.setZoomedPane(1);
    expect(stripTags(canvas().content).split("\n")).toEqual([
      `╭${"─".repeat(8)}╮`,
      ...Array.from({ length: 4 }, () => `│${" ".repeat(8)}│`),
      `╰${"─".repeat(8)}╯`,
    ]);
  });
});

describe("GridLayout content bounds", () => {
  it("derives content-box bounds from the gridline math", () => {
    const { contentOf } = createGrid({
      rows: 2,
      cols: 2,
      width: 10,
      height: 6,
    });

    expect(contentOf(0)).toMatchObject({
      top: 1,
      left: 1,
      width: 4,
      height: 2,
    });
    expect(contentOf(1)).toMatchObject({
      top: 1,
      left: 6,
      width: 3,
      height: 2,
    });
    expect(contentOf(2)).toMatchObject({
      top: 4,
      left: 1,
      width: 4,
      height: 1,
    });
    expect(contentOf(3)).toMatchObject({
      top: 4,
      left: 6,
      width: 3,
      height: 1,
    });
  });

  it("exposes the same bounds through getContentSize", () => {
    const { grid } = createGrid({ rows: 2, cols: 2, width: 10, height: 6 });
    expect(grid.getPane(0)?.getContentSize()).toEqual({ width: 4, height: 2 });
    expect(grid.getPane(3)?.getContentSize()).toEqual({ width: 3, height: 1 });
  });
});

describe("GridLayout zoom and visibility", () => {
  it("zooms one pane to the full frame and restores the grid on un-zoom", () => {
    const { grid, contentOf } = createGrid({
      rows: 1,
      cols: 2,
      width: 10,
      height: 6,
    });

    grid.setZoomedPane(1);
    expect(contentOf(0).hidden).toBe(true);
    expect(contentOf(1).hidden).toBe(false);
    expect(contentOf(1)).toMatchObject({
      top: 1,
      left: 1,
      width: 8,
      height: 4,
    });
    expect(grid.getPane(1)?.getContentSize()).toEqual({ width: 8, height: 4 });

    grid.setZoomedPane(null);
    expect(contentOf(0).hidden).toBe(false);
    expect(contentOf(1)).toMatchObject({ top: 1, left: 6, width: 3 });
  });

  it("hides and shows individual panes for paging", () => {
    const { grid, contentOf } = createGrid({
      rows: 1,
      cols: 2,
      width: 10,
      height: 6,
    });

    grid.hidePane(1);
    expect(contentOf(1).hidden).toBe(true);
    expect(contentOf(0).hidden).toBe(false);

    grid.setVisiblePane(1);
    expect(contentOf(1).hidden).toBe(false);
  });

  it("keeps hidden panes hidden across a reflow", () => {
    const { grid, parent, contentOf } = createGrid({
      rows: 1,
      cols: 2,
      width: 10,
      height: 6,
    });

    grid.hidePane(0);
    parent.width = 20;
    grid.reflow();

    expect(contentOf(0).hidden).toBe(true);
    expect(contentOf(1).hidden).toBe(false);
  });
});

describe("GridLayout reflow", () => {
  it("recomputes cell bounds and canvas dimensions from the parent's current size", () => {
    const { grid, parent, canvas, contentOf } = createGrid({
      rows: 1,
      cols: 2,
      width: 100,
      height: 40,
    });

    expect(canvas()).toMatchObject({ top: 0, left: 0, width: 100, height: 40 });
    expect(contentOf(0)).toMatchObject({
      top: 1,
      left: 1,
      width: 49,
      height: 38,
    });
    expect(contentOf(1)).toMatchObject({
      top: 1,
      left: 51,
      width: 48,
      height: 38,
    });

    parent.width = 60;
    parent.height = 20;
    grid.reflow();

    expect(canvas()).toMatchObject({ top: 0, left: 0, width: 60, height: 20 });
    expect(contentOf(0)).toMatchObject({
      top: 1,
      left: 1,
      width: 29,
      height: 18,
    });
    expect(contentOf(1)).toMatchObject({
      top: 1,
      left: 31,
      width: 28,
      height: 18,
    });
  });
});

describe("GridLayout focus", () => {
  it("swaps content fg between contentColor and focusContentColor when both are given", () => {
    const { grid, contentOf } = createGrid({
      rows: 1,
      cols: 2,
      contentColor: "dim-color",
      focusContentColor: "focus-color",
    });
    const pane = grid.getPane(0);

    expect(contentOf(0).style.fg).toBe("dim-color");
    pane?.setFocused(true);
    expect(contentOf(0).style.fg).toBe("focus-color");
    pane?.setFocused(false);
    expect(contentOf(0).style.fg).toBe("dim-color");
  });

  it("leaves content fg untouched for legacy callers that pass neither color", () => {
    const { grid, contentOf } = createGrid({ rows: 1, cols: 2 });
    const pane = grid.getPane(0);

    expect(contentOf(0).style.fg).toBeUndefined();
    pane?.setFocused(true);
    expect(contentOf(0).style.fg).toBeUndefined();
  });
});

describe("GridLayout labels", () => {
  it("positions a pane's label over its top gridline", () => {
    const { grid, contentOf } = createGrid({
      rows: 2,
      cols: 2,
      width: 10,
      height: 6,
    });
    const pane = grid.getPane(0);
    pane?.setLabel("repo");

    const label = created.boxes.at(-1);
    if (!label) throw new Error("No label box recorded.");
    const content = contentOf(0);
    expect(label.top).toBe(content.top - 1);
    expect(label.left).toBe(content.left);
    expect(label.width).toBe(content.width);
  });
});
