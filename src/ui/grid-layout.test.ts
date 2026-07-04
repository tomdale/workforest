import { describe, expect, it, vi } from "vitest";

type FakeBoxRecord = {
  top: number;
  left: number;
  width: number;
  height: number;
  hidden: boolean;
  content: string;
  style: { fg?: string; border?: { fg?: string } };
};

const created = vi.hoisted(() => ({
  boxes: [] as FakeBoxRecord[],
}));

// @unblessed/node requires a real TTY; replace it with recorders so layout
// math (bounds, reflow, zoom, visibility) is observable without a terminal.
vi.mock("@unblessed/node", () => {
  class FakeBox {
    top: number;
    left: number;
    width: number;
    height: number;
    hidden = false;
    content = "";
    style: { fg?: string; border?: { fg?: string } };

    constructor(options: {
      top?: number;
      left?: number;
      width?: number;
      height?: number;
      style?: { fg?: string; border?: { fg?: string } };
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

type MutableSize = { width: number; height: number };

function createGrid(options: { rows: number; cols: number }): {
  grid: GridLayout;
  parent: MutableSize;
  /** The frame box for pane `index` (frame and content box alternate). */
  frameOf: (index: number) => FakeBoxRecord;
} {
  created.boxes.length = 0;
  const parent = { width: 100, height: 40 };
  const screen = { render: vi.fn(), width: 100, height: 40 };
  const grid = new GridLayout({
    screen: screen as unknown as Screen,
    parent: parent as unknown as Screen,
    rows: options.rows,
    cols: options.cols,
    borderColor: "cyan",
    focusBorderColor: "white",
  });
  const frameOf = (index: number): FakeBoxRecord => {
    const frame = created.boxes[index * 2];
    if (!frame) throw new Error(`No frame recorded for pane ${index}.`);
    return frame;
  };
  return { grid, parent, frameOf };
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

describe("GridLayout reflow", () => {
  it("recomputes cell bounds from the parent's current size", () => {
    const { grid, parent, frameOf } = createGrid({ rows: 1, cols: 2 });
    expect(frameOf(0).width).toBe(50);
    expect(frameOf(1).left).toBe(50);
    expect(grid.getPane(0)?.getContentSize()).toEqual({
      width: 48,
      height: 38,
    });

    parent.width = 60;
    parent.height = 20;
    grid.reflow();

    expect(frameOf(0).width).toBe(30);
    expect(frameOf(0).height).toBe(20);
    expect(frameOf(1).left).toBe(30);
    expect(grid.getPane(0)?.getContentSize()).toEqual({
      width: 28,
      height: 18,
    });
  });
});

describe("GridLayout zoom and visibility", () => {
  it("zooms one pane to the full frame and hides the others", () => {
    const { grid, frameOf } = createGrid({ rows: 1, cols: 2 });

    grid.setZoomedPane(1);
    expect(frameOf(0).hidden).toBe(true);
    expect(frameOf(1).hidden).toBe(false);
    expect(frameOf(1).left).toBe(0);
    expect(frameOf(1).width).toBe(100);
    expect(grid.getPane(1)?.getContentSize()).toEqual({
      width: 98,
      height: 38,
    });

    grid.setZoomedPane(null);
    expect(frameOf(0).hidden).toBe(false);
    expect(frameOf(1).left).toBe(50);
    expect(frameOf(1).width).toBe(50);
  });

  it("hides and shows individual panes for paging", () => {
    const { grid, frameOf } = createGrid({ rows: 1, cols: 2 });

    grid.hidePane(1);
    expect(frameOf(1).hidden).toBe(true);
    expect(frameOf(0).hidden).toBe(false);

    grid.setVisiblePane(1);
    expect(frameOf(1).hidden).toBe(false);
  });

  it("keeps hidden panes hidden across a reflow", () => {
    const { grid, parent, frameOf } = createGrid({ rows: 1, cols: 2 });
    grid.hidePane(0);
    parent.width = 80;
    grid.reflow();
    expect(frameOf(0).hidden).toBe(true);
    expect(frameOf(1).hidden).toBe(false);
  });
});

describe("GridLayout focus", () => {
  it("switches the frame border between base and focus colors", () => {
    const { grid, frameOf } = createGrid({ rows: 1, cols: 2 });
    const pane = grid.getPane(0);

    pane?.setFocused(true);
    expect(frameOf(0).style.fg).toBe("white");
    expect(frameOf(0).style.border?.fg).toBe("white");

    pane?.setFocused(false);
    expect(frameOf(0).style.fg).toBe("cyan");
    expect(frameOf(0).style.border?.fg).toBe("cyan");
  });
});
