// A single full-frame border layer for the setup grid, tmux style: adjacent
// panes share one gridline instead of each drawing its own box (which used
// to double every interior border). Rects are rasterized into a per-cell
// arm bitmask that is OR-merged across the whole canvas, so shared edges
// and junctions fall out of the geometry instead of being special-cased.

export type BorderRect = Readonly<{
  top: number;
  left: number;
  width: number;
  height: number;
}>;

export type BorderCanvasInput = Readonly<{
  width: number;
  height: number;
  rects: readonly Readonly<{ rect: BorderRect; focused: boolean }>[];
  baseColor: string;
  focusColor: string;
}>;

// Compass arms touching a cell, one bit each. A cell's final glyph is
// determined entirely by which arms are set, regardless of how many rects
// contributed them.
const ARM_UP = 1;
const ARM_RIGHT = 2;
const ARM_DOWN = 4;
const ARM_LEFT = 8;

// All 16 arm combinations a 4-bit mask can take. Corners and T-junctions
// aren't special-cased elsewhere: OR-merging adjacent rects' outlines lands
// on one of these entries automatically (e.g. two adjoining corners produce
// a T, four produce a cross).
const GLYPH_BY_ARMS: Readonly<Record<number, string>> = {
  0: " ",
  1: "│",
  2: "─",
  3: "╰",
  4: "│",
  5: "│",
  6: "╭",
  7: "├",
  8: "─",
  9: "╯",
  10: "─",
  11: "┴",
  12: "╮",
  13: "┤",
  14: "┬",
  15: "┼",
};

function markArm(
  arms: number[],
  focusedCells: boolean[],
  canvasWidth: number,
  canvasHeight: number,
  x: number,
  y: number,
  arm: number,
  focused: boolean,
): void {
  if (x < 0 || x >= canvasWidth || y < 0 || y >= canvasHeight) {
    return; // Off-canvas: clip silently rather than reject the whole rect.
  }
  const index = y * canvasWidth + x;
  arms[index] = (arms[index] ?? 0) | arm;
  // Only ever set to true. A focused rect can be rasterized before or after
  // a non-focused one sharing the same cell; focus must win either way, and
  // it never needs to be revoked once set.
  if (focused) {
    focusedCells[index] = true;
  }
}

function rasterizeRect(
  arms: number[],
  focusedCells: boolean[],
  canvasWidth: number,
  canvasHeight: number,
  entry: Readonly<{ rect: BorderRect; focused: boolean }>,
): void {
  const { rect, focused } = entry;
  const { top, left, width, height } = rect;
  if (width <= 0 || height <= 0) {
    return;
  }
  const right = left + width - 1;
  const bottom = top + height - 1;

  // Top and bottom edges: every column gets a right arm unless it's the
  // rightmost column, and a left arm unless it's the leftmost. The two end
  // columns end up as lone arms here; the corner glyph comes from combining
  // that with the vertical edge's contribution at the same cell below.
  for (let x = left; x <= right; x++) {
    let topArms = 0;
    if (x > left) topArms |= ARM_LEFT;
    if (x < right) topArms |= ARM_RIGHT;
    markArm(
      arms,
      focusedCells,
      canvasWidth,
      canvasHeight,
      x,
      top,
      topArms,
      focused,
    );

    let bottomArms = 0;
    if (x > left) bottomArms |= ARM_LEFT;
    if (x < right) bottomArms |= ARM_RIGHT;
    markArm(
      arms,
      focusedCells,
      canvasWidth,
      canvasHeight,
      x,
      bottom,
      bottomArms,
      focused,
    );
  }

  // Left and right edges, mirroring the horizontal pass with up/down arms.
  for (let y = top; y <= bottom; y++) {
    let leftArms = 0;
    if (y > top) leftArms |= ARM_UP;
    if (y < bottom) leftArms |= ARM_DOWN;
    markArm(
      arms,
      focusedCells,
      canvasWidth,
      canvasHeight,
      left,
      y,
      leftArms,
      focused,
    );

    let rightArms = 0;
    if (y > top) rightArms |= ARM_UP;
    if (y < bottom) rightArms |= ARM_DOWN;
    markArm(
      arms,
      focusedCells,
      canvasWidth,
      canvasHeight,
      right,
      y,
      rightArms,
      focused,
    );
  }
}

function composeRow(
  arms: number[],
  focusedCells: boolean[],
  y: number,
  width: number,
  baseColor: string,
  focusColor: string,
): string {
  let row = "";
  let x = 0;
  while (x < width) {
    const index = y * width + x;
    const mask = arms[index] ?? 0;
    if (mask === 0) {
      row += " "; // Spaces are emitted outside any tag.
      x++;
      continue;
    }

    // Widen the run for as long as the color stays the same, so a whole
    // wall of matching border cells shares one open/close tag pair instead
    // of wrapping every glyph individually.
    const color = (focusedCells[index] ?? false) ? focusColor : baseColor;
    let run = "";
    while (x < width) {
      const cellIndex = y * width + x;
      const cellMask = arms[cellIndex] ?? 0;
      if (cellMask === 0) {
        break;
      }
      const cellColor =
        (focusedCells[cellIndex] ?? false) ? focusColor : baseColor;
      if (cellColor !== color) {
        break;
      }
      run += GLYPH_BY_ARMS[cellMask] ?? " ";
      x++;
    }
    row += `{${color}-fg}${run}{/${color}-fg}`;
  }
  return row;
}

/**
 * Compose the full-frame border layer for a set of rects. Returns exactly
 * `height` blessed-tags strings, each exactly `width` visible cells wide.
 */
export function composeBorderCanvas(input: BorderCanvasInput): string[] {
  const { width, height, rects, baseColor, focusColor } = input;
  if (width <= 0 || height <= 0) {
    return [];
  }

  const arms = new Array<number>(width * height).fill(0);
  const focusedCells = new Array<boolean>(width * height).fill(false);

  for (const entry of rects) {
    rasterizeRect(arms, focusedCells, width, height, entry);
  }

  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    rows.push(composeRow(arms, focusedCells, y, width, baseColor, focusColor));
  }
  return rows;
}
