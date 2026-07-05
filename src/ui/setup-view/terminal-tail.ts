/**
 * Replays run-event output through a headless VT100 emulator so the grid can
 * render "what the terminal screen looks like now" per repo, instead of raw
 * PTY chunks that contain SGR color codes, `\r` progress rewrites, and
 * cursor-addressed multi-line redraws (e.g. pnpm's TTY reporter).
 *
 * One `@xterm/headless` `Terminal` is kept per pane key. Its cols/rows must
 * match the PTY dimensions the setup child processes were spawned with,
 * otherwise line-wrapping here will not match what the process actually drew.
 */

import { SETUP_PTY_COLS, SETUP_PTY_ROWS } from "@wf-plugin/core";
import type { Terminal } from "@xterm/headless";
// @xterm/headless ships only a CJS bundle whose named exports Node's ESM
// loader cannot detect statically (vitest interops them, real `node` throws
// "does not provide an export named 'Terminal'"), so the value must come off
// the default export. The type-only import below is erased at runtime.
import xtermHeadless from "@xterm/headless";
import { normalizeControlText } from "../../terminal/command-stream-adapter.ts";

const { Terminal: HeadlessTerminal } = xtermHeadless;

import type { RunEvent } from "../../workspace/run-log/events.ts";
import { WORKSPACE_PANE_NAME } from "./model.ts";

// `IBufferNamespace`/`IBuffer`/`IBufferLine`/`IBufferCell` are declared but
// not exported by @xterm/headless's typings, so their shapes are recovered
// via indexed access off the one exported class instead of naming them.
type XtermBuffer = Terminal["buffer"]["active"];
type XtermBufferLine = NonNullable<ReturnType<XtermBuffer["getLine"]>>;
type XtermBufferCell = NonNullable<ReturnType<XtermBufferLine["getCell"]>>;

export type TerminalTailOptions = {
  cols?: number;
  rows?: number;
  scrollback?: number;
};

const DEFAULT_SCROLLBACK = 200;

type TerminalEntry = {
  term: Terminal;
  /** Chains successive writes so `flush()` can await the latest one. */
  pending: Promise<void>;
};

export class TerminalTailStore {
  readonly #cols: number;
  readonly #rows: number;
  readonly #scrollback: number;
  readonly #terminals = new Map<string, TerminalEntry>();

  constructor(options: TerminalTailOptions = {}) {
    this.#cols = options.cols ?? SETUP_PTY_COLS;
    this.#rows = options.rows ?? SETUP_PTY_ROWS;
    this.#scrollback = options.scrollback ?? DEFAULT_SCROLLBACK;
  }

  /**
   * Feeds one run event into the emulator for its pane. Events with no
   * output semantics (step lifecycle, repo lifecycle, run lifecycle) are
   * ignored, so a pane with only those never gets a terminal allocated.
   */
  async apply(event: RunEvent): Promise<void> {
    switch (event.kind) {
      case "step-output": {
        await this.#write(event.repo, event.chunk);
        return;
      }
      case "step-log": {
        const message = normalizeControlText(event.message);
        await this.#write(event.repo, `${message}\r\n`);
        return;
      }
      case "step-retry": {
        const entry = this.#entryFor(event.repo);
        // A retry restarts the step's output; a stale screen would
        // misattribute the previous attempt's output to the new one.
        entry.term.reset();
        const reason = normalizeControlText(event.reason);
        await this.#writeEntry(entry, `Retry ${event.attempt}: ${reason}\r\n`);
        return;
      }
      default:
        return;
    }
  }

  /**
   * Renders the current screen for `key` as text lines with minimal SGR,
   * oldest first, trimmed of trailing blank rows and capped at the
   * configured row count. Returns null when nothing has ever been written
   * for that key (including after `dispose()`).
   */
  linesFor(key: string): string[] | null {
    const entry = this.#terminals.get(key);
    if (!entry) return null;

    const buffer = entry.term.buffer.active;
    const workCell = buffer.getNullCell();
    const cache = new Map<number, string>();
    const serializedAt = (y: number): string => {
      const cached = cache.get(y);
      if (cached !== undefined) return cached;
      const line = buffer.getLine(y);
      const serialized = line ? serializeLine(line, workCell) : "";
      cache.set(y, serialized);
      return serialized;
    };

    let end = buffer.length - 1;
    while (end >= 0 && serializedAt(end) === "") end -= 1;
    if (end < 0) return [];

    const start = Math.max(0, end - this.#rows + 1);
    const lines: string[] = [];
    for (let y = start; y <= end; y++) lines.push(serializedAt(y));
    return lines;
  }

  /** Resolves once every pane's pending writes have been parsed. */
  async flush(): Promise<void> {
    await Promise.all([...this.#terminals.values()].map((e) => e.pending));
  }

  dispose(): void {
    for (const entry of this.#terminals.values()) entry.term.dispose();
    this.#terminals.clear();
  }

  #entryFor(repo: string | null): TerminalEntry {
    const key = repo ?? WORKSPACE_PANE_NAME;
    const existing = this.#terminals.get(key);
    if (existing) return existing;
    const created: TerminalEntry = {
      term: new HeadlessTerminal({
        cols: this.#cols,
        rows: this.#rows,
        scrollback: this.#scrollback,
        allowProposedApi: true,
        // PTY-spawned steps emit \r\n via the line discipline's ONLCR, but
        // pipe-spawned steps (git, vercel/turbo link) emit bare \n with no
        // PTY to add the \r. xterm treats \n as line-feed-only, so without
        // this those chunks render as a staircase, each line starting one
        // column further right than the last. convertEol treats every \n as
        // \r\n, which is a no-op for streams that already send \r\n.
        convertEol: true,
      }),
      pending: Promise.resolve(),
    };
    this.#terminals.set(key, created);
    return created;
  }

  async #write(repo: string | null, data: string): Promise<void> {
    await this.#writeEntry(this.#entryFor(repo), data);
  }

  async #writeEntry(entry: TerminalEntry, data: string): Promise<void> {
    const next = entry.pending.then(
      () =>
        new Promise<void>((resolve) => {
          entry.term.write(data, resolve);
        }),
    );
    entry.pending = next;
    await next;
  }
}

type Cell = { char: string; style: readonly string[] };
type Run = { style: readonly string[]; text: string };

/**
 * Renders one buffer row as text plus minimal SGR: only printable characters
 * and `\x1b[...m` sequences, nothing that moves a cursor, because the
 * consumer feeds this to a blessed-tags renderer that strips other escapes
 * poorly.
 */
function serializeLine(
  line: XtermBufferLine,
  workCell: XtermBufferCell,
): string {
  const trimmed = trimTrailingBlank(collectCells(line, workCell));
  if (trimmed.length === 0) return "";
  return renderRuns(mergeRuns(trimmed));
}

function collectCells(
  line: XtermBufferLine,
  workCell: XtermBufferCell,
): Cell[] {
  const cells: Cell[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x, workCell);
    if (!cell) continue;
    // Width-0 cells are continuation slots following a wide (e.g. CJK)
    // character in the previous column; the wide cell's chars already
    // cover them.
    if (cell.getWidth() === 0) continue;
    cells.push({
      char: stripVariationSelector(cell.getChars() || " "),
      style: sgrParams(cell),
    });
  }
  return cells;
}

// @unblessed's width table used to hardcode U+2714/U+2716 as double-width
// while real terminals (and xterm here) render them single-width; a pnpm
// patch (patches/@unblessed__core@1.0.0-alpha.23.patch) fixes that at the
// source, guarded by src/terminal/unblessed-width.test.ts against a future
// @unblessed upgrade silently dropping it. What's still this module's job:
// xterm folds a trailing variation selector (U+FE0E/U+FE0F) into the base
// character's cell, since combining marks don't get their own column. CLIs
// (e.g. the Vercel CLI's success checkmark) commonly emit that selector after
// U+2714. If it reaches @unblessed's blessed-tags renderer as part of the
// cell's text, it desyncs the column model again: @unblessed spends its own
// column on U+FE0E, and U+FE0F can flip some terminals into wide emoji
// presentation for the preceding glyph. Stripping it here is safe because the
// base glyph renders identically without it.
const VARIATION_SELECTORS = new Set(["\u{FE0E}", "\u{FE0F}"]);

function stripVariationSelector(chars: string): string {
  const last = chars.at(-1);
  return last !== undefined && VARIATION_SELECTORS.has(last)
    ? chars.slice(0, -1)
    : chars;
}

function trimTrailingBlank(cells: readonly Cell[]): readonly Cell[] {
  let end = cells.length;
  while (end > 0) {
    const cell = cells[end - 1];
    if (cell !== undefined && cell.char.trim() !== "") break;
    end -= 1;
  }
  return cells.slice(0, end);
}

function mergeRuns(cells: readonly Cell[]): Run[] {
  const runs: Run[] = [];
  for (const cell of cells) {
    const last = runs[runs.length - 1];
    if (last && styleEquals(last.style, cell.style)) {
      last.text += cell.char;
    } else {
      runs.push({ style: cell.style, text: cell.char });
    }
  }
  return runs;
}

function styleEquals(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

/**
 * Every run boundary here is a real style change (equal adjacent styles were
 * already merged), so a reset before each non-first run is always correct:
 * SGR color/attribute params only ever add to the active state, they do not
 * clear categories they don't mention.
 */
function renderRuns(runs: readonly Run[]): string {
  let out = "";
  let styleOpen = false;
  runs.forEach((run, index) => {
    if (index > 0) out += "\x1b[0m";
    if (run.style.length > 0) {
      out += `\x1b[${run.style.join(";")}m`;
      styleOpen = true;
    }
    out += run.text;
  });
  if (styleOpen) out += "\x1b[0m";
  return out;
}

function sgrParams(cell: XtermBufferCell): string[] {
  const params: string[] = [];
  if (cell.isBold() !== 0) params.push("1");
  if (cell.isDim() !== 0) params.push("2");
  if (cell.isItalic() !== 0) params.push("3");
  if (cell.isUnderline() !== 0) params.push("4");
  if (cell.isInverse() !== 0) params.push("7");

  if (cell.isFgRGB()) {
    params.push(rgbParam(38, cell.getFgColor()));
  } else if (cell.isFgPalette()) {
    params.push(...paletteParams(30, 90, 38, cell.getFgColor()));
  }

  if (cell.isBgRGB()) {
    params.push(rgbParam(48, cell.getBgColor()));
  } else if (cell.isBgPalette()) {
    params.push(...paletteParams(40, 100, 48, cell.getBgColor()));
  }

  return params;
}

function rgbParam(base: 38 | 48, color: number): string {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  return `${base};2;${r};${g};${b}`;
}

function paletteParams(
  baseLow: number,
  baseHigh: number,
  extBase: 38 | 48,
  index: number,
): string[] {
  if (index < 8) return [String(baseLow + index)];
  if (index < 16) return [String(baseHigh + (index - 8))];
  return [`${extBase};5;${index}`];
}
