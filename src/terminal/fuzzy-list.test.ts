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
import { activeTheme } from "./theme-system.ts";

function items(...labels: string[]): FuzzyItem<string>[] {
  return labels.map((label) => ({ value: label, label }));
}

/** The glyph marking the highlighted row (theme-defined filled radio). */
function activeRadio(): string {
  return activeTheme().symbols.radioOn;
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

  it("highlights the candidate chosen by initialSelected", () => {
    const screen = new Screen();
    const list = createFuzzyList<string>({
      screen,
      prompt: "pick",
      items: items("alpha", "beta", "gamma"),
      initialSelected: (item) => item.value === "gamma",
    });
    void list.run();

    // The highlighted row carries the filled radio glyph; it must sit on gamma.
    const selectedRow = captured.content
      .split("\n")
      .find((line) => line.includes(activeRadio()));
    expect(selectedRow).toContain("gamma");

    list.destroy();
  });
});

describe("createFuzzyList scope switching", () => {
  type KeypressFn = (ch: string | undefined, key: { name?: string }) => void;
  type MockScreen = { on: ReturnType<typeof vi.fn> };

  function keypressHandler(screen: MockScreen): KeypressFn {
    const call = screen.on.mock.calls.find(
      (args: unknown[]) => args[0] === "keypress",
    );
    if (!call) throw new Error("no keypress handler registered");
    return call[1] as KeypressFn;
  }

  it("swaps items, scope label, and footer hint on Tab", () => {
    const screen = new Screen();
    const list = createFuzzyList<string>({
      screen,
      prompt: "go to a change",
      items: items("scoped-one", "scoped-two"),
      scopeLabel: "repo: front",
      tabHint: "all changes",
      onTab: () => ({
        items: items("global-one", "global-two", "global-three"),
        scopeLabel: "all",
        tabHint: "this repo",
      }),
    });
    void list.run();

    expect(captured.content).toContain("scoped-one");
    expect(captured.content).toContain("repo: front");
    expect(captured.content).toContain("all changes");

    keypressHandler(screen as unknown as MockScreen)(undefined, {
      name: "tab",
    });

    expect(captured.content).toContain("global-one");
    expect(captured.content).not.toContain("scoped-one");
    expect(captured.content).toContain("· all");
    expect(captured.content).toContain("this repo");

    list.destroy();
  });

  // The name painted inside the focus-background badge, e.g. "{cyan-bg}{black-fg}
  // front {/black-fg}{/cyan-bg}" → "front". Returns null when no badge is shown.
  function badgedName(row: string): string | null {
    return row.match(/-bg\}\{[^}]+-fg\} (.+?) \{/)?.[1] ?? null;
  }

  it("renders a fixed scope toggle, moving only the highlight badge on Tab", () => {
    const screen = new Screen();
    const list = createFuzzyList<string>({
      screen,
      prompt: "go to a change",
      items: items("scoped-one"),
      scopeToggle: {
        options: [
          { label: "in front", name: "front" },
          { label: "all changes" },
        ],
        active: 0,
      },
      onTab: () => ({ items: items("global-one"), scopeActive: 1 }),
    });
    void list.run();

    // The scope toggle sits directly under the prompt, listing both options in a
    // fixed order with the active one's name as a background badge (no glyph
    // prefix) and an explicit Tab cue — not the muted "· in front" suffix used
    // without scopeToggle.
    const promptRow = lineContaining(captured.content, "go to a change");
    const scopeRow = (): string =>
      captured.content.split("\n")[promptRow + 1] ?? "";

    const before = scopeRow();
    expect(before.indexOf("front")).toBeLessThan(before.indexOf("all changes"));
    expect(before).toContain("switches scope");
    expect(before).not.toContain("▌");
    expect(captured.content).not.toContain("· in front");
    expect(badgedName(before)).toBe("front");

    keypressHandler(screen as unknown as MockScreen)(undefined, {
      name: "tab",
    });

    // Positions are unchanged — "front" still precedes "all changes" — but the
    // highlight badge has moved to the second option.
    const after = scopeRow();
    expect(after.indexOf("front")).toBeLessThan(after.indexOf("all changes"));
    expect(badgedName(after)).toBe("all changes");
    expect(captured.content).toContain("global-one");

    list.destroy();
  });

  it("ignores Tab when no onTab handler is provided", () => {
    const screen = new Screen();
    const list = createFuzzyList<string>({
      screen,
      prompt: "pick",
      items: items("alpha", "beta"),
    });
    void list.run();
    const before = captured.content;

    keypressHandler(screen as unknown as MockScreen)(undefined, {
      name: "tab",
    });
    expect(captured.content).toBe(before);

    list.destroy();
  });
});
