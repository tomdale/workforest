import { Box, type Screen } from "@unblessed/node";
import { escapeBlessedTags } from "./command-stream-adapter.ts";
import { truncate, visibleWidth } from "./text.ts";
import { activeTheme, fg, type Theme, toBlessed } from "./theme-system.ts";

/**
 * A reusable fullscreen fuzzy picker that renders inside a caller-provided
 * @unblessed Screen (or a Box within one). It mirrors the inline
 * `fuzzySelect` prompt's UX — a live-filtered list driven by a typed query —
 * but runs as a native widget that can coexist with other fullscreen surfaces.
 *
 * Each `run()` resolves a single selection; multi-select by accumulation is the
 * caller's job (loop, collecting one result per call). Free entry is built in:
 * a persistent action row that renders as the final list entry resolves to the
 * typed query, so the caller can offer "create what I typed" without it ever
 * matching an item.
 */

export type FuzzyItem<T> = {
  value: T;
  label: string;
  /** Secondary text rendered muted after the label (e.g. a path or branch). */
  hint?: string;
};

/**
 * A persistent, always-selectable row rendered as the final entry of the list.
 * Its label is a function of the live query, so it can read like
 * `✛ New change named "feature-x"`. Selecting it resolves to `{ kind: "action" }`.
 */
export type FuzzyActionRow = {
  label: (query: string) => string;
};

export type FuzzyResult<T> =
  | { kind: "item"; value: T }
  | { kind: "action"; query: string }
  | { kind: "cancel" };

export type FuzzyFilter<T> = (
  items: FuzzyItem<T>[],
  query: string,
) => FuzzyItem<T>[];

export type FuzzyListOptions<T> = {
  /** The @unblessed screen this widget binds its key handling to. */
  screen: Screen;
  /** Optional container; defaults to the screen itself. */
  parent?: Box;
  /** A short label describing the choice, e.g. "go to a change". */
  prompt: string;
  items: FuzzyItem<T>[];
  /** Persistent literal row enabling free entry of the typed query. */
  actionRow?: FuzzyActionRow;
  /** Defaults to {@link fuzzyFilter} (case-insensitive subsequence, stable). */
  filter?: FuzzyFilter<T>;
  initialQuery?: string;
};

export type FuzzyList<T> = {
  run(): Promise<FuzzyResult<T>>;
  destroy(): void;
};

const CARET = "▌";
const PLACEHOLDER = "Type to filter…";
const NO_MATCHES = "No matches";
const FOOTER_HINTS: ReadonlyArray<readonly [string, string]> = [
  ["↑/↓", "move"],
  ["enter", "select"],
  ["esc", "cancel"],
  ["bksp", "delete"],
];

/**
 * Default filter: a stable, case-insensitive subsequence match over each item's
 * label and hint. An empty query matches everything; ordering is preserved.
 */
export function fuzzyFilter<T>(
  items: FuzzyItem<T>[],
  query: string,
): FuzzyItem<T>[] {
  const pattern = Array.from(query.trim().toLocaleLowerCase());
  if (pattern.length === 0) return items.slice();

  return items.filter((item) => {
    const haystack = `${item.label} ${item.hint ?? ""}`.toLocaleLowerCase();
    let offset = 0;
    for (const char of pattern) {
      const next = haystack.indexOf(char, offset);
      if (next === -1) return false;
      offset = next + 1;
    }
    return true;
  });
}

/**
 * The first visible candidate index that keeps `index` within a `viewport`-tall
 * window, scrolling only as far as needed from the `current` offset.
 */
export function windowStart(
  total: number,
  index: number,
  viewport: number,
  current: number,
): number {
  if (viewport <= 0 || total <= viewport) return 0;
  let start = current;
  if (index < start) start = index;
  else if (index >= start + viewport) start = index - viewport + 1;
  return clamp(start, 0, Math.max(0, total - viewport));
}

export function createFuzzyList<T>(options: FuzzyListOptions<T>): FuzzyList<T> {
  const { screen, prompt, items, actionRow } = options;
  const parent = options.parent ?? screen;
  const filter = options.filter ?? fuzzyFilter;
  const hasAction = actionRow !== undefined;

  const theme = activeTheme();
  const container = new Box({
    parent,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    tags: true,
    padding: { left: 1, right: 1 },
    style: {
      bg: toBlessed(theme.chrome.background),
      fg: toBlessed(theme.palette.primary),
    },
  });

  let query = options.initialQuery ?? "";
  let candidates = filter(items, query);
  let index = 0;
  let scrollTop = 0;
  let destroyed = false;
  let resolveRun: ((result: FuzzyResult<T>) => void) | null = null;

  const actionIndex = (): number => candidates.length;
  const total = (): number => candidates.length + (hasAction ? 1 : 0);
  const onActionRow = (): boolean => hasAction && index === actionIndex();

  const render = (): void => {
    const height = readDimension(container.height, 24);
    const width = readDimension(container.width, 80);
    const inner = Math.max(10, width - 2);
    const lines = new Array<string>(Math.max(height, 1)).fill("");
    const palette = theme.palette;

    lines[0] = `${fg(palette.focus, theme.symbols.active)} ${fg(
      palette.primary,
      escapeBlessedTags(prompt),
    )}`;

    const caret = fg(palette.focus, CARET);
    if (query.length > 0) {
      lines[1] = `${fg(palette.primary, escapeBlessedTags(query))}${caret}`;
    } else {
      lines[1] = `${caret} ${fg(palette.muted, PLACEHOLDER)}`;
    }

    const footerRow = Math.max(2, height - 1);
    const listTop = 2;
    const viewport = Math.max(0, footerRow - listTop);

    if (candidates.length === 0) {
      // Empty state: the "No matches" hint occupies the first list row, and the
      // action row (always the sole selectable entry here) sits inline below it.
      if (listTop < footerRow) {
        lines[listTop] = `  ${fg(palette.muted, NO_MATCHES)}`;
      }
      if (hasAction && actionRow && listTop + 1 < footerRow) {
        lines[listTop + 1] = renderAction(
          actionRow.label(query),
          onActionRow(),
          inner,
          theme,
        );
      }
    } else {
      // Candidates and the action row form one scrollable list. The action row
      // is the final entry (index === candidates.length) and scrolls with the
      // rest, so it sits directly beneath the last match when everything fits.
      scrollTop = windowStart(total(), index, viewport, scrollTop);
      const end = Math.min(scrollTop + viewport, total());
      for (let i = scrollTop; i < end; i += 1) {
        const row = listTop + (i - scrollTop);
        if (i < candidates.length) {
          const item = candidates[i];
          if (!item) continue;
          lines[row] = renderItem(item, i === index, inner, theme);
        } else if (actionRow) {
          lines[row] = renderAction(
            actionRow.label(query),
            i === index,
            inner,
            theme,
          );
        }
      }
    }

    lines[footerRow] = renderFooter(theme);
    container.setContent(lines.join("\n"));
    screen.render();
  };

  const move = (delta: number): void => {
    const count = total();
    if (count === 0) return;
    index = wrapIndex(index + delta, count);
    render();
  };

  const finish = (result: FuzzyResult<T>): void => {
    const resolve = resolveRun;
    if (!resolve) return;
    resolveRun = null;
    cleanup();
    resolve(result);
  };

  const submit = (): void => {
    if (onActionRow()) {
      finish({ kind: "action", query });
      return;
    }
    const selected = candidates[index];
    if (selected) finish({ kind: "item", value: selected.value });
  };

  const editQuery = (next: string): void => {
    query = next;
    candidates = filter(items, query);
    index = 0;
    scrollTop = 0;
    render();
  };

  const onKeypress = (
    ch: string | undefined,
    key: { name?: string; ctrl?: boolean; meta?: boolean },
  ): void => {
    if (key.ctrl && key.name === "c") {
      finish({ kind: "cancel" });
      return;
    }
    switch (key.name) {
      case "escape":
        finish({ kind: "cancel" });
        return;
      case "enter":
      case "return":
        submit();
        return;
      case "backspace":
        if (query.length > 0)
          editQuery(Array.from(query).slice(0, -1).join(""));
        return;
      case "up":
        move(-1);
        return;
      case "down":
        move(1);
        return;
    }
    // Ctrl-p / Ctrl-n offer arrow-free navigation without stealing printable
    // characters (j/k must stay typeable into the query).
    if (key.ctrl && key.name === "p") {
      move(-1);
      return;
    }
    if (key.ctrl && key.name === "n") {
      move(1);
      return;
    }
    if (
      ch !== undefined &&
      ch.length === 1 &&
      ch >= " " &&
      !key.ctrl &&
      !key.meta
    ) {
      editQuery(query + ch);
    }
  };

  const cleanup = (): void => {
    if (destroyed) return;
    destroyed = true;
    screen.removeListener("keypress", onKeypress);
    container.detach();
    container.destroy();
  };

  return {
    run(): Promise<FuzzyResult<T>> {
      return new Promise<FuzzyResult<T>>((resolve) => {
        resolveRun = resolve;
        screen.on("keypress", onKeypress);
        render();
      });
    },
    destroy(): void {
      if (resolveRun) finish({ kind: "cancel" });
      else cleanup();
    },
  };
}

function renderItem<T>(
  item: FuzzyItem<T>,
  selected: boolean,
  inner: number,
  theme: Theme,
): string {
  const { palette } = theme;
  const bullet = selected
    ? fg(palette.focus, theme.symbols.radioOn)
    : fg(palette.muted, theme.symbols.radioOff);
  const budget = Math.max(1, inner - 4);
  const labelText = truncate(escapeBlessedTags(item.label), budget);
  let body = fg(selected ? palette.focus : palette.primary, labelText);

  if (item.hint) {
    const remaining = budget - visibleWidth(labelText) - 2;
    if (remaining > 1) {
      const hint = truncate(escapeBlessedTags(item.hint), remaining);
      body += `  ${fg(palette.muted, hint)}`;
    }
  }

  return ` ${bullet} ${body}`;
}

function renderAction(
  label: string,
  selected: boolean,
  inner: number,
  theme: Theme,
): string {
  const { palette } = theme;
  const pointer = selected ? fg(palette.focus, "›") : " ";
  const budget = Math.max(1, inner - 3);
  const text = truncate(escapeBlessedTags(label), budget);
  return ` ${pointer} ${fg(selected ? palette.focus : palette.muted, text)}`;
}

function renderFooter(theme: Theme): string {
  const { palette } = theme;
  const separator = fg(palette.muted, "  ·  ");
  return FOOTER_HINTS.map(
    ([key, action]) =>
      `{bold}${fg(palette.muted, key)}{/bold} ${fg(palette.muted, action)}`,
  ).join(separator);
}

function readDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
