import { describe, expect, it } from "vitest";
import {
  PANE_CAPACITY,
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

describe("selectVisiblePanes", () => {
  it("keeps the original order untouched when everything fits", () => {
    const order = ["c", "a", "b"];
    const result = selectVisiblePanes({
      order,
      priorityOf: () => "done",
      page: 0,
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
    });

    // Failures first, then active work, stable within each priority.
    expect(result.visible.slice(0, 2)).toEqual(["repo-5", "repo-11"]);
    expect(result.visible.slice(2, 4)).toEqual(["repo-4", "repo-7"]);
    expect(result.visible).toHaveLength(PANE_CAPACITY);
    expect(result.pageCount).toBe(2);
  });

  it("slices explicit pages and clamps out-of-range requests", () => {
    const order = Array.from({ length: 12 }, (_, i) => `repo-${i}`);
    const page2 = selectVisiblePanes({ order, priorityOf, page: 1 });
    expect(page2.visible).toEqual(["repo-9", "repo-10", "repo-11"]);
    expect(page2.page).toBe(1);

    const clamped = selectVisiblePanes({ order, priorityOf, page: 99 });
    expect(clamped.page).toBe(1);
    const negative = selectVisiblePanes({ order, priorityOf, page: -3 });
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
