#!/usr/bin/env node
import { Box, Screen, type TBorder } from "@unblessed/node";

/**
 * Demo of different box border styles
 * Run with: pnpm tsx src/ui/box-styles.ts
 */

const screen = new Screen({
  smartCSR: true,
  title: "Box Styles",
  fullUnicode: true,
});

screen.key(["escape", "q", "C-c"], () => {
  screen.destroy();
  process.exit(0);
});

type BoxStyle = {
  name: string;
  border: TBorder;
  style: Record<string, unknown>;
};

const styles: BoxStyle[] = [
  {
    name: "1. Line (default)",
    border: { type: "line" },
    style: { border: { fg: "white" } },
  },
  {
    name: "2. Top only",
    border: { type: "line", left: false, right: false, bottom: false },
    style: { border: { fg: "white" } },
  },
  {
    name: "3. Top+Bottom",
    border: { type: "line", left: false, right: false },
    style: { border: { fg: "white" } },
  },
  {
    name: "4. Left+Right",
    border: { type: "line", top: false, bottom: false },
    style: { border: { fg: "white" } },
  },
  { name: "5. No border", border: false, style: { bg: "black" } },
  {
    name: "6. BG border",
    border: { type: "bg" },
    style: { border: { bg: "blue" } },
  },
  {
    name: "7. Cyan border",
    border: { type: "line" },
    style: { border: { fg: "cyan" } },
  },
  {
    name: "8. Yellow border",
    border: { type: "line" },
    style: { border: { fg: "yellow" } },
  },
  {
    name: "9. Dim gray",
    border: { type: "line" },
    style: { border: { fg: "gray" } },
  },
  {
    name: "10. Bold+color",
    border: { type: "line" },
    style: { border: { fg: "green", bold: true } },
  },
];

const cols = 2;
const rows = Math.ceil(styles.length / cols);
const boxWidth = Math.floor(100 / cols);
const boxHeight = Math.floor(100 / rows);

for (const [i, s] of styles.entries()) {
  const row = Math.floor(i / cols);
  const col = i % cols;

  const box = new Box({
    top: `${row * boxHeight}%`,
    left: `${col * boxWidth}%`,
    width: `${boxWidth}%`,
    height: `${boxHeight}%`,
    border: s.border,
    style: s.style ?? { border: { fg: "yellow" } },
    tags: true,
    label: ` {bold}${s.name}{/bold} `,
    content: `\n  Sample content\n  inside the box`,
  });

  screen.append(box);
}

screen.render();
