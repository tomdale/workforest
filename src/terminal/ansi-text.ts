/**
 * Display-width-aware text helpers for terminal panes. Plain `.length`/
 * `.slice` truncation is wrong once a string can contain SGR escapes (zero
 * display width) or wide glyphs (CJK/emoji, two columns each), so anything
 * that has to fit inside a fixed-width pane needs these instead.
 */

import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";

/**
 * Truncate `value` to at most `width` display columns, appending an
 * ellipsis when it had to cut. Uses slice-ansi rather than a plain
 * character slice so any SGR styling that spans the cut point is closed
 * cleanly instead of leaking into whatever text follows.
 */
export function truncateAnsi(value: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(value) <= width) return value;
  return `${sliceAnsi(value, 0, Math.max(width - 1, 0))}…`;
}

// OSC (Operating System Command): ESC ] ... terminated by BEL or ST (ESC \).
// Used for things like setting the terminal title; has no place inside a
// rendered pane line.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching literal control bytes is the point of an ANSI stripper.
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// CSI (Control Sequence Introducer) sequences whose final byte is anything
// other than "m" — cursor moves, line/screen clears, and similar. SGR
// (color/attribute) sequences also start with ESC [ but always end in "m",
// so this deliberately excludes them.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching literal control bytes is the point of an ANSI stripper.
const CSI_NON_SGR_PATTERN = /\x1b\[[0-9;?]*[^0-9;?m]/g;

// Any ESC byte that survived the two patterns above and isn't the start of
// a kept SGR sequence (ESC [ <digits/semicolons> m). Covers stray/malformed
// escapes; only the ESC byte itself is removed, matching @unblessed's own
// fallback behavior for sequences it doesn't understand.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching literal control bytes is the point of an ANSI stripper.
const STRAY_ESC_PATTERN = /\x1b(?!\[[0-9;]*m)/g;

// C0 control characters (0x00-0x1F) except tab, newline, and ESC (0x1b is
// preserved here because any ESC remaining at this point is the start of a
// kept SGR sequence, not stray).
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching literal control bytes is the point of an ANSI stripper.
const C0_CONTROL_PATTERN = /[\x00-\x08\x0b-\x1a\x1c-\x1f]/g;

/**
 * Remove ANSI escape sequences except SGR color/attribute codes, plus C0
 * control characters other than newline and tab. @unblessed renders SGR
 * natively but only strips the ESC byte of everything else, leaving litter
 * like `[2K` or `]0;title` visible in pane output.
 */
export function stripNonSgr(value: string): string {
  return value
    .replace(OSC_PATTERN, "")
    .replace(CSI_NON_SGR_PATTERN, "")
    .replace(STRAY_ESC_PATTERN, "")
    .replace(C0_CONTROL_PATTERN, "");
}
