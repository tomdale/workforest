import { Box, type Screen, ScrollableBox } from "@unblessed/node";
import { type BorderRect, composeBorderCanvas } from "./border-canvas.ts";

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
  /** Default and focused fg for pane content text. Omit to leave content fg untouched (legacy callers). */
  contentColor?: string;
  focusContentColor?: string;
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

type LabelBounds = { top: number; left: number; width: number };

/**
 * A grid layout of panes sharing one border canvas, tmux style: neighboring
 * panes draw a single gridline instead of each framing itself, so adjoining
 * borders merge into proper junctions instead of doubling up. Cell bounds are
 * recomputed on {@link reflow} so terminal resizes reshape every pane, and
 * panes can be hidden or zoomed (one pane taking the whole frame) for paging
 * and focus.
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
  private contentColor: string | undefined;
  private focusContentColor: string | undefined;
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

  // Gridline positions, canvas-relative: gx has cols+1 entries, gy has rows+1.
  // Neighboring cells share the gridline at their common index, which is what
  // lets the canvas draw one line instead of two.
  private gx: number[] = [];
  private gy: number[] = [];

  // The shared border layer. Created before any pane's content/label boxes
  // so those paint above it; every gridline, corner, and junction lives here
  // instead of in per-pane borders.
  private canvasBox: Box;

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
    this.contentColor = options.contentColor;
    this.focusContentColor = options.focusContentColor;
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
    this.computeGridlines();

    this.canvasBox = new Box({
      parent: this.parent,
      top: this.frameTop,
      left: this.frameLeft,
      width: this.frameWidth,
      height: this.frameHeight,
      tags: true,
      wrap: false,
      style: {
        fg: this.borderColor,
        ...(this.backgroundColor ? { bg: this.backgroundColor } : {}),
      },
    });

    this.createPanes();
    this.recomposeCanvas();
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

  /**
   * Gridlines split the frame into `cols`/`rows` even-ish spans, rounding
   * independently at each line so neighboring cells always meet exactly
   * (no gaps or overlaps from compounding rounding error).
   */
  private computeGridlines(): void {
    this.gx = GridLayout.divisions(this.cols, this.frameWidth);
    this.gy = GridLayout.divisions(this.rows, this.frameHeight);
  }

  private static divisions(count: number, span: number): number[] {
    const lines: number[] = [];
    for (let i = 0; i <= count; i++) {
      lines.push(Math.round((i * (span - 1)) / count));
    }
    return lines;
  }

  /** Canvas-relative border rect for a grid cell, edges shared with neighbors. */
  private borderRectFor(row: number, col: number): BorderRect {
    const left = this.gx[col] ?? 0;
    const right = this.gx[col + 1] ?? left;
    const top = this.gy[row] ?? 0;
    const bottom = this.gy[row + 1] ?? top;
    return { top, left, width: right - left + 1, height: bottom - top + 1 };
  }

  /**
   * A border rect always encloses its content one cell in from each edge, so
   * the parent-relative content and label placement follow directly from the
   * rect: this is the one place that arithmetic lives, for both grid cells
   * and the full-frame zoom rect.
   */
  private paneBoundsFrom(rect: BorderRect): {
    content: GridCellBounds;
    label: LabelBounds;
  } {
    const content: GridCellBounds = {
      top: this.frameTop + rect.top + 1,
      left: this.frameLeft + rect.left + 1,
      width: Math.max(rect.width - 2, 1),
      height: Math.max(rect.height - 2, 1),
    };
    const label: LabelBounds = {
      top: this.frameTop + rect.top,
      left: this.frameLeft + rect.left + 1,
      width: content.width,
    };
    return { content, label };
  }

  private zoomBorderRect(): BorderRect {
    return {
      top: 0,
      left: 0,
      width: this.frameWidth,
      height: this.frameHeight,
    };
  }

  private createPanes(): void {
    for (let i = 0; i < this.rows * this.cols; i++) {
      const row = Math.floor(i / this.cols);
      const col = i % this.cols;
      const { content, label } = this.paneBoundsFrom(
        this.borderRectFor(row, col),
      );

      const box = new ScrollableBox({
        parent: this.parent,
        top: content.top,
        left: content.left,
        width: content.width,
        height: content.height,
        tags: true,
        keys: true,
        vi: true,
        mouse: true,
        alwaysScroll: true,
        style: {
          ...(this.contentColor ? { fg: this.contentColor } : {}),
          ...(this.backgroundColor ? { bg: this.backgroundColor } : {}),
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
        box,
        row,
        col,
        maxLines: this.maxLinesPerPane,
        labelParent: this.parent,
        borderColor: this.borderColor,
        focusBorderColor: this.focusBorderColor,
        backgroundColor: this.backgroundColor,
        contentColor: this.contentColor,
        focusContentColor: this.focusContentColor,
        onFocusChange: () => this.recomposeCanvas(),
        content,
        label,
      });

      this.panes.push(pane);
    }
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
    this.computeGridlines();

    this.canvasBox.top = this.frameTop;
    this.canvasBox.left = this.frameLeft;
    this.canvasBox.width = this.frameWidth;
    this.canvasBox.height = this.frameHeight;

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
    if (pane && this.zoomedIndex === null) {
      const { content, label } = this.paneBoundsFrom(
        this.borderRectFor(pane.row, pane.col),
      );
      pane.setBounds(content, label);
      pane.setVisible(true);
    }
    this.recomposeCanvas();
  }

  /** Hide a pane (paging past it, or unused grid slots). */
  hidePane(index: number): void {
    this.hiddenPanes.add(index);
    if (this.zoomedIndex === null) {
      this.panes[index]?.setVisible(false);
    }
    this.recomposeCanvas();
  }

  private applyLayout(): void {
    this.panes.forEach((pane, index) => {
      if (this.zoomedIndex !== null) {
        if (index === this.zoomedIndex) {
          const { content, label } = this.paneBoundsFrom(this.zoomBorderRect());
          pane.setBounds(content, label);
          pane.setVisible(true);
        } else {
          pane.setVisible(false);
        }
        return;
      }

      const { content, label } = this.paneBoundsFrom(
        this.borderRectFor(pane.row, pane.col),
      );
      pane.setBounds(content, label);
      pane.setVisible(!this.hiddenPanes.has(index));
    });
    this.recomposeCanvas();
  }

  /**
   * Rebuild the shared border layer from whichever rects are currently
   * showing: one full-frame rect while zoomed, otherwise one rect per
   * non-hidden pane. composeBorderCanvas merges shared edges into junctions
   * and colors a focused pane's outline, so this is the only place that
   * needs to know which panes are focused or visible.
   */
  private recomposeCanvas(): void {
    let rects: { rect: BorderRect; focused: boolean }[];
    if (this.zoomedIndex !== null) {
      const zoomed = this.panes[this.zoomedIndex];
      rects = zoomed
        ? [{ rect: this.zoomBorderRect(), focused: zoomed.isFocused() }]
        : [];
    } else {
      rects = this.panes
        .filter((_pane, index) => !this.hiddenPanes.has(index))
        .map((pane) => ({
          rect: this.borderRectFor(pane.row, pane.col),
          focused: pane.isFocused(),
        }));
    }

    this.canvasBox.setContent(
      composeBorderCanvas({
        width: this.frameWidth,
        height: this.frameHeight,
        rects,
        baseColor: this.borderColor,
        focusColor: this.focusBorderColor,
      }).join("\n"),
    );
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
    this.canvasBox.destroy();
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
  private labelParent: GridParent;
  private borderColor: string;
  private focusBorderColor: string;
  private backgroundColor: string | undefined;
  private contentColor: string | undefined;
  private focusContentColor: string | undefined;
  private onFocusChange: () => void;
  private labelBox: Box | null = null;
  private currentLabel: string | null = null;
  private focused = false;
  private visible = true;
  private visibleLineBudget: number;
  // Content and label width always match (the label overlays the pane's top
  // gridline), so one field serves both.
  private contentWidth: number;
  private labelTop: number;
  private labelLeft: number;

  row: number;
  col: number;

  constructor({
    box,
    row,
    col,
    maxLines,
    labelParent,
    borderColor,
    focusBorderColor,
    backgroundColor,
    contentColor,
    focusContentColor,
    onFocusChange,
    content,
    label,
  }: {
    box: ScrollableBox;
    row: number;
    col: number;
    maxLines: number;
    labelParent: GridParent;
    borderColor: string;
    focusBorderColor: string;
    backgroundColor: string | undefined;
    contentColor: string | undefined;
    focusContentColor: string | undefined;
    onFocusChange: () => void;
    content: GridCellBounds;
    label: LabelBounds;
  }) {
    this.box = box;
    this.row = row;
    this.col = col;
    this.maxLines = maxLines;
    this.labelParent = labelParent;
    this.borderColor = borderColor;
    this.focusBorderColor = focusBorderColor;
    this.backgroundColor = backgroundColor;
    this.contentColor = contentColor;
    this.focusContentColor = focusContentColor;
    this.onFocusChange = onFocusChange;
    this.visibleLineBudget = content.height;
    this.contentWidth = content.width;
    this.labelTop = label.top;
    this.labelLeft = label.left;
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
        width: this.contentWidth,
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
    if (this.labelBox) this.labelBox.style.fg = this.activeBorderColor();
    // Only touch content fg when the caller opted in: legacy callers that
    // omit both colors must see zero content-color change on focus.
    const resolvedFg = focused
      ? (this.focusContentColor ?? this.contentColor)
      : (this.contentColor ?? this.focusContentColor);
    if (resolvedFg !== undefined) {
      this.box.style.fg = resolvedFg;
    }
    // The border canvas colors a focused pane's outline, so a focus change
    // has to trigger a recompose even though this pane owns no border itself.
    this.onFocusChange();
  }

  isFocused(): boolean {
    return this.focused;
  }

  getLineCount(): number {
    return this.lines.length;
  }

  getContentSize(): { width: number; height: number } {
    return {
      width: this.contentWidth,
      height: this.visibleLineBudget,
    };
  }

  /** Move and resize the pane's content box and label together. */
  setBounds(content: GridCellBounds, label: LabelBounds): void {
    this.box.top = content.top;
    this.box.left = content.left;
    this.box.width = content.width;
    this.box.height = content.height;

    this.visibleLineBudget = content.height;
    this.contentWidth = content.width;
    this.labelTop = label.top;
    this.labelLeft = label.left;

    if (this.labelBox) {
      this.labelBox.top = this.labelTop;
      this.labelBox.left = this.labelLeft;
      this.labelBox.width = this.contentWidth;
      if (this.currentLabel !== null) {
        this.labelBox.setContent(this.formatLabelContent(this.currentLabel));
      }
    }
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible) {
      this.box.show();
      this.labelBox?.show();
    } else {
      this.box.hide();
      this.labelBox?.hide();
    }
  }

  destroy(): void {
    if (this.labelBox) {
      this.labelBox.destroy();
    }
    this.box.destroy();
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
    const maxLabelWidth = Math.max(this.contentWidth - 4, 1);
    const truncatedLabel = this.truncateToVisualWidth(label, maxLabelWidth);
    const labelVisualWidth = this.getVisualLength(truncatedLabel);
    const content = `─ ${truncatedLabel} `;
    const remaining = Math.max(this.contentWidth - (labelVisualWidth + 3), 0);
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
