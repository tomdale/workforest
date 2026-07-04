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
  focusBorderColor?: string;
  backgroundColor?: string;
  maxLinesPerPane?: number;
}

export interface GridPane {
  row: number;
  col: number;
  setLabel(label: string): void;
  appendLine(line: string): void;
  setContent(content: string): void;
  setFocused(focused: boolean): void;
  getLineCount(): number;
  /** Inner content area in cells, after borders. */
  getContentSize(): { width: number; height: number };
}

export type GridCellBounds = {
  top: number;
  left: number;
  width: number;
  height: number;
};

/**
 * A grid layout of independently framed panes. Cell bounds are recomputed on
 * {@link reflow} so terminal resizes reshape every pane, and panes can be
 * hidden or zoomed (one pane taking the whole frame) for paging and focus.
 */
export class GridLayout {
  private screen: Screen;
  private parent: GridParent;
  private panes: GridPaneImpl[] = [];
  private rows: number;
  private cols: number;
  private borderColor: string;
  private focusBorderColor: string;
  private backgroundColor: string | undefined;
  private maxLinesPerPane: number;

  private layout: {
    top: number | string;
    left: number | string;
    width: number | string;
    height: number | string;
  };

  // Computed dimensions
  private frameTop: number;
  private frameLeft: number;
  private frameWidth: number;
  private frameHeight: number;

  private zoomedIndex: number | null = null;
  private hiddenPanes = new Set<number>();

  constructor(options: GridLayoutOptions) {
    this.screen = options.screen;
    this.parent = options.parent ?? options.screen;
    this.rows = options.rows;
    this.cols = options.cols;
    this.borderColor = options.borderColor ?? "yellow";
    this.focusBorderColor = options.focusBorderColor ?? this.borderColor;
    this.backgroundColor = options.backgroundColor;
    this.maxLinesPerPane = options.maxLinesPerPane ?? 200;
    this.layout = {
      top: options.top ?? 0,
      left: options.left ?? 0,
      width: options.width ?? "100%",
      height: options.height ?? "100%",
    };

    const { top, left, width, height } = this.resolveFrame();
    this.frameTop = top;
    this.frameLeft = left;
    this.frameWidth = width;
    this.frameHeight = height;

    this.createPanes();
  }

  private resolveFrame(): GridCellBounds {
    const parentWidth = this.parent.width as number;
    const parentHeight = this.parent.height as number;
    return {
      top: this.resolvePosition(this.layout.top, parentHeight),
      left: this.resolvePosition(this.layout.left, parentWidth),
      width: this.resolveSize(this.layout.width, parentWidth),
      height: this.resolveSize(this.layout.height, parentHeight),
    };
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

      const bounds = this.getCellBounds(row, col);
      const frame = new Box({
        parent: this.parent,
        top: bounds.top,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
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
        top: bounds.top + 1,
        left: bounds.left + 1,
        width: Math.max(bounds.width - 2, 1),
        height: Math.max(bounds.height - 2, 1),
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

      const pane = new GridPaneImpl({
        frame,
        box,
        row,
        col,
        maxLines: this.maxLinesPerPane,
        labelParent: this.parent,
        borderColor: this.borderColor,
        focusBorderColor: this.focusBorderColor,
        backgroundColor: this.backgroundColor,
        bounds,
      });

      this.panes.push(pane);
    }
  }

  private getCellBounds(row: number, col: number): GridCellBounds {
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

  /**
   * Recompute the frame from the parent's current size and lay every pane
   * out again. Call on terminal resize; also applied after zoom changes.
   */
  reflow(): void {
    const { top, left, width, height } = this.resolveFrame();
    this.frameTop = top;
    this.frameLeft = left;
    this.frameWidth = width;
    this.frameHeight = height;
    this.applyLayout();
  }

  /**
   * Zoom one pane to the full frame (all other panes hide) or restore the
   * regular grid with `null`.
   */
  setZoomedPane(index: number | null): void {
    if (this.zoomedIndex === index) return;
    this.zoomedIndex = index;
    this.applyLayout();
  }

  /** Show a pane hidden by paging. No-op when the pane does not exist. */
  setVisiblePane(index: number): void {
    this.hiddenPanes.delete(index);
    const pane = this.panes[index];
    if (!pane || this.zoomedIndex !== null) return;
    pane.setBounds(this.getCellBounds(pane.row, pane.col));
    pane.setVisible(true);
  }

  /** Hide a pane (paging past it, or unused grid slots). */
  hidePane(index: number): void {
    this.hiddenPanes.add(index);
    if (this.zoomedIndex !== null) return;
    this.panes[index]?.setVisible(false);
  }

  private applyLayout(): void {
    this.panes.forEach((pane, index) => {
      if (this.zoomedIndex !== null) {
        if (index === this.zoomedIndex) {
          pane.setBounds({
            top: this.frameTop,
            left: this.frameLeft,
            width: Math.max(this.frameWidth, 3),
            height: Math.max(this.frameHeight, 3),
          });
          pane.setVisible(true);
        } else {
          pane.setVisible(false);
        }
        return;
      }

      pane.setBounds(this.getCellBounds(pane.row, pane.col));
      pane.setVisible(!this.hiddenPanes.has(index));
    });
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
  private focusBorderColor: string;
  private backgroundColor: string | undefined;
  private labelBox: Box | null = null;
  private currentLabel: string | null = null;
  private focused = false;
  private visible = true;
  private visibleLineBudget: number;
  private labelWidth: number;
  private labelTop: number;
  private labelLeft: number;

  row: number;
  col: number;

  constructor({
    frame,
    box,
    row,
    col,
    maxLines,
    labelParent,
    borderColor,
    focusBorderColor,
    backgroundColor,
    bounds,
  }: {
    frame: Box;
    box: ScrollableBox;
    row: number;
    col: number;
    maxLines: number;
    labelParent: GridParent;
    borderColor: string;
    focusBorderColor: string;
    backgroundColor: string | undefined;
    bounds: GridCellBounds;
  }) {
    this.frame = frame;
    this.box = box;
    this.row = row;
    this.col = col;
    this.maxLines = maxLines;
    this.labelParent = labelParent;
    this.borderColor = borderColor;
    this.focusBorderColor = focusBorderColor;
    this.backgroundColor = backgroundColor;
    this.visibleLineBudget = Math.max(bounds.height - 2, 1);
    this.labelWidth = Math.max(bounds.width - 2, 1);
    this.labelTop = bounds.top;
    this.labelLeft = bounds.left + 1;
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
          fg: this.activeBorderColor(),
          ...(this.backgroundColor ? { bg: this.backgroundColor } : {}),
        },
      });
      if (!this.visible) this.labelBox.hide();
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

  setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    const color = this.activeBorderColor();
    const style = this.frame.style;
    style.fg = color;
    if (style.border) style.border.fg = color;
    if (this.labelBox) this.labelBox.style.fg = color;
  }

  getLineCount(): number {
    return this.lines.length;
  }

  getContentSize(): { width: number; height: number } {
    return {
      width: this.labelWidth,
      height: this.visibleLineBudget,
    };
  }

  /** Move and resize the pane's frame, content box, and label together. */
  setBounds(bounds: GridCellBounds): void {
    this.frame.top = bounds.top;
    this.frame.left = bounds.left;
    this.frame.width = bounds.width;
    this.frame.height = bounds.height;

    this.box.top = bounds.top + 1;
    this.box.left = bounds.left + 1;
    this.box.width = Math.max(bounds.width - 2, 1);
    this.box.height = Math.max(bounds.height - 2, 1);

    this.visibleLineBudget = Math.max(bounds.height - 2, 1);
    this.labelWidth = Math.max(bounds.width - 2, 1);
    this.labelTop = bounds.top;
    this.labelLeft = bounds.left + 1;

    if (this.labelBox) {
      this.labelBox.top = this.labelTop;
      this.labelBox.left = this.labelLeft;
      this.labelBox.width = this.labelWidth;
      if (this.currentLabel !== null) {
        this.labelBox.setContent(this.formatLabelContent(this.currentLabel));
      }
    }
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible) {
      this.frame.show();
      this.box.show();
      this.labelBox?.show();
    } else {
      this.frame.hide();
      this.box.hide();
      this.labelBox?.hide();
    }
  }

  destroy(): void {
    if (this.labelBox) {
      this.labelBox.destroy();
    }
    this.box.destroy();
    this.frame.destroy();
  }

  private activeBorderColor(): string {
    return this.focused ? this.focusBorderColor : this.borderColor;
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
    const content = `─ ${truncatedLabel} `;
    const remaining = Math.max(this.labelWidth - (labelVisualWidth + 3), 0);
    return `${content}${"─".repeat(remaining)}`;
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

    return `${value.slice(0, cutIndex)}…`;
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
