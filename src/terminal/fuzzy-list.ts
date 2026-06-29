import { Box, type Screen } from "@unblessed/node";
import {
  renderTerminalLineBlessed,
  type TerminalLineInput,
  type TerminalSpan,
  terminalLine,
  terminalSpan,
} from "./render-model.ts";
import { truncate, visibleWidth } from "./text.ts";
import { activeTheme, type Theme, toBlessed } from "./theme-system.ts";

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
  | { kind: "items"; values: T[] }
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

export type FuzzyTabDirection = "forward" | "backward";

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
  /** Update checkbox multi-select behavior for the new scope/mode. */
  multiSelect?: FuzzyMultiSelectOptions<T>;
};

export type FuzzyMultiSelectOptions<T> = {
  selected?: readonly T[];
  minSelected?: number;
  isEqual?: (left: T, right: T) => boolean;
  onSelectionChange?: (selected: readonly T[]) => void;
};

export type FuzzyListOptions<T> = {
  /** The @unblessed screen this widget binds its key handling to. */
  screen: Screen;
  /** Optional container; defaults to the screen itself. */
  parent?: Box;
  /** Optional heading rendered above the input box. */
  prompt?: string;
  items: FuzzyItem<T>[];
  /** Persistent literal row enabling free entry of the typed query. */
  actionRow?: FuzzyActionRow;
  /** Defaults to {@link fuzzyFilter} (case-insensitive subsequence, stable). */
  filter?: FuzzyFilter<T>;
  initialQuery?: string;
  /** Empty-input hint. Defaults to "type to filter". */
  placeholder?: string;
  /** Short label for the active scope/mode, shown muted beside the prompt. */
  scopeLabel?: string;
  /**
   * Footer hint describing what Tab does (e.g. "all changes"). Tab is handled
   * only when {@link onTab} is also provided.
   */
  tabHint?: string;
  /**
   * Called when Tab or Shift-Tab is pressed. Return the new state to apply in
   * place, or `null` to ignore the keystroke. Enables the Tab footer hint.
   */
  onTab?: (direction: FuzzyTabDirection) => FuzzyTabUpdate<T> | null;
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
  /**
   * Opt into checkbox-style multi-select. Space toggles the highlighted item;
   * Enter submits the selected values only when `minSelected` is satisfied.
   */
  multiSelect?: FuzzyMultiSelectOptions<T>;
};

export type FuzzyList<T> = {
  run(): Promise<FuzzyResult<T>>;
  destroy(): void;
};

const PLACEHOLDER = "type to filter";
// Upper bound on the name column so one long change name can't push the
// timestamp/metadata columns off-screen.
const NAME_COLUMN_CAP = 32;
const NO_MATCHES = "No matches";
const FOOTER_HINTS: ReadonlyArray<readonly [string, string]> = [
  ["↑↓", "MOVE"],
  ["⏎", "SELECT"],
  ["esc", "CANCEL"],
  ["⌫", "DELETE"],
];
const MULTI_FOOTER_HINTS: ReadonlyArray<readonly [string, string]> = [
  ["↑↓", "MOVE"],
  ["Space", "TOGGLE"],
  ["⏎", "CREATE"],
  ["Tab", "MODE"],
  ["esc", "CANCEL"],
  ["⌫", "DELETE"],
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
  let multiSelect = options.multiSelect;
  let isMulti = multiSelect !== undefined;
  let minSelected = multiSelect?.minSelected ?? 1;
  let isEqual =
    multiSelect?.isEqual ?? ((left: T, right: T) => Object.is(left, right));

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
  let selectedValues = multiSelect?.selected ? [...multiSelect.selected] : [];

  const setMultiSelect = (
    next: FuzzyMultiSelectOptions<T> | undefined,
  ): void => {
    multiSelect = next;
    isMulti = multiSelect !== undefined;
    minSelected = multiSelect?.minSelected ?? 1;
    isEqual =
      multiSelect?.isEqual ?? ((left: T, right: T) => Object.is(left, right));
    selectedValues = multiSelect?.selected ? [...multiSelect.selected] : [];
  };

  // The action row is an affordance for "use what I typed", so it stays hidden
  // until the query has a non-whitespace character — an empty picker shows only
  // its input, never a row to select.
  const showAction = (): boolean => hasAction && query.trim().length > 0;
  const actionIndex = (): number => candidates.length;
  const total = (): number => candidates.length + (showAction() ? 1 : 0);
  const onActionRow = (): boolean => showAction() && index === actionIndex();

  const render = (): void => {
    const height = readDimension(container.height, 24);
    const width = readDimension(container.width, 80);
    const inner = Math.max(10, width - 2);
    const lines = new Array<string>(Math.max(height, 1)).fill("");

    // An optional heading sits above the boxed query input; the scope controls
    // sit between the input and the matching list.
    const showScopeBar = scopeToggle !== undefined;
    const scopeSuffix =
      scopeLabel && !showScopeBar
        ? ["  ", terminalSpan(`· ${scopeLabel}`, { role: "muted" })]
        : "";
    let cursor = 0;
    if (prompt) {
      lines[cursor++] = blessedLine([
        terminalSpan(theme.symbols.active, { role: "focus" }),
        " ",
        terminalSpan(prompt, { role: "primary" }),
        ...(Array.isArray(scopeSuffix) ? scopeSuffix : []),
      ]);
    }

    const box = renderInputBox(inner, query, placeholder);
    lines[cursor] = box.top;
    lines[cursor + 1] = box.mid;
    lines[cursor + 2] = box.bottom;
    cursor += 3;

    if (scopeToggle !== undefined) {
      lines[cursor++] = renderScopeBar(theme, scopeToggle);
    }

    const listTop = cursor;
    const footerRow = Math.max(listTop, height - 1);
    const viewport = Math.max(0, footerRow - listTop);

    if (candidates.length === 0) {
      // Empty state. "No matches" only makes sense when there were items to
      // filter against; a create-only list (no items at all, e.g. `wf new`)
      // is just a name prompt, so it shows the action row alone with no
      // misleading hint. The action row (the sole selectable entry here) takes
      // the first list row when the hint is suppressed, else sits below it.
      let row = listTop;
      if (items.length > 0 && row < footerRow) {
        lines[row++] = blessedLine([
          "  ",
          terminalSpan(NO_MATCHES, { role: "muted" }),
        ]);
      }
      if (showAction() && actionRow && row < footerRow) {
        lines[row] = renderAction(actionRow.label(query), onActionRow(), inner);
      }
    } else {
      // Candidates and the action row form one scrollable list. The action row
      // is the final entry (index === candidates.length) and scrolls with the
      // rest, so it sits directly beneath the last match when everything fits.
      // Column widths are measured across every candidate (not just the
      // visible window) so the timestamp/metadata columns stay put while
      // scrolling.
      const columns = computeColumns(candidates);
      scrollTop = windowStart(total(), index, viewport, scrollTop);
      const end = Math.min(scrollTop + viewport, total());
      for (let i = scrollTop; i < end; i += 1) {
        const row = listTop + (i - scrollTop);
        if (i < candidates.length) {
          const item = candidates[i];
          if (!item) continue;
          lines[row] = renderItem(
            item,
            i === index,
            inner,
            theme,
            columns,
            isMulti ? isSelectedValue(item.value) : undefined,
          );
        } else if (actionRow) {
          lines[row] = renderAction(actionRow.label(query), i === index, inner);
        }
      }
    }

    lines[footerRow] = renderFooter(theme, {
      tabHint: onTab && !showScopeBar ? tabHint : undefined,
      multi: isMulti,
    });
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

  const isSelectedValue = (value: T): boolean =>
    selectedValues.some((selected) => isEqual(selected, value));

  const toggleSelected = (): void => {
    if (!isMulti || onActionRow()) return;
    const selected = candidates[index];
    if (!selected) return;
    const existing = selectedValues.findIndex((value) =>
      isEqual(value, selected.value),
    );
    selectedValues =
      existing === -1
        ? [...selectedValues, selected.value]
        : selectedValues.filter((_, i) => i !== existing);
    multiSelect?.onSelectionChange?.(selectedValues);
    render();
  };

  const submit = (): void => {
    if (isMulti && !onActionRow()) {
      if (selectedValues.length >= minSelected) {
        finish({ kind: "items", values: selectedValues });
      } else {
        render();
      }
      return;
    }
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

  const switchScope = (direction: FuzzyTabDirection): void => {
    if (!onTab) return;
    const update = onTab(direction);
    if (!update) return;
    items = update.items;
    if (update.resetQuery) query = "";
    if (update.scopeLabel !== undefined) scopeLabel = update.scopeLabel;
    if (update.scopeActive !== undefined && scopeToggle !== undefined) {
      scopeToggle = { ...scopeToggle, active: update.scopeActive };
    }
    if (update.tabHint !== undefined) tabHint = update.tabHint;
    setMultiSelect(update.multiSelect);
    candidates = filter(items, query);
    index = 0;
    scrollTop = 0;
    render();
  };

  const onKeypress = (
    ch: string | undefined,
    key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean },
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
        switchScope(key.shift ? "backward" : "forward");
        return;
      case "backtab":
        switchScope("backward");
        return;
      case "enter":
      case "return":
        submit();
        return;
      case "space":
        toggleSelected();
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
      if (ch === " " && isMulti) {
        toggleSelected();
        return;
      }
      editQuery(query + ch);
    }
  };

  // The screen swallows Tab for focus traversal, so it never reaches the
  // screen-level "keypress" listener; the program-level stream still carries it.
  // We bind there so scope switching works in a real terminal, while the screen
  // "keypress" handler above keeps Tab working under test harnesses that
  // deliver it directly.
  const program = onTab ? screenProgram(screen) : undefined;
  const onProgramKeypress = (
    _ch: string | undefined,
    key: { name?: string; shift?: boolean },
  ): void => {
    if (key?.name === "tab") {
      switchScope(key.shift ? "backward" : "forward");
      return;
    }
    if (key?.name === "backtab") switchScope("backward");
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

const RULE = "━";
// Rule glyphs to the left of the content; the label then aligns with the
// unselected three-column indent.
const RULE_LEAD = 2;

/**
 * The query input, wrapped in a rounded box. The placeholder doubles as the
 * surface label (the caller renders no header), and a static caret marks the
 * input position. The box is drawn one column short of the full width — blessed
 * wraps a line whose width equals the content area, which would push the right
 * border (and the corners) onto their own rows.
 */
function renderInputBox(
  inner: number,
  query: string,
  placeholder: string,
): { top: string; mid: string; bottom: string } {
  const span = Math.max(4, inner - 1);
  const horizontal = "─".repeat(Math.max(0, span - 2));
  // Content sits between "│ " and " │", so one space of padding each side.
  const slot = Math.max(1, span - 4);

  const shown = truncate(query.length > 0 ? query : placeholder, slot);
  const inside = terminalSpan(shown, {
    role: query.length > 0 ? "primary" : "muted",
  });
  const pad = " ".repeat(Math.max(0, slot - visibleWidth(shown)));
  return {
    top: blessedLine(terminalSpan(`╭${horizontal}╮`, { role: "accent" })),
    mid: blessedLine([
      terminalSpan("│", { role: "accent" }),
      " ",
      inside,
      pad,
      " ",
      terminalSpan("│", { role: "accent" }),
    ]),
    bottom: blessedLine(terminalSpan(`╰${horizontal}╯`, { role: "accent" })),
  };
}

/**
 * Lay the focused row over a red rule that runs edge to edge: a short lead at
 * the left margin, the styled content, then rule glyphs filling out to `inner`.
 * The content knocks the middle out of the line, so it reads as a red wire
 * passing behind the selection. `plainWidth` is the visible width of `content`.
 */
function ruledSelection(
  content: string,
  plainWidth: number,
  inner: number,
): string {
  const lead = blessedLine(
    terminalSpan(RULE.repeat(RULE_LEAD), { role: "primary" }),
  );
  // [lead][space][content][space][fill] — one space of breathing room on each
  // side of the text. The total stops one column short of `inner`: a line whose
  // width equals the content area wraps in blessed, dropping the last glyph.
  const fill = Math.max(0, inner - RULE_LEAD - plainWidth - 3);
  return `${lead} ${content} ${blessedLine(
    terminalSpan(RULE.repeat(fill), { role: "primary" }),
  )}`;
}

type Columns = { name: number; time: number };

/**
 * Split a hint into its leading timestamp and the trailing metadata, on the
 * same " · " join {@link buildStatusHint} uses. A hint with no separator is
 * treated as all timestamp (the metadata column is then empty).
 */
function splitHint(hint: string | undefined): { time: string; meta: string } {
  if (!hint) return { time: "", meta: "" };
  const [time, ...rest] = hint.split(" · ");
  return { time: time ?? "", meta: rest.join(" · ") };
}

/**
 * Measure the name and timestamp column widths across every candidate so the
 * three columns (name · timestamp · metadata) line up. The name column is
 * capped so a single long change name can't push the metadata off-screen.
 */
function computeColumns<T>(candidates: FuzzyItem<T>[]): Columns {
  let name = 0;
  let time = 0;
  for (const candidate of candidates) {
    name = Math.max(name, visibleWidth(candidate.label));
    const { time: stamp } = splitHint(candidate.hint);
    time = Math.max(time, visibleWidth(stamp));
  }
  return { name: Math.min(name, NAME_COLUMN_CAP), time };
}

/** Escape, truncate to `width`, then right-pad with spaces to exactly `width`. */
function padColumn(text: string, width: number): string {
  const shown = truncate(text, width);
  return shown + " ".repeat(Math.max(0, width - visibleWidth(shown)));
}

/**
 * Fit a metadata string to `budget` columns. A comma-separated repo list —
 * optionally wrapped as a template `@name (a, b, c)` — keeps as many whole
 * entries as fit and summarizes the rest as ", + N more"; only truncating when
 * the full list would overflow. A trailing " · "-joined flag (e.g. `stale`) is
 * preserved, and non-list text that overflows is hard-truncated.
 */
export function fitMetaList(meta: string, budget: number): string {
  if (budget <= 0) return "";
  if (visibleWidth(meta) <= budget) return meta;

  const [repoInfo = "", ...flags] = meta.split(" · ");
  const flagSuffix = flags.length > 0 ? ` · ${flags.join(" · ")}` : "";

  const wrapped = /^(.+) \((.+)\)$/.exec(repoInfo);
  const [, wrappedLead = "", wrappedItems = ""] = wrapped ?? [];
  const lead = wrapped ? `${wrappedLead} (` : "";
  const close = wrapped ? ")" : "";
  const items = (wrapped ? wrappedItems : repoInfo).split(", ").filter(Boolean);

  // Most entries first: the first count that fits wins.
  for (let keep = items.length - 1; keep >= 1; keep -= 1) {
    const shown = items.slice(0, keep).join(", ");
    const candidate = `${lead}${shown}, + ${items.length - keep} more${close}${flagSuffix}`;
    if (visibleWidth(candidate) <= budget) return candidate;
  }
  return truncate(meta, budget);
}

/**
 * Color an unselected row's metadata cell: repo/template names take the dimmed
 * red, but a template's parenthesized repo list stays grey, so `@name (repos)`
 * reads as a dim-red parent with greyed children.
 */
function colorizeMeta(metaCell: string): TerminalSpan[] {
  if (metaCell.startsWith("@")) {
    const parenAt = metaCell.indexOf(" (");
    if (parenAt !== -1) {
      const name = metaCell.slice(0, parenAt);
      const repos = metaCell.slice(parenAt);
      return [
        terminalSpan(name, { role: "dim" }),
        terminalSpan(repos, { role: "muted" }),
      ];
    }
  }
  return [terminalSpan(metaCell, { role: "dim" })];
}

function renderItem<T>(
  item: FuzzyItem<T>,
  selected: boolean,
  inner: number,
  _theme: Theme,
  columns: Columns,
  checked?: boolean,
): string {
  const { time, meta } = splitHint(item.hint);

  const nameCell = padColumn(item.label, columns.name);
  const timeCell = padColumn(time, columns.time);
  const marker = checked === undefined ? "" : checked ? "◼ " : "◻ ";
  const markerWidth = visibleWidth(marker);
  // Three columns for the indent/rule lead, two-space gutters, and one trailing
  // column left free so a full-width line never wraps in blessed.
  const used =
    3 + markerWidth + visibleWidth(nameCell) + 2 + visibleWidth(timeCell) + 2;
  const metaCell = fitMetaList(meta, Math.max(0, inner - used - 1));
  const plain =
    markerWidth +
    visibleWidth(nameCell) +
    2 +
    visibleWidth(timeCell) +
    2 +
    visibleWidth(metaCell);

  if (selected) {
    // Selected: name bold white, timestamp and metadata both cyan.
    const content = blessedLine([
      ...(marker
        ? [terminalSpan(marker, { role: "focus", emphasis: "bold" })]
        : []),
      terminalSpan(nameCell, { role: "focus", emphasis: "bold" }),
      "  ",
      terminalSpan(timeCell, { role: "accent" }),
      "  ",
      terminalSpan(metaCell, { role: "accent" }),
    ]);
    return ruledSelection(content, plain, inner);
  }

  // Unselected: bright-red name, dimmed-red timestamp and repo/template name.
  // For templates the parenthesized repo list stays grey. No bullet — a leading
  // marker would imply radio-button semantics that don't exist.
  return blessedLine([
    "   ",
    ...(marker ? [terminalSpan(marker, { role: "muted" })] : []),
    terminalSpan(nameCell, { role: "primary" }),
    "  ",
    terminalSpan(timeCell, { role: "dim" }),
    "  ",
    ...colorizeMeta(metaCell),
  ]);
}

function renderAction(label: string, selected: boolean, inner: number): string {
  const budget = Math.max(1, inner - 3);
  const text = truncate(label, budget);
  if (selected) {
    const content = blessedLine(
      terminalSpan(text, { role: "focus", emphasis: "bold" }),
    );
    return ruledSelection(content, visibleWidth(text), inner);
  }
  return blessedLine(["   ", terminalSpan(text, { role: "muted" })]);
}

/**
 * A prominent two-way scope toggle. Both options keep fixed positions; only the
 * highlight moves between them, so Tab never reorders the row. The selected
 * option's name is painted as a badge — a contrasting foreground on a
 * {@link ThemePalette.focus} background — with its connector (e.g. the "in " of
 * "in workforest") muted; unselected options render plain muted. An explicit,
 * accented Tab/Shift-Tab cue trails the options.
 */
function renderScopeBar(theme: Theme, toggle: FuzzyScopeToggle): string {
  const segments = toggle.options.map((option, i) =>
    renderScopeOption(theme, option, i === toggle.active),
  );
  const cue = blessedLine([
    terminalSpan("·", { role: "muted" }),
    " ",
    terminalSpan("tab/shift-tab", { role: "focus", emphasis: "bold" }),
    " ",
    terminalSpan("switches scope", { role: "muted" }),
  ]);
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
  _theme: Theme,
  option: FuzzyScopeOption,
  active: boolean,
): string {
  const { label } = option;
  const name = option.name ?? label;
  const at = name === label ? -1 : label.lastIndexOf(name);
  const before = at >= 0 ? label.slice(0, at).replace(/\s+$/, "") : "";
  const after =
    at >= 0 ? label.slice(at + name.length).replace(/^\s+/, "") : "";
  const padded = ` ${at >= 0 ? name : label} `;

  const nameCell = active
    ? terminalSpan(padded, { role: "primary", background: "focus" })
    : terminalSpan(padded, { role: "muted" });
  // A plain (un-highlighted) space separates the connector from the badge, so
  // the name reads as detached from "in" rather than fused to the highlight.
  return blessedLine([
    ...(before ? [terminalSpan(before, { role: "muted" }), " "] : []),
    nameCell,
    ...(after ? [" ", terminalSpan(after, { role: "muted" })] : []),
  ]);
}

function renderFooter(
  _theme: Theme,
  options: { tabHint?: string | undefined; multi?: boolean },
): string {
  const { tabHint, multi = false } = options;
  const base = multi ? MULTI_FOOTER_HINTS : FOOTER_HINTS;
  const hints: ReadonlyArray<readonly [string, string]> =
    tabHint && !multi ? [...base, ["tab", tabHint.toUpperCase()]] : base;
  return hints
    .map(([key, action]) =>
      blessedLine([
        terminalSpan(`[${key}]`, { role: "accent" }),
        " ",
        terminalSpan(action, { role: "muted" }),
      ]),
    )
    .join("   ");
}

function blessedLine(input: TerminalLineInput | TerminalSpan): string {
  if (typeof input === "string") {
    return renderTerminalLineBlessed(terminalLine(input));
  }
  return renderTerminalLineBlessed(
    terminalLine("text" in input ? [input] : input),
  );
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
