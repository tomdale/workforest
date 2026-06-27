import { describe, expect, it } from "vitest";
import { calculateGridDimensions } from "./grid-layout.ts";

describe("calculateGridDimensions", () => {
  it.each([
    [0, { rows: 1, cols: 1 }],
    [1, { rows: 1, cols: 1 }],
    [2, { rows: 1, cols: 2 }],
    [3, { rows: 2, cols: 2 }],
    [4, { rows: 2, cols: 2 }],
    [5, { rows: 2, cols: 3 }],
    [6, { rows: 2, cols: 3 }],
    [7, { rows: 3, cols: 3 }],
    [9, { rows: 3, cols: 3 }],
  ])("maps %i repos to grid dimensions", (repoCount, dimensions) => {
    expect(calculateGridDimensions(repoCount)).toEqual(dimensions);
  });
});
