import { describe, expect, it, vi } from "vitest";

// @unblessed/node requires a real TTY for widget construction. Mock Box/Screen
// so we can drive a real createFuzzyList and inspect the content it lays out.
const captured = vi.hoisted(() => ({ content: "" }));
vi.mock("@unblessed/node", () => {
  return {
    Box: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
      this["height"] = 24;
      this["width"] = 80;
      this["setContent"] = vi.fn((value: string) => {
        captured.content = value;
      });
      this["detach"] = vi.fn();
      this["destroy"] = vi.fn();
    }),
    Screen: vi.fn().mockImplementation(function (
      this: Record<string, unknown>,
    ) {
      this["on"] = vi.fn();
      this["removeListener"] = vi.fn();
      this["render"] = vi.fn();
    }),
  };
});

import { Screen } from "@unblessed/node";
import {
  createFuzzyList,
  type FuzzyItem,
  fuzzyFilter,
  windowStart,
} from "./fuzzy-list.ts";

function items(...labels: string[]): FuzzyItem<string>[] {
  return labels.map((label) => ({ value: label, label }));
}

// The index of the first content line containing `needle`, or -1.
function lineContaining(content: string, needle: string): number {
  return content.split("\n").findIndex((line) => line.includes(needle));
}

describe("fuzzyFilter", () => {
  it("returns every item for an empty or whitespace query", () => {
    const all = items("alpha", "beta", "gamma");
    expect(fuzzyFilter(all, "")).toEqual(all);
    expect(fuzzyFilter(all, "   ")).toEqual(all);
  });

  it("returns a distinct copy rather than the original array", () => {
    const all = items("alpha");
    const result = fuzzyFilter(all, "");
    expect(result).not.toBe(all);
    expect(result).toEqual(all);
  });

  it("matches case-insensitively", () => {
    const all = items("Workforest", "Template");
    expect(fuzzyFilter(all, "WORK").map((item) => item.label)).toEqual([
      "Workforest",
    ]);
    expect(fuzzyFilter(all, "tEmP").map((item) => item.label)).toEqual([
      "Template",
    ]);
  });

  it("matches non-contiguous subsequences", () => {
    const all = items("fuzzy-list", "feature-x", "readme");
    // "fl" is a subsequence of "fuzzy-list" but not the others.
    expect(fuzzyFilter(all, "fl").map((item) => item.label)).toEqual([
      "fuzzy-list",
    ]);
  });

  it("requires the characters to appear in order", () => {
    const all = items("abc");
    expect(fuzzyFilter(all, "ac")).toHaveLength(1);
    expect(fuzzyFilter(all, "ca")).toHaveLength(0);
  });

  it("includes the hint in the searchable text", () => {
    const withHint: FuzzyItem<string>[] = [
      { value: "a", label: "alpha", hint: "main branch" },
    ];
    expect(fuzzyFilter(withHint, "branch")).toHaveLength(1);
  });

  it("returns an empty list when nothing matches", () => {
    expect(fuzzyFilter(items("alpha", "beta"), "zzz")).toEqual([]);
  });

  it("preserves the original ordering of matches (stable)", () => {
    const all = items("apple", "banana", "apricot", "avocado");
    expect(fuzzyFilter(all, "a").map((item) => item.label)).toEqual([
      "apple",
      "banana",
      "apricot",
      "avocado",
    ]);
  });
});

describe("windowStart", () => {
  it("stays at zero when everything fits in the viewport", () => {
    expect(windowStart(3, 2, 5, 0)).toBe(0);
  });

  it("does not move when the index is already visible", () => {
    expect(windowStart(20, 4, 5, 3)).toBe(3);
  });

  it("scrolls up so an index above the window becomes the top", () => {
    expect(windowStart(20, 2, 5, 8)).toBe(2);
  });

  it("scrolls down so an index below the window sits at the bottom", () => {
    expect(windowStart(20, 10, 5, 0)).toBe(6);
  });

  it("never scrolls past the final window", () => {
    expect(windowStart(20, 19, 5, 0)).toBe(15);
  });

  it("returns zero for a non-positive viewport", () => {
    expect(windowStart(20, 10, 0, 4)).toBe(0);
  });
});

describe("createFuzzyList layout", () => {
  it("renders the action row inline, immediately after the last candidate", () => {
    const screen = new Screen();
    const list = createFuzzyList<string>({
      screen,
      prompt: "go to a change",
      items: items("alpha", "beta", "gamma"),
      actionRow: { label: (query) => `CREATE_${query}` },
    });
    // run() renders synchronously before its promise settles; never resolves
    // here since we send no keys, so we inspect the captured content directly.
    void list.run();

    const lastCandidate = lineContaining(captured.content, "gamma");
    const action = lineContaining(captured.content, "CREATE_");
    expect(lastCandidate).toBeGreaterThanOrEqual(0);
    expect(action).toBe(lastCandidate + 1);

    list.destroy();
  });

  it("renders the action row directly below the No matches hint when empty", () => {
    const screen = new Screen();
    const list = createFuzzyList<string>({
      screen,
      prompt: "go to a change",
      items: items("alpha", "beta"),
      actionRow: { label: (query) => `CREATE_${query}` },
      initialQuery: "zzz",
    });
    void list.run();

    const hint = lineContaining(captured.content, "No matches");
    const action = lineContaining(captured.content, "CREATE_");
    expect(hint).toBeGreaterThanOrEqual(0);
    expect(action).toBe(hint + 1);

    list.destroy();
  });
});
