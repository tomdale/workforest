import { Box, type Screen, ScrollableBox } from "@unblessed/node";

export interface GridLayoutOptions {
  screen: Screen;
  top?: number | string;
  left?: number | string;
  width?: number | string;
  height?: number | string;
  rows: number;
  cols: number;
  borderColor?: string;
  maxLinesPerPane?: number;
}

export interface GridPane {
  row: number;
  col: number;
  setLabel(label: string): void;
  appendLine(line: string): void;
  setContent(content: string): void;
  getLineCount(): number;
}

/**
 * A grid layout with collapsed/shared borders.
 * Renders a single frame with proper box-drawing connectors and
 * positions content panes inside each cell.
 */
export class GridLayout {
  private screen: Screen;
  private frame: Box;
  private panes: GridPaneImpl[] = [];
  private rows: number;
  private cols: number;
  private borderColor: string;
  private maxLinesPerPane: number;

  // Computed dimensions
  private frameTop: number;
  private frameLeft: number;
  private frameWidth: number;
  private frameHeight: number;
  private cellWidth: number;
  private cellHeight: number;

  constructor(options: GridLayoutOptions) {
    this.screen = options.screen;
    this.rows = options.rows;
    this.cols = options.cols;
    this.borderColor = options.borderColor ?? "yellow";
    this.maxLinesPerPane = options.maxLinesPerPane ?? 200;

    // Resolve percentage-based dimensions to actual values
    const screenWidth = this.screen.width as number;
    const screenHeight = this.screen.height as number;

    this.frameTop = this.resolvePosition(options.top ?? 0, screenHeight);
    this.frameLeft = this.resolvePosition(options.left ?? 0, screenWidth);
    // Subtract 1 from width/height to ensure borders fit on screen
    this.frameWidth =
      this.resolveSize(options.width ?? "100%", screenWidth) - 1;
    this.frameHeight =
      this.resolveSize(options.height ?? "100%", screenHeight) - 1;

    this.cellWidth = Math.floor(this.frameWidth / this.cols);
    this.cellHeight = Math.floor(this.frameHeight / this.rows);

    this.frame = this.createFrame();
    this.screen.append(this.frame);

    this.createPanes();
  }

  private resolvePosition(value: number | string, total: number): number {
    if (typeof value === "number") return value;
    if (value.endsWith("%")) {
      return Math.floor((Number.parseFloat(value) / 100) * total);
    }
    return Number.parseInt(value, 10);
  }

  private resolveSize(value: number | string, total: number): number {
    if (typeof value === "number") return value;
    if (value.includes("%")) {
      // Handle "100%-4" style expressions
      const match = value.match(/^(\d+)%(?:([+-])(\d+))?$/);
      if (match?.[1]) {
        const pct = Number.parseFloat(match[1]);
        const base = Math.floor((pct / 100) * total);
        if (match[2] && match[3]) {
          const offset = Number.parseInt(match[3], 10);
          return match[2] === "+" ? base + offset : base - offset;
        }
        return base;
      }
    }
    return Number.parseInt(value, 10);
  }

  private buildFrame(): string {
    const lines: string[] = [];
    const w = this.frameWidth;
    const h = this.frameHeight;

    for (let y = 0; y < h; y++) {
      let line = "";
      for (let x = 0; x < w; x++) {
        const isTop = y === 0;
        const isBottom = y === h - 1;
        const isLeft = x === 0;
        const isRight = x === w - 1;
        const isHDiv = y > 0 && y < h - 1 && y % this.cellHeight === 0;
        const isVDiv = x > 0 && x < w - 1 && x % this.cellWidth === 0;

        if (isTop && isLeft) line += "\u250c";
        else if (isTop && isRight) line += "\u2510";
        else if (isBottom && isLeft) line += "\u2514";
        else if (isBottom && isRight) line += "\u2518";
        else if (isTop && isVDiv) line += "\u252c";
        else if (isBottom && isVDiv) line += "\u2534";
        else if (isLeft && isHDiv) line += "\u251c";
        else if (isRight && isHDiv) line += "\u2524";
        else if (isHDiv && isVDiv) line += "\u253c";
        else if (isTop || isBottom || isHDiv) line += "\u2500";
        else if (isLeft || isRight || isVDiv) line += "\u2502";
        else line += " ";
      }
      lines.push(line);
    }
    return lines.join("\n");
  }

  private createFrame(): Box {
    return new Box({
      top: this.frameTop,
      left: this.frameLeft,
      width: this.frameWidth,
      height: this.frameHeight,
      content: this.buildFrame(),
      style: { fg: this.borderColor },
    });
  }

  private createPanes(): void {
    for (let i = 0; i < this.rows * this.cols; i++) {
      const row = Math.floor(i / this.cols);
      const col = i % this.cols;

      // Position pane inside the cell (accounting for borders)
      const paneTop = this.frameTop + row * this.cellHeight + 1;
      const paneLeft = this.frameLeft + col * this.cellWidth + 1;
      // Last row/col need extra space for borders (not shared like internal dividers)
      const isLastRow = row === this.rows - 1;
      const isLastCol = col === this.cols - 1;
      const paneWidth = this.cellWidth - (isLastCol ? 2 : 1);
      const paneHeight = this.cellHeight - (isLastRow ? 2 : 1);

      const box = new ScrollableBox({
        top: paneTop,
        left: paneLeft,
        width: paneWidth,
        height: paneHeight,
        tags: true,
        keys: true,
        vi: true,
        mouse: true,
        alwaysScroll: true,
        scrollbar: {
          ch: " ",
          track: { bg: "black" },
          style: { inverse: true },
        },
      });

      // Enable scrolling with arrow keys
      box.key(
        ["up", "down", "pageup", "pagedown"],
        (_ch: string, key: { name: string }) => {
          if (key.name === "up") box.scroll?.(-1);
          else if (key.name === "down") box.scroll?.(1);
          else if (key.name === "pageup") box.scroll?.(-(box.height as number));
          else if (key.name === "pagedown") box.scroll?.(box.height as number);
          this.screen.render();
        },
      );

      this.screen.append(box);

      const pane = new GridPaneImpl(
        box,
        row,
        col,
        this.maxLinesPerPane,
        this.screen,
        this.frameTop,
        this.frameLeft,
        this.cellWidth,
        this.cellHeight,
      );

      this.panes.push(pane);
    }
  }

  getPane(index: number): GridPane | undefined {
    return this.panes[index];
  }

  getPaneAt(row: number, col: number): GridPane | undefined {
    return this.panes[row * this.cols + col];
  }

  getPaneCount(): number {
    return this.panes.length;
  }

  getAllPanes(): GridPane[] {
    return [...this.panes];
  }

  render(): void {
    this.screen.render();
  }

  destroy(): void {
    this.frame.destroy();
    for (const pane of this.panes) {
      pane.destroy();
    }
  }
}

/**
 * Internal implementation of GridPane with line buffering.
 */
class GridPaneImpl implements GridPane {
  private box: ScrollableBox;
  private lines: string[] = [];
  private content = "";
  private maxLines: number;
  private screen: Screen;
  private labelBox: Box | null = null;
  private currentLabel: string | null = null;
  private readonly visibleLineBudget: number;
  private readonly labelWidth: number;

  // Position info for label rendering
  private frameTop: number;
  private frameLeft: number;
  private cellWidth: number;
  private cellHeight: number;

  row: number;
  col: number;

  constructor(
    box: ScrollableBox,
    row: number,
    col: number,
    maxLines: number,
    screen: Screen,
    frameTop: number,
    frameLeft: number,
    cellWidth: number,
    cellHeight: number,
  ) {
    this.box = box;
    this.row = row;
    this.col = col;
    this.maxLines = maxLines;
    this.screen = screen;
    this.frameTop = frameTop;
    this.frameLeft = frameLeft;
    this.cellWidth = cellWidth;
    this.cellHeight = cellHeight;
    this.visibleLineBudget = Math.max(this.cellHeight - 2, 1);
    this.labelWidth = Math.max(this.cellWidth - 2, 1);
  }

  setLabel(label: string): void {
    if (label === this.currentLabel) {
      return;
    }
    this.currentLabel = label;

    if (!this.labelBox) {
      const labelTop = this.frameTop + this.row * this.cellHeight;
      const labelLeft = this.frameLeft + this.col * this.cellWidth + 1;
      this.labelBox = new Box({
        top: labelTop,
        left: labelLeft,
        width: this.labelWidth,
        height: 1,
        tags: true,
      });
      this.screen.append(this.labelBox);
    }

    this.labelBox.setContent(this.formatLabelContent(label));
  }

  appendLine(line: string): void {
    const newLines = line.split("\n");
    let needsRebuild = false;
    const retainedLineBudget = this.getRetainedLineBudget();

    for (const newLine of newLines) {
      this.lines.push(newLine);
      if (this.lines.length > retainedLineBudget) {
        const excess = this.lines.length - retainedLineBudget;
        this.lines.splice(0, excess);
        needsRebuild = true;
      }
    }

    if (needsRebuild || this.content.length === 0) {
      this.content = this.lines.join("\n");
    } else {
      this.content += `\n${newLines.join("\n")}`;
    }

    this.box.setContent(this.content);
    this.box.setScrollPerc?.(100);
  }

  setContent(content: string): void {
    this.lines = content.split("\n");
    const retainedLineBudget = this.getRetainedLineBudget();
    if (this.lines.length > retainedLineBudget) {
      this.lines = this.lines.slice(this.lines.length - retainedLineBudget);
    }
    this.content = this.lines.join("\n");
    this.box.setContent(this.content);
    this.box.setScrollPerc?.(100);
  }

  getLineCount(): number {
    return this.lines.length;
  }

  destroy(): void {
    this.box.destroy();
    if (this.labelBox) {
      this.labelBox.destroy();
    }
  }

  private getVisualLength(str: string): number {
    // Remove blessed tags like {red-fg}, {/}, {bold}, etc.
    return str.replace(/\{[^}]*\}/g, "").length;
  }

  private getRetainedLineBudget(): number {
    return Math.min(
      this.maxLines,
      Math.max(this.visibleLineBudget * 2, this.visibleLineBudget + 4),
    );
  }

  private formatLabelContent(label: string): string {
    const maxLabelWidth = Math.max(this.labelWidth - 4, 1);
    const truncatedLabel = this.truncateToVisualWidth(label, maxLabelWidth);
    const labelVisualWidth = this.getVisualLength(truncatedLabel);
    const content = `\u2500 ${truncatedLabel} `;
    const remaining = Math.max(this.labelWidth - (labelVisualWidth + 3), 0);
    return `${content}${"\u2500".repeat(remaining)}`;
  }

  private truncateToVisualWidth(value: string, maxVisualWidth: number): string {
    if (this.getVisualLength(value) <= maxVisualWidth) {
      return value;
    }

    let visualLen = 0;
    let cutIndex = 0;
    let inTag = false;
    for (let i = 0; i < value.length; i++) {
      if (value[i] === "{") inTag = true;
      else if (value[i] === "}") inTag = false;
      else if (!inTag) {
        visualLen++;
        if (visualLen >= maxVisualWidth - 1) {
          cutIndex = i + 1;
          break;
        }
      }
    }

    return `${value.slice(0, cutIndex)}\u2026`;
  }
}

/**
 * Calculate optimal grid dimensions for a given number of items.
 */
export function calculateGridDimensions(count: number): {
  rows: number;
  cols: number;
} {
  if (count <= 1) return { rows: 1, cols: 1 };
  if (count === 2) return { rows: 1, cols: 2 };
  if (count <= 4) return { rows: 2, cols: 2 };
  if (count <= 6) return { rows: 2, cols: 3 };
  return { rows: 3, cols: 3 };
}
