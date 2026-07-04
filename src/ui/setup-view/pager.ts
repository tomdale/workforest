/**
 * Pane paging for setup grids with more repositories than the grid can show
 * at once. Selection is pure: given the pane order, a priority classifier,
 * and the requested page, it returns the panes to show and the page count.
 */

import type { RepoRunStatus } from "../../workspace/run-log/reducer.ts";

/** The grid never shows more than a 3×3 of panes at once. */
export const PANE_CAPACITY = 9;

/**
 * Attention priority for pane selection when repos overflow the grid:
 * failures first, then active work, then queued repos, then finished ones.
 */
export type PanePriority = "failed" | "active" | "pending" | "done";

export function panePriorityForStatus(status: RepoRunStatus): PanePriority {
  switch (status) {
    case "failed":
      return "failed";
    case "running":
    case "handed-off":
      return "active";
    case "pending":
      return "pending";
    case "ready":
    case "cancelled":
      return "done";
  }
}

const PRIORITY_RANK: Record<PanePriority, number> = {
  failed: 0,
  active: 1,
  pending: 2,
  done: 3,
};

export type SelectVisiblePanesInput = Readonly<{
  /** All pane names in their stable presentation order. */
  order: readonly string[];
  /** Classifies one pane; used only when the panes overflow the capacity. */
  priorityOf: (name: string) => PanePriority;
  /** Requested page; clamped into range. */
  page: number;
  capacity?: number;
}>;

export type SelectVisiblePanesResult = Readonly<{
  visible: readonly string[];
  page: number;
  pageCount: number;
}>;

/**
 * Choose which panes are visible. When everything fits, the original order
 * is preserved untouched. When panes overflow the capacity, they are sorted
 * by attention priority (stable within each priority) and sliced into
 * explicit pages the user moves through with `[` and `]`.
 */
export function selectVisiblePanes(
  input: SelectVisiblePanesInput,
): SelectVisiblePanesResult {
  const capacity = Math.max(1, input.capacity ?? PANE_CAPACITY);
  const order = [...input.order];

  if (order.length <= capacity) {
    return { visible: order, page: 0, pageCount: 1 };
  }

  const ranked = order
    .map((name, index) => ({
      name,
      index,
      rank: PRIORITY_RANK[input.priorityOf(name)],
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.name);

  const pageCount = Math.max(1, Math.ceil(ranked.length / capacity));
  const page = Math.min(Math.max(input.page, 0), pageCount - 1);
  const visible = ranked.slice(page * capacity, (page + 1) * capacity);
  return { visible, page, pageCount };
}
