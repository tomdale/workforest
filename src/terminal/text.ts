import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";

export function visibleWidth(value: string): number {
  return stringWidth(stripAnsi(value));
}

export function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(value) <= width) return value;
  if (width === 1) return "…";
  return `${sliceAnsi(value, 0, width - 1)}…`;
}

export function padRight(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

export function wrap(value: string, width: number): string[] {
  if (width <= 0) return [""];
  const lines: string[] = [];
  for (const sourceLine of value.split("\n")) {
    if (sourceLine === "") {
      lines.push("");
      continue;
    }

    let remaining = sourceLine;
    while (visibleWidth(remaining) > width) {
      const next = sliceAnsi(remaining, 0, width);
      lines.push(next);
      remaining = sliceAnsi(remaining, width);
    }
    lines.push(remaining);
  }
  return lines;
}
