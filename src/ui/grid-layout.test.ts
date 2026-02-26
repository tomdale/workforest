import { describe, expect, it } from "vitest";
import { calculateGridDimensions } from "./grid-layout.ts";

describe("calculateGridDimensions", () => {
  it("0 repos → 1×1 grid", () => {
    expect(calculateGridDimensions(0)).toEqual({ rows: 1, cols: 1 });
  });

  it("1 repo → 1×1 grid", () => {
    expect(calculateGridDimensions(1)).toEqual({ rows: 1, cols: 1 });
  });

  it("2 repos → 1×2 grid", () => {
    expect(calculateGridDimensions(2)).toEqual({ rows: 1, cols: 2 });
  });

  it("3 repos → 2×2 grid", () => {
    expect(calculateGridDimensions(3)).toEqual({ rows: 2, cols: 2 });
  });

  it("4 repos → 2×2 grid", () => {
    expect(calculateGridDimensions(4)).toEqual({ rows: 2, cols: 2 });
  });

  it("5 repos → 2×3 grid", () => {
    expect(calculateGridDimensions(5)).toEqual({ rows: 2, cols: 3 });
  });

  it("6 repos → 2×3 grid", () => {
    expect(calculateGridDimensions(6)).toEqual({ rows: 2, cols: 3 });
  });

  it("7 repos → 3×3 grid", () => {
    expect(calculateGridDimensions(7)).toEqual({ rows: 3, cols: 3 });
  });

  it("9 repos → 3×3 grid", () => {
    expect(calculateGridDimensions(9)).toEqual({ rows: 3, cols: 3 });
  });
});
