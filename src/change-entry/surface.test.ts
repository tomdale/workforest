import { describe, expect, it, vi } from "vitest";
import type { FuzzyResult } from "../terminal/fuzzy-list.ts";

const fuzzyResults = vi.hoisted(() => [] as FuzzyResult<unknown>[]);
const createFuzzyListMock = vi.hoisted(() =>
  vi.fn(() => ({
    run: vi.fn(async () => {
      const result = fuzzyResults.shift();
      if (!result) throw new Error("Missing fuzzy result");
      return result;
    }),
    destroy: vi.fn(),
  })),
);
const screenDestroyMock = vi.hoisted(() => vi.fn());

vi.mock("@unblessed/node", () => ({
  Box: class {
    setContent(): void {}
    destroy(): void {}
  },
}));

vi.mock("../terminal/fullscreen-surface.ts", () => ({
  createFullscreenScreen: () => ({
    destroy: screenDestroyMock,
    render: vi.fn(),
  }),
}));

vi.mock("../terminal/fuzzy-list.ts", () => ({
  createFuzzyList: createFuzzyListMock,
}));

vi.mock("./sources-data.ts", async () => {
  const actual =
    await vi.importActual<typeof import("./sources-data.ts")>(
      "./sources-data.ts",
    );

  return {
    ...actual,
    listSourceCandidates: vi.fn(async () => [
      {
        kind: "repo",
        id: "tomdale/workforest",
        label: "tomdale/workforest",
        hint: "Cached repository",
      },
    ]),
  };
});

import { runChangeEntry } from "./surface.ts";

describe("runChangeEntry", () => {
  it("preselects an explicit target while showing the target picker", async () => {
    const commitChange = vi.fn(async () => {});
    fuzzyResults.push(
      { kind: "action", query: "cloud-fix" },
      { kind: "item", value: { kind: "repo", id: "tomdale/workforest" } },
      { kind: "item", value: "cloud" },
    );

    await runChangeEntry("create", {
      initialTarget: "cloud",
      commitChange,
    });

    expect(createFuzzyListMock).toHaveBeenCalledTimes(3);
    const targetOptions = (
      createFuzzyListMock.mock.calls as unknown as Array<
        [
          {
            initialSelected?: (item: {
              value: string;
              label: string;
            }) => boolean;
          },
        ]
      >
    )[2]?.[0];
    expect(
      targetOptions?.initialSelected?.({ value: "cloud", label: "Cloud" }),
    ).toBe(true);
    expect(
      targetOptions?.initialSelected?.({ value: "local", label: "Local" }),
    ).toBe(false);
    expect(commitChange).toHaveBeenCalledWith({
      changeName: "cloud-fix",
      sources: [{ kind: "repo", token: "tomdale/workforest" }],
      target: "cloud",
    });
  });
});
