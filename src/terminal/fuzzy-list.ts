import { Box, type Screen } from "@unblessed/node";
import { escapeBlessedTags } from "./command-stream-adapter.ts";
import { truncate, visibleWidth } from "./text.ts";
import { activeTheme, bg, fg, type Theme, toBlessed } from "./theme-system.ts";

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

/** One option of a {@link FuzzyScopeToggle}. */
export type FuzzyScopeOption = {
  /** Full display text, e.g. "in workforest" or "all changes". */
  label: string;
  /**
   * The substring of {@link label} to paint as the highlighted badge when this
   * option is active (e.g. "workforest" within "in workforest"). Defaults to the
   * whole label.
   */
  name?: string;
};

/**
 * A prominent two-way scope toggle rendered above the list. Both options hold
 * fixed positions; pressing Tab moves only the highlighted badge between them
 * (it never reorders the row). Drive the position from {@link FuzzyTabUpdate}'s
 * `scopeActive`.
 */
export type FuzzyScopeToggle = {
  /** The options in fixed left-to-right display order. */
  options: readonly FuzzyScopeOption[];
  /** Index into {@link options} of the currently selected scope. */
  active: number;
};

export type FuzzyFilter<T> = (
  items: FuzzyItem<T>[],
  query: string,
) => FuzzyItem<T>[];

/**
 * The new state to apply when the user presses Tab, returned by
 * {@link FuzzyListOptions.onTab}. Returning `null` leaves the list unchanged.
 * The callback runs in the caller's closure, so it can also update sibling UI
 * (e.g. a preview pane) before returning; the list re-renders the whole screen
 * afterward.
 */
export type FuzzyTabUpdate<T> = {
  /** The candidate set to show after the switch. */
  items: FuzzyItem<T>[];
  /** Short label for the now-active scope/mode, shown beside the prompt. */
  scopeLabel?: string;
  /** New active index for a {@link FuzzyListOptions.scopeToggle}. */
  scopeActive?: number;
  /** Footer hint describing what the next Tab does. */
  tabHint?: string;
  /** Clear the typed query on switch. Defaults to false (query is preserved). */
  resetQuery?: boolean;
};

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
  /** Empty-input hint. Defaults to "Type to filter…". */
  placeholder?: string;
  /** Short label for the active scope/mode, shown muted beside the prompt. */
  scopeLabel?: string;
  /**
   * Footer hint describing what Tab does (e.g. "all changes"). Tab is handled
   * only when {@link onTab} is also provided.
   */
  tabHint?: string;
  /**
   * Called when Tab is pressed. Return the new state to apply in place, or
   * `null` to ignore the keystroke. Enables the Tab footer hint.
   */
  onTab?: () => FuzzyTabUpdate<T> | null;
  /**
   * Selects the initially-highlighted candidate. The first item satisfying the
   * predicate starts highlighted; defaults to the first row.
   */
  initialSelected?: (item: FuzzyItem<T>) => boolean;
  /**
   * Render a prominent two-way scope toggle above the list — both options held
   * in fixed positions, the selected one painted as a highlighted badge, plus an
   * explicit Tab cue — instead of the muted inline {@link scopeLabel} suffix.
   * Requires {@link onTab} (which returns the new `scopeActive`). Use for binary
   * scope switches; leave off for callers that render their own switcher (e.g. a
   * multi-mode preview pane).
   */
  scopeToggle?: FuzzyScopeToggle;
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
  const { screen, prompt, actionRow } = options;
  const parent = options.parent ?? screen;
  const filter = options.filter ?? fuzzyFilter;
  const placeholder = options.placeholder ?? PLACEHOLDER;
  const hasAction = actionRow !== undefined;
  const onTab = options.onTab;

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

  let items = options.items;
  let scopeLabel = options.scopeLabel;
  let scopeToggle = options.scopeToggle;
  let tabHint = options.tabHint;
  let query = options.initialQuery ?? "";
  let candidates = filter(items, query);
  let index = initialIndex(candidates, options.initialSelected);
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

    // The header stacks top-down: prompt, an optional prominent scope toggle,
    // then the live query. `cursor` tracks the next free row so the list starts
    // directly beneath whatever the header occupied.
    const showScopeBar = scopeToggle !== undefined;
    const scopeSuffix =
      scopeLabel && !showScopeBar
        ? `  ${fg(palette.muted, `· ${escapeBlessedTags(scopeLabel)}`)}`
        : "";
    let cursor = 0;
    lines[cursor++] = `${fg(palette.focus, theme.symbols.active)} ${fg(
      palette.primary,
      escapeBlessedTags(prompt),
    )}${scopeSuffix}`;

    if (scopeToggle !== undefined) {
      lines[cursor++] = renderScopeBar(theme, scopeToggle);
    }

    const caret = fg(palette.focus, CARET);
    if (query.length > 0) {
      lines[cursor] =
        `${fg(palette.primary, escapeBlessedTags(query))}${caret}`;
    } else {
      lines[cursor] = `${caret} ${fg(palette.muted, placeholder)}`;
    }
    cursor += 1;

    const footerRow = Math.max(cursor, height - 1);
    const listTop = cursor;
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

    lines[footerRow] = renderFooter(
      theme,
      onTab && !showScopeBar ? tabHint : undefined,
    );
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

  const switchScope = (): void => {
    if (!onTab) return;
    const update = onTab();
    if (!update) return;
    items = update.items;
    if (update.resetQuery) query = "";
    if (update.scopeLabel !== undefined) scopeLabel = update.scopeLabel;
    if (update.scopeActive !== undefined && scopeToggle !== undefined) {
      scopeToggle = { ...scopeToggle, active: update.scopeActive };
    }
    if (update.tabHint !== undefined) tabHint = update.tabHint;
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
      case "tab":
        switchScope();
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

  // The screen swallows Tab for focus traversal, so it never reaches the
  // screen-level "keypress" listener; the program-level stream still carries it.
  // We bind there (forward Tab only) so scope switching works in a real
  // terminal, while the screen "keypress" handler above keeps Tab working under
  // test harnesses that deliver it directly.
  const program = onTab ? screenProgram(screen) : undefined;
  const onProgramKeypress = (
    _ch: string | undefined,
    key: { name?: string; shift?: boolean },
  ): void => {
    if (key?.name === "tab" && !key.shift) switchScope();
  };

  const cleanup = (): void => {
    if (destroyed) return;
    destroyed = true;
    screen.removeListener("keypress", onKeypress);
    program?.removeListener?.("keypress", onProgramKeypress);
    container.detach();
    container.destroy();
  };

  return {
    run(): Promise<FuzzyResult<T>> {
      return new Promise<FuzzyResult<T>>((resolve) => {
        resolveRun = resolve;
        screen.on("keypress", onKeypress);
        program?.on?.("keypress", onProgramKeypress);
        render();
      });
    },
    destroy(): void {
      if (resolveRun) finish({ kind: "cancel" });
      else cleanup();
    },
  };
}

/** Minimal view of the @unblessed program's key event stream. */
type ScreenProgram = {
  on?(event: "keypress", listener: ProgramKeyListener): void;
  removeListener?(event: "keypress", listener: ProgramKeyListener): void;
};
type ProgramKeyListener = (
  ch: string | undefined,
  key: { name?: string; shift?: boolean },
) => void;

function screenProgram(screen: Screen): ScreenProgram | undefined {
  return (screen as unknown as { program?: ScreenProgram }).program;
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

/**
 * A prominent two-way scope toggle. Both options keep fixed positions; only the
 * highlight moves between them, so Tab never reorders the row. The selected
 * option's name is painted as a badge — a contrasting foreground on a
 * {@link ThemePalette.focus} background — with its connector (e.g. the "in " of
 * "in workforest") muted; unselected options render plain muted. An explicit,
 * accented Tab cue trails the options.
 */
function renderScopeBar(theme: Theme, toggle: FuzzyScopeToggle): string {
  const { palette } = theme;
  const segments = toggle.options.map((option, i) =>
    renderScopeOption(theme, option, i === toggle.active),
  );
  const cue = `${fg(palette.muted, "·")} {bold}${fg(
    palette.focus,
    "tab",
  )}{/bold} ${fg(palette.muted, "switches scope")}`;
  return `  ${segments.join("   ")}   ${cue}`;
}

/**
 * One scope option. Its name carries a space of padding on each side that is
 * always present — selecting paints that padded name as a focus-background badge
 * (with a contrasting foreground), deselecting renders the same padded name
 * muted. Because both states occupy identical cells, the row never shifts as the
 * highlight moves; only color changes. The connector around the name (e.g. the
 * "in" of "in workforest") stays muted in both.
 */
function renderScopeOption(
  theme: Theme,
  option: FuzzyScopeOption,
  active: boolean,
): string {
  const { palette, chrome } = theme;
  const { label } = option;
  const name = option.name ?? label;
  const at = name === label ? -1 : label.lastIndexOf(name);
  const before = at >= 0 ? label.slice(0, at).replace(/\s+$/, "") : "";
  const after =
    at >= 0 ? label.slice(at + name.length).replace(/^\s+/, "") : "";
  const padded = ` ${escapeBlessedTags(at >= 0 ? name : label)} `;

  const nameCell = active
    ? bg(palette.focus, fg(chrome.background, padded))
    : fg(palette.muted, padded);
  // A plain (un-highlighted) space separates the connector from the badge, so
  // the name reads as detached from "in" rather than fused to the highlight.
  return [
    before ? `${fg(palette.muted, escapeBlessedTags(before))} ` : "",
    nameCell,
    after ? ` ${fg(palette.muted, escapeBlessedTags(after))}` : "",
  ].join("");
}

function renderFooter(theme: Theme, tabHint?: string): string {
  const { palette } = theme;
  const separator = fg(palette.muted, "  ·  ");
  const hints: ReadonlyArray<readonly [string, string]> = tabHint
    ? [...FOOTER_HINTS, ["tab", tabHint]]
    : FOOTER_HINTS;
  return hints
    .map(
      ([key, action]) =>
        `{bold}${fg(palette.muted, key)}{/bold} ${fg(palette.muted, action)}`,
    )
    .join(separator);
}

/**
 * The starting highlight: the first candidate matching `selected`, or row 0
 * when there is no predicate or no match.
 */
function initialIndex<T>(
  candidates: FuzzyItem<T>[],
  selected?: (item: FuzzyItem<T>) => boolean,
): number {
  if (!selected) return 0;
  const found = candidates.findIndex((item) => selected(item));
  return found === -1 ? 0 : found;
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
