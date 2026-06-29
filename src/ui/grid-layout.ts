import { Box, type Screen, ScrollableBox } from "@unblessed/node";

type GridParent = Screen | Box;

export interface GridLayoutOptions {
  screen: Screen;
  parent?: GridParent;
  top?: number | string;
  left?: number | string;
  width?: number | string;
  height?: number | string;
  rows: number;
  cols: number;
  borderColor?: string;
  backgroundColor?: string;
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
 * A grid layout of independently framed panes.
 */
export class GridLayout {
  private screen: Screen;
  private parent: GridParent;
  private panes: GridPaneImpl[] = [];
  private rows: number;
  private cols: number;
  private borderColor: string;
  private backgroundColor: string | undefined;
  private maxLinesPerPane: number;

  // Computed dimensions
  private frameTop: number;
  private frameLeft: number;
  private frameWidth: number;
  private frameHeight: number;

  constructor(options: GridLayoutOptions) {
    this.screen = options.screen;
    this.parent = options.parent ?? options.screen;
    this.rows = options.rows;
    this.cols = options.cols;
    this.borderColor = options.borderColor ?? "yellow";
    this.backgroundColor = options.backgroundColor;
    this.maxLinesPerPane = options.maxLinesPerPane ?? 200;

    // Resolve percentage-based dimensions to actual values
    const screenWidth = this.parent.width as number;
    const screenHeight = this.parent.height as number;

    this.frameTop = this.resolvePosition(options.top ?? 0, screenHeight);
    this.frameLeft = this.resolvePosition(options.left ?? 0, screenWidth);
    this.frameWidth = this.resolveSize(options.width ?? "100%", screenWidth);
    this.frameHeight = this.resolveSize(options.height ?? "100%", screenHeight);

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

  private createPanes(): void {
    for (let i = 0; i < this.rows * this.cols; i++) {
      const row = Math.floor(i / this.cols);
      const col = i % this.cols;

      const { top, left, width, height } = this.getCellBounds(row, col);
      const frame = new Box({
        parent: this.parent,
        top,
        left,
        width,
        height,
        tags: true,
        wrap: false,
        border: { type: "line", style: "round" },
        style: {
          fg: this.borderColor,
          ...(this.backgroundColor ? { bg: this.backgroundColor } : {}),
          border: {
            fg: this.borderColor,
            ...(this.backgroundColor ? { bg: this.backgroundColor } : {}),
          },
        },
      });

      const box = new ScrollableBox({
        parent: this.parent,
        top: top + 1,
        left: left + 1,
        width: Math.max(width - 2, 1),
        height: Math.max(height - 2, 1),
        tags: true,
        keys: true,
        vi: true,
        mouse: true,
        alwaysScroll: true,
        style: {
          ...(this.backgroundColor ? { bg: this.backgroundColor } : {}),
        },
        scrollbar: {
          ch: " ",
          track: { bg: this.backgroundColor ?? "black" },
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

      const pane = new GridPaneImpl(
        frame,
        box,
        row,
        col,
        this.maxLinesPerPane,
        this.parent,
        this.borderColor,
        this.backgroundColor,
        top,
        left,
        width,
        height,
      );

      this.panes.push(pane);
    }
  }

  private getCellBounds(
    row: number,
    col: number,
  ): { top: number; left: number; width: number; height: number } {
    const leftOffset = Math.floor((col * this.frameWidth) / this.cols);
    const rightOffset = Math.floor(((col + 1) * this.frameWidth) / this.cols);
    const topOffset = Math.floor((row * this.frameHeight) / this.rows);
    const bottomOffset = Math.floor(((row + 1) * this.frameHeight) / this.rows);

    return {
      top: this.frameTop + topOffset,
      left: this.frameLeft + leftOffset,
      width: Math.max(rightOffset - leftOffset, 3),
      height: Math.max(bottomOffset - topOffset, 3),
    };
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
    for (const pane of this.panes) {
      pane.destroy();
    }
  }
}

/**
 * Internal implementation of GridPane with line buffering.
 */
class GridPaneImpl implements GridPane {
  private frame: Box;
  private box: ScrollableBox;
  private lines: string[] = [];
  private content = "";
  private maxLines: number;
  private labelParent: GridParent;
  private borderColor: string;
  private backgroundColor: string | undefined;
  private labelBox: Box | null = null;
  private currentLabel: string | null = null;
  private readonly visibleLineBudget: number;
  private readonly labelWidth: number;
  private readonly labelTop: number;
  private readonly labelLeft: number;

  row: number;
  col: number;

  constructor(
    frame: Box,
    box: ScrollableBox,
    row: number,
    col: number,
    maxLines: number,
    labelParent: GridParent,
    borderColor: string,
    backgroundColor: string | undefined,
    frameTop: number,
    frameLeft: number,
    frameWidth: number,
    frameHeight: number,
  ) {
    this.frame = frame;
    this.box = box;
    this.row = row;
    this.col = col;
    this.maxLines = maxLines;
    this.labelParent = labelParent;
    this.borderColor = borderColor;
    this.backgroundColor = backgroundColor;
    this.visibleLineBudget = Math.max(frameHeight - 2, 1);
    this.labelWidth = Math.max(frameWidth - 2, 1);
    this.labelTop = frameTop;
    this.labelLeft = frameLeft + 1;
  }

  setLabel(label: string): void {
    if (label === this.currentLabel) {
      return;
    }
    this.currentLabel = label;

    if (!this.labelBox) {
      this.labelBox = new Box({
        parent: this.labelParent,
        top: this.labelTop,
        left: this.labelLeft,
        width: this.labelWidth,
        height: 1,
        tags: true,
        style: {
          fg: this.borderColor,
          ...(this.backgroundColor ? { bg: this.backgroundColor } : {}),
        },
      });
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
    if (this.labelBox) {
      this.labelBox.destroy();
    }
    this.box.destroy();
    this.frame.destroy();
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
