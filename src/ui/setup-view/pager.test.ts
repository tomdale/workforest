import { describe, expect, it } from "vitest";
import {
  computeGridCapacity,
  fitGridDimensions,
  type PanePriority,
  panePriorityForStatus,
  selectVisiblePanes,
} from "./pager.ts";

const priorities: Record<string, PanePriority> = {};
const priorityOf = (name: string): PanePriority =>
  priorities[name] ?? "pending";

describe("panePriorityForStatus", () => {
  it.each([
    ["failed", "failed"],
    ["running", "active"],
    ["handed-off", "active"],
    ["pending", "pending"],
    ["ready", "done"],
    ["cancelled", "done"],
  ] as const)("maps %s to %s", (status, priority) => {
    expect(panePriorityForStatus(status)).toBe(priority);
  });
});

describe("computeGridCapacity", () => {
  it("derives capacity from how many minimum panes fit", () => {
    // 100 cols hold 3 thirty-cell columns; 26 rows minus the status line
    // hold 3 eight-cell rows.
    expect(computeGridCapacity({ width: 100, height: 26 })).toEqual({
      capacity: 9,
      maxRows: 3,
      maxCols: 3,
    });
  });

  it("grows with the terminal", () => {
    expect(computeGridCapacity({ width: 200, height: 41 })).toEqual({
      capacity: 30,
      maxRows: 5,
      maxCols: 6,
    });
  });

  it("never drops below one pane", () => {
    expect(computeGridCapacity({ width: 20, height: 5 })).toEqual({
      capacity: 1,
      maxRows: 1,
      maxCols: 1,
    });
  });
});

describe("fitGridDimensions", () => {
  const bounds = { maxRows: 3, maxCols: 3 };

  it.each([
    [1, { rows: 1, cols: 1 }],
    [2, { rows: 1, cols: 2 }],
    [3, { rows: 2, cols: 2 }],
    [4, { rows: 2, cols: 2 }],
    [5, { rows: 2, cols: 3 }],
    [6, { rows: 2, cols: 3 }],
    [7, { rows: 3, cols: 3 }],
    [9, { rows: 3, cols: 3 }],
  ] as const)("fits %d panes near-square", (count, dims) => {
    expect(fitGridDimensions(count, bounds)).toEqual(dims);
  });

  it("widens instead of exceeding the row bound", () => {
    // 12 panes would want 4 rows of 3; with only 3 rows available the grid
    // widens to 4 columns instead.
    expect(fitGridDimensions(12, { maxRows: 3, maxCols: 6 })).toEqual({
      rows: 3,
      cols: 4,
    });
  });
});

describe("selectVisiblePanes", () => {
  it("keeps the original order untouched when everything fits", () => {
    const order = ["c", "a", "b"];
    const result = selectVisiblePanes({
      order,
      priorityOf: () => "done",
      page: 0,
      capacity: 9,
    });
    expect(result.visible).toEqual(["c", "a", "b"]);
    expect(result.pageCount).toBe(1);
    expect(result.page).toBe(0);
  });

  it("prioritizes failed, then active, then pending, then done panes", () => {
    const order = Array.from({ length: 12 }, (_, i) => `repo-${i}`);
    const priorityByName: Record<string, PanePriority> = {
      "repo-0": "done",
      "repo-1": "done",
      "repo-2": "done",
      "repo-3": "done",
      "repo-4": "active",
      "repo-5": "failed",
      "repo-6": "pending",
      "repo-7": "active",
      "repo-8": "done",
      "repo-9": "done",
      "repo-10": "done",
      "repo-11": "failed",
    };
    const result = selectVisiblePanes({
      order,
      priorityOf: (name) => priorityByName[name] ?? "pending",
      page: 0,
      capacity: 9,
    });

    // Failures first, then active work, stable within each priority.
    expect(result.visible.slice(0, 2)).toEqual(["repo-5", "repo-11"]);
    expect(result.visible.slice(2, 4)).toEqual(["repo-4", "repo-7"]);
    expect(result.visible).toHaveLength(9);
    expect(result.pageCount).toBe(2);
  });

  it("slices explicit pages and clamps out-of-range requests", () => {
    const order = Array.from({ length: 12 }, (_, i) => `repo-${i}`);
    const page2 = selectVisiblePanes({
      order,
      priorityOf,
      page: 1,
      capacity: 9,
    });
    expect(page2.visible).toEqual(["repo-9", "repo-10", "repo-11"]);
    expect(page2.page).toBe(1);

    const clamped = selectVisiblePanes({
      order,
      priorityOf,
      page: 99,
      capacity: 9,
    });
    expect(clamped.page).toBe(1);
    const negative = selectVisiblePanes({
      order,
      priorityOf,
      page: -3,
      capacity: 9,
    });
    expect(negative.page).toBe(0);
  });

  it("honors a custom capacity", () => {
    const order = ["a", "b", "c", "d"];
    const result = selectVisiblePanes({
      order,
      priorityOf,
      page: 1,
      capacity: 2,
    });
    expect(result.visible).toEqual(["c", "d"]);
    expect(result.pageCount).toBe(2);
  });
});
