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
  fitMetaList,
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
  it.each([
    {
      label: "empty query",
      all: items("alpha", "beta", "gamma"),
      query: "",
      expected: ["alpha", "beta", "gamma"],
    },
    {
      label: "whitespace query",
      all: items("alpha", "beta", "gamma"),
      query: "   ",
      expected: ["alpha", "beta", "gamma"],
    },
    {
      label: "case-insensitive label match",
      all: items("Workforest", "Template"),
      query: "WORK",
      expected: ["Workforest"],
    },
    {
      label: "non-contiguous subsequence",
      all: items("fuzzy-list", "feature-x", "readme"),
      query: "fl",
      expected: ["fuzzy-list"],
    },
    {
      label: "ordered characters",
      all: items("abc"),
      query: "ca",
      expected: [],
    },
    {
      label: "hint match",
      all: [{ value: "a", label: "alpha", hint: "main branch" }],
      query: "branch",
      expected: ["alpha"],
    },
    {
      label: "no match",
      all: items("alpha", "beta"),
      query: "zzz",
      expected: [],
    },
    {
      label: "stable ordering",
      all: items("apple", "banana", "apricot", "avocado"),
      query: "a",
      expected: ["apple", "banana", "apricot", "avocado"],
    },
  ])("filters by $label", ({ all, query, expected }) => {
    expect(fuzzyFilter(all, query).map((item) => item.label)).toEqual(expected);
  });
});

describe("fitMetaList", () => {
  it("returns the list unchanged when it fits the budget", () => {
    expect(fitMetaList("api, front, vercel", 40)).toBe("api, front, vercel");
    expect(fitMetaList("@web (api, front)", 40)).toBe("@web (api, front)");
  });

  it("summarizes a bare list overflow as '+ N more'", () => {
    // "api, front, vercel, web, docs" is 29 cols; a 20-col budget fits the first
    // two entries plus the ", + 3 more" tail (also 20 cols).
    expect(fitMetaList("api, front, vercel, web, docs", 20)).toBe(
      "api, front, + 3 more",
    );
  });

  it("summarizes a template list overflow inside the parens", () => {
    expect(fitMetaList("@vercel-agent (api, front, vercel, web)", 30)).toBe(
      "@vercel-agent (api, + 3 more)",
    );
  });

  it("preserves a trailing flag like stale", () => {
    const fitted = fitMetaList("api, front, vercel, web · stale", 24);
    expect(fitted.endsWith(" · stale")).toBe(true);
    expect(fitted).toContain("more");
  });

  it("returns empty string for a non-positive budget", () => {
    expect(fitMetaList("api, front", 0)).toBe("");
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
      items: items("alpha", "beta", "gamma"),
      actionRow: { label: (query) => `CREATE_${query}` },
      // The action row only appears once the query has a character; "a" keeps
      // all three candidates (subsequence match) and reveals the row below them.
      initialQuery: "a",
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

  it("hides the action row until the query has a non-whitespace character", () => {
    // Empty query: candidates show, but there is no action row to select yet.
    const empty = createFuzzyList<string>({
      screen: new Screen(),
      items: items("alpha", "beta"),
      actionRow: { label: (query) => `CREATE_${query}` },
    });
    void empty.run();
    expect(captured.content).toContain("alpha");
    expect(captured.content).not.toContain("CREATE_");
    empty.destroy();

    // A typed character reveals it.
    const typed = createFuzzyList<string>({
      screen: new Screen(),
      items: items("alpha", "beta"),
      actionRow: { label: (query) => `CREATE_${query}` },
      initialQuery: "a",
    });
    void typed.run();
    expect(captured.content).toContain("CREATE_a");
    typed.destroy();
  });

  it("renders the action row directly below the No matches hint when empty", () => {
    const screen = new Screen();
    const list = createFuzzyList<string>({
      screen,
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

  it("omits the No matches hint when there are no items to match (create-only)", () => {
    const screen = new Screen();
    const list = createFuzzyList<string>({
      screen,
      items: items(),
      actionRow: { label: (query) => `CREATE_${query}` },
      initialQuery: "x",
    });
    void list.run();

    // A create-only list is a name prompt, not a search — "No matches" would be
    // misleading, and the action row is the sole entry once a name is typed.
    expect(captured.content).not.toContain("No matches");
    expect(lineContaining(captured.content, "CREATE_")).toBeGreaterThanOrEqual(
      0,
    );

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

    // The highlighted row carries the bold ruled selection treatment.
    const selectedRow = captured.content
      .split("\n")
      .find((line) => line.includes("gamma") && line.includes("{bold}"));
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

  it("swaps items and scope label on Tab", () => {
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

    keypressHandler(screen as unknown as MockScreen)(undefined, {
      name: "tab",
    });

    expect(captured.content).toContain("global-one");
    expect(captured.content).not.toContain("scoped-one");
    expect(captured.content).toContain("· all");

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

    // The scope toggle sits below the boxed input and above the list, listing
    // both options in a fixed order while the active badge moves between them.
    const scopeRow = (): string =>
      captured.content.split("\n")[
        lineContaining(captured.content, "all changes")
      ] ?? "";

    const before = scopeRow();
    expect(before.indexOf("front")).toBeLessThan(before.indexOf("all changes"));
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
