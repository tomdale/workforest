import { describe, expect, it, vi } from "vitest";
import type { FuzzyListOptions, FuzzyResult } from "../terminal/fuzzy-list.ts";

type ScriptedFuzzyResult =
  | FuzzyResult<unknown>
  | { kind: "tab"; times?: number };

const fuzzyResults = vi.hoisted(() => [] as ScriptedFuzzyResult[]);
const createFuzzyListMock = vi.hoisted(() =>
  vi.fn(
    (options: { onTab?: (direction: "forward" | "backward") => unknown }) => ({
      run: vi.fn(async () => {
        let result = fuzzyResults.shift();
        while (result?.kind === "tab") {
          const times = result.times ?? 1;
          for (let i = 0; i < times; i += 1) options.onTab?.("forward");
          result = fuzzyResults.shift();
        }
        if (!result) throw new Error("Missing fuzzy result");
        return result;
      }),
      destroy: vi.fn(),
    }),
  ),
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
  createFullscreenStage: () => ({ destroy: vi.fn() }),
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
      {
        kind: "repo",
        id: "tomdale/cli",
        label: "tomdale/cli",
        hint: "Cached repository",
      },
      {
        kind: "repo",
        id: "tomdale/docs",
        label: "tomdale/docs",
        hint: "Cached repository",
      },
    ]),
  };
});

import { type EntryDeps, runEntry } from "./surface.ts";

type CommitIntent = Parameters<EntryDeps["commit"]>[0];

describe("runEntry", () => {
  it("preselects an explicit target while showing the target picker", async () => {
    const commit = vi.fn(async (_intent: CommitIntent): Promise<void> => {});
    fuzzyResults.push(
      { kind: "action", query: "cloud-fix" },
      { kind: "item", value: { kind: "repo", id: "tomdale/workforest" } },
      { kind: "item", value: "cloud" },
    );

    await runEntry("create", {
      initialTarget: "cloud",
      commit,
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
    expect(commit).toHaveBeenCalledWith({
      changeName: "cloud-fix",
      sources: [{ kind: "repo", token: "tomdale/workforest" }],
      target: "cloud",
    });
  });

  it("cycles source modes backward on Shift-Tab", async () => {
    const commit = vi.fn(async () => {});
    fuzzyResults.push(
      { kind: "action", query: "cloud-fix" },
      { kind: "cancel" },
    );

    await runEntry("create", { commit });

    const sourceOptions = createFuzzyListMock.mock.calls[1]?.[0] as
      | FuzzyListOptions<unknown>
      | undefined;
    expect(sourceOptions?.scopeToggle?.active).toBe(0);

    const update = sourceOptions?.onTab?.("backward");
    expect(update?.scopeActive).toBe(2);
  });

  it("creates a local multi-repo change from two selected repos", async () => {
    const commit = vi.fn(async (_intent: CommitIntent): Promise<void> => {});
    fuzzyResults.push(
      { kind: "action", query: "multi-fix" },
      { kind: "tab", times: 2 },
      {
        kind: "items",
        values: [
          { kind: "repo", id: "tomdale/workforest" },
          { kind: "repo", id: "tomdale/cli" },
        ],
      },
      { kind: "item", value: "local" },
    );

    await runEntry("create", { commit });

    expect(commit).toHaveBeenCalledWith({
      changeName: "multi-fix",
      sources: [
        { kind: "repo", token: "tomdale/workforest" },
        { kind: "repo", token: "tomdale/cli" },
      ],
      target: "local",
    });
  });

  it("omits a repo that was toggled off before submitting multi-repo", async () => {
    const commit = vi.fn(async (_intent: CommitIntent): Promise<void> => {});
    fuzzyResults.push(
      { kind: "action", query: "toggle-fix" },
      { kind: "tab", times: 2 },
      {
        kind: "items",
        values: [
          { kind: "repo", id: "tomdale/cli" },
          { kind: "repo", id: "tomdale/docs" },
        ],
      },
      { kind: "item", value: "local" },
    );

    await runEntry("create", { commit });

    expect(commit).toHaveBeenCalledWith({
      changeName: "toggle-fix",
      sources: [
        { kind: "repo", token: "tomdale/cli" },
        { kind: "repo", token: "tomdale/docs" },
      ],
      target: "local",
    });
    const intent = commit.mock.calls[0]?.[0] as
      | { sources: unknown[] }
      | undefined;
    expect(intent?.sources).not.toContainEqual({
      kind: "repo",
      token: "tomdale/workforest",
    });
  });
});
