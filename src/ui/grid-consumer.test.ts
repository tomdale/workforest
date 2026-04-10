import { afterEach, describe, expect, it } from "vitest";
import { sanitizeTerminalOutput, shouldUseGrid } from "./grid-consumer.ts";
import { calculateGridDimensions } from "./grid-layout.ts";

const stdoutDescriptors = {
  isTTY: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
  columns: Object.getOwnPropertyDescriptor(process.stdout, "columns"),
  rows: Object.getOwnPropertyDescriptor(process.stdout, "rows"),
};

const originalCI = process.env.CI;
const originalNoTui = process.env.WORKFOREST_NO_TUI;

function setStdoutValue(
  key: "isTTY" | "columns" | "rows",
  value: boolean | number,
): void {
  Object.defineProperty(process.stdout, key, {
    configurable: true,
    value,
  });
}

afterEach(() => {
  restoreStdoutValue("isTTY", stdoutDescriptors.isTTY);
  restoreStdoutValue("columns", stdoutDescriptors.columns);
  restoreStdoutValue("rows", stdoutDescriptors.rows);

  restoreEnv("CI", originalCI);
  restoreEnv("WORKFOREST_NO_TUI", originalNoTui);
});

function restoreStdoutValue(
  key: "isTTY" | "columns" | "rows",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(process.stdout, key, descriptor);
  }
}

function restoreEnv(key: "CI" | "WORKFOREST_NO_TUI", value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

describe("calculateGridDimensions", () => {
  it.each([
    [1, { rows: 1, cols: 1 }],
    [2, { rows: 1, cols: 2 }],
    [3, { rows: 2, cols: 2 }],
    [5, { rows: 2, cols: 3 }],
    [9, { rows: 3, cols: 3 }],
    [10, { rows: 3, cols: 4 }],
    [12, { rows: 3, cols: 4 }],
  ])("returns an adaptive layout for %i repos", (count, expected) => {
    expect(calculateGridDimensions(count)).toEqual(expected);
  });
});

describe("shouldUseGrid", () => {
  it("requires a TTY", () => {
    setStdoutValue("isTTY", false);
    setStdoutValue("columns", 120);
    setStdoutValue("rows", 40);

    expect(shouldUseGrid(1)).toBe(false);
  });

  it("disables the grid in CI or when explicitly opted out", () => {
    setStdoutValue("isTTY", true);
    setStdoutValue("columns", 120);
    setStdoutValue("rows", 40);
    process.env.CI = "1";

    expect(shouldUseGrid(1)).toBe(false);

    delete process.env.CI;
    process.env.WORKFOREST_NO_TUI = "1";
    expect(shouldUseGrid(1)).toBe(false);
  });

  it("uses repo-count-aware minimum terminal sizes", () => {
    setStdoutValue("isTTY", true);
    setStdoutValue("columns", 60);
    setStdoutValue("rows", 16);

    expect(shouldUseGrid(1)).toBe(true);
    expect(shouldUseGrid(6)).toBe(false);
  });

  it("accepts terminals that are large enough for the computed grid", () => {
    setStdoutValue("isTTY", true);
    setStdoutValue("columns", 113);
    setStdoutValue("rows", 26);

    expect(shouldUseGrid(10)).toBe(true);
  });
});

describe("sanitizeTerminalOutput", () => {
  it("strips ANSI control sequences", () => {
    expect(sanitizeTerminalOutput("\u001b[31mhello\u001b[0m")).toBe("hello");
  });

  it("keeps the final carriage-return update for each line", () => {
    expect(
      sanitizeTerminalOutput("Downloading 1%\rDownloading 50%\rDownloading 100%\nDone\n"),
    ).toBe("Downloading 100%\nDone\n");
  });
});
