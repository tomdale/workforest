#!/usr/bin/env node
import { Box, Screen } from "@unblessed/node";

/**
 * Demo of collapsed/shared borders using manual frame rendering
 * Run with: pnpm tsx src/ui/collapsed-boxes.ts
 */

const screen = new Screen({
  smartCSR: true,
  title: "Collapsed Boxes",
  fullUnicode: true,
});

screen.key(["escape", "q", "C-c"], () => {
  screen.destroy();
  process.exit(0);
});

const MARGIN = 1;
const cols = 2;
const rows = 2;

// Get actual dimensions
const totalWidth = (screen.width as number) - MARGIN * 2;
const totalHeight = (screen.height as number) - MARGIN * 2;
const cellWidth = Math.floor(totalWidth / cols);
const cellHeight = Math.floor(totalHeight / rows);

// Build the entire frame as a string
function buildFrame(): string {
  const lines: string[] = [];

  for (let y = 0; y < totalHeight; y++) {
    let line = "";
    for (let x = 0; x < totalWidth; x++) {
      const isTop = y === 0;
      const isBottom = y === totalHeight - 1;
      const isLeft = x === 0;
      const isRight = x === totalWidth - 1;
      const isHDiv = y > 0 && y < totalHeight - 1 && y % cellHeight === 0;
      const isVDiv = x > 0 && x < totalWidth - 1 && x % cellWidth === 0;

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

// Frame container (just renders the grid lines)
const frame = new Box({
  top: MARGIN,
  left: MARGIN,
  width: totalWidth + 1,
  height: totalHeight,
  content: buildFrame(),
  style: { fg: "yellow" },
});
screen.append(frame);

// Create content panes (no borders, positioned inside cells)
for (let i = 0; i < cols * rows; i++) {
  const row = Math.floor(i / cols);
  const col = i % cols;

  const pane = new Box({
    top: MARGIN + row * cellHeight + 1,
    left: MARGIN + col * cellWidth + 1,
    width: cellWidth - 1,
    height: cellHeight - 1,
    tags: true,
    content: `{bold}Pane ${i + 1}{/bold}\n\nSample content\ninside the box`,
  });
  screen.append(pane);
}

screen.render();
