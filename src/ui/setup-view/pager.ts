/**
 * Pane capacity and paging for setup grids. Capacity is derived from the
 * terminal size (how many minimum-sized panes fit) instead of a fixed cap, and
 * runs with more repositories than fit page through explicit pages. Everything
 * here is pure: viewport in, layout out.
 */

import type { RepoRunStatus } from "../../workspace/run-log/reducer.ts";

/**
 * The narrowest pane that still shows a readable checklist row like
 * "✔ pnpm install (retry 2) 12.3s" inside its border.
 */
export const MIN_PANE_WIDTH = 30;

/** The shortest pane that fits a border, label, and a few checklist rows. */
export const MIN_PANE_HEIGHT = 8;

export type GridViewport = Readonly<{ width: number; height: number }>;

export type GridCapacity = Readonly<{
  capacity: number;
  maxRows: number;
  maxCols: number;
}>;

/**
 * How many minimum-sized panes the terminal holds at once. One row is
 * reserved for the status line; every axis keeps at least one pane so tiny
 * terminals degrade to a single pane rather than zero.
 */
export function computeGridCapacity(viewport: GridViewport): GridCapacity {
  const usableHeight = Math.max(viewport.height - 1, 1);
  const maxCols = Math.max(Math.floor(viewport.width / MIN_PANE_WIDTH), 1);
  const maxRows = Math.max(Math.floor(usableHeight / MIN_PANE_HEIGHT), 1);
  return { capacity: maxRows * maxCols, maxRows, maxCols };
}

/**
 * Choose a near-square grid shape for `count` panes within the viewport's
 * row/column bounds, preferring wider-than-tall layouts (terminal cells are
 * taller than they are wide, so extra columns cost less than extra rows).
 */
export function fitGridDimensions(
  count: number,
  bounds: Pick<GridCapacity, "maxRows" | "maxCols">,
): { rows: number; cols: number } {
  const panes = Math.max(count, 1);
  let cols = Math.min(Math.ceil(Math.sqrt(panes)), bounds.maxCols, panes);
  let rows = Math.ceil(panes / cols);
  if (rows > bounds.maxRows) {
    cols = Math.min(Math.ceil(panes / bounds.maxRows), bounds.maxCols);
    rows = Math.min(Math.ceil(panes / cols), bounds.maxRows);
  }
  return { rows, cols };
}

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
  /** How many panes fit at once; see {@link computeGridCapacity}. */
  capacity: number;
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
  const capacity = Math.max(1, input.capacity);
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
