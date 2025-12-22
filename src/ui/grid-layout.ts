import { Box, Screen, ScrollableBox } from "@unblessed/node";

export interface GridLayoutOptions {
  screen: Screen;
  top: number | string;
  left: number | string;
  width: number | string;
  height: number | string;
  rows: number;
  cols: number;
  borderColor?: string;
}

export interface GridPane {
  box: ScrollableBox;
  row: number;
  col: number;
  setContent(content: string): void;
  appendContent(content: string): void;
  getContent(): string;
  setLabel(label: string): void;
}

/**
 * A grid layout with collapsed/shared borders.
 * Renders a single frame with proper box-drawing connectors (┌┬┐├┼┤└┴┘)
 * and positions content panes inside each cell.
 */
export class GridLayout {
  private screen: Screen;
  private frame: Box;
  private panes: GridPane[] = [];
  private rows: number;
  private cols: number;
  private borderColor: string;

  // Actual computed dimensions
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

    // Resolve percentage-based dimensions to actual values
    const screenWidth = this.screen.width as number;
    const screenHeight = this.screen.height as number;

    this.frameTop = this.resolvePosition(options.top, screenHeight);
    this.frameLeft = this.resolvePosition(options.left, screenWidth);
    // Subtract 1 from width/height to ensure borders fit on screen
    this.frameWidth = this.resolveSize(options.width, screenWidth) - 1;
    this.frameHeight = this.resolveSize(options.height, screenHeight) - 1;

    this.cellWidth = Math.floor(this.frameWidth / this.cols);
    this.cellHeight = Math.floor(this.frameHeight / this.rows);

    this.frame = this.createFrame();
    this.screen.append(this.frame);

    this.createPanes();
  }

  private resolvePosition(value: number | string, total: number): number {
    if (typeof value === "number") return value;
    if (value.endsWith("%")) {
      return Math.floor((parseFloat(value) / 100) * total);
    }
    return parseInt(value, 10);
  }

  private resolveSize(value: number | string, total: number): number {
    if (typeof value === "number") return value;
    if (value.includes("%")) {
      // Handle "100%-4" style expressions
      const match = value.match(/^(\d+)%(?:([+-])(\d+))?$/);
      if (match && match[1]) {
        const pct = parseFloat(match[1]);
        const base = Math.floor((pct / 100) * total);
        if (match[2] && match[3]) {
          const offset = parseInt(match[3], 10);
          return match[2] === "+" ? base + offset : base - offset;
        }
        return base;
      }
    }
    return parseInt(value, 10);
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

        if (isTop && isLeft) line += "┌";
        else if (isTop && isRight) line += "┐";
        else if (isBottom && isLeft) line += "└";
        else if (isBottom && isRight) line += "┘";
        else if (isTop && isVDiv) line += "┬";
        else if (isBottom && isVDiv) line += "┴";
        else if (isLeft && isHDiv) line += "├";
        else if (isRight && isHDiv) line += "┤";
        else if (isHDiv && isVDiv) line += "┼";
        else if (isTop || isBottom || isHDiv) line += "─";
        else if (isLeft || isRight || isVDiv) line += "│";
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

      const pane: GridPane = {
        box,
        row,
        col,
        setContent: (content: string) => {
          box.setContent(content);
        },
        appendContent: (content: string) => {
          const current = box.getContent();
          box.setContent(current + content);
          box.setScrollPerc?.(100);
        },
        getContent: () => box.getContent(),
        setLabel: (label: string) => {
          // Draw label on the top border of this cell
          this.drawLabel(row, col, label);
        },
      };

      this.panes.push(pane);
    }
  }

  private getVisualLength(str: string): number {
    // Remove blessed tags like {red-fg}, {/}, {bold}, etc.
    return str.replace(/\{[^}]*\}/g, "").length;
  }

  private drawLabel(row: number, col: number, label: string): void {
    // Calculate position for the label (on the top border of the cell)
    const labelTop = this.frameTop + row * this.cellHeight;
    const labelLeft = this.frameLeft + col * this.cellWidth + 1; // +1 for after the border char
    // Calculate max visual width (excluding markup tags)
    const maxVisualWidth = this.cellWidth - 4; // Account for border chars and space padding

    // Truncate based on visual length, not string length
    let truncatedLabel = label;
    const labelVisualLength = this.getVisualLength(label);
    if (labelVisualLength > maxVisualWidth) {
      // Need to truncate - find where to cut by tracking visual length
      let visualLen = 0;
      let cutIndex = 0;
      let inTag = false;
      for (let i = 0; i < label.length; i++) {
        if (label[i] === "{") inTag = true;
        else if (label[i] === "}") inTag = false;
        else if (!inTag) {
          visualLen++;
          if (visualLen >= maxVisualWidth - 1) {
            cutIndex = i + 1;
            break;
          }
        }
      }
      truncatedLabel = label.slice(0, cutIndex) + "…";
    }

    // Create label box with border chars as padding (preserves the border line)
    // and 1 space before the title text for readability
    const content = `─ ${truncatedLabel}─`;
    // Use visual length for box width (tags don't take up space)
    const visualWidth = this.getVisualLength(content);
    const labelBox = new Box({
      top: labelTop,
      left: labelLeft,
      width: visualWidth,
      height: 1,
      content,
      tags: true,
    });

    this.screen.append(labelBox);
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
      pane.box.destroy();
    }
  }
}
