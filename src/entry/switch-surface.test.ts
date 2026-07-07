import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FuzzyListOptions, FuzzyResult } from "../terminal/fuzzy-list.ts";
import type { InventoryEntry } from "../workspace/inventory.ts";

const fuzzyResult = vi.hoisted(() => ({
  value: { kind: "cancel" } as FuzzyResult<InventoryEntry>,
}));
const createFuzzyListMock = vi.hoisted(() =>
  vi.fn((_options: unknown) => ({
    run: vi.fn(async () => fuzzyResult.value),
    destroy: vi.fn(),
  })),
);
const screenDestroyMock = vi.hoisted(() => vi.fn());

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

import { runSwitchSurface } from "./switch-surface.ts";

beforeEach(() => {
  fuzzyResult.value = { kind: "cancel" };
  createFuzzyListMock.mockClear();
  screenDestroyMock.mockClear();
});

describe("runSwitchSurface", () => {
  it("starts in the current scope and uses Tab to switch to all changes", async () => {
    const entries = [
      worktree("front/login", 100),
      worktree("api/cache", 300),
      templateWorkspace("agent/auth", 500),
    ];

    await runSwitchSurface(entries, { kind: "repo", name: "front" });

    const options = fuzzyOptions();
    expect(selectors(options.items)).toEqual(["front/login"]);
    expect(options.scopeToggle).toEqual({
      options: [{ label: "in front", name: "front" }, { label: "all" }],
      active: 0,
    });

    const all = options.onTab?.("forward");
    expect(all?.scopeActive).toBe(1);
    expect(selectors(all?.items ?? [])).toEqual([
      "agent/auth",
      "api/cache",
      "front/login",
    ]);

    const scoped = options.onTab?.("forward");
    expect(scoped?.scopeActive).toBe(0);
    expect(selectors(scoped?.items ?? [])).toEqual(["front/login"]);
  });

  it("falls back to all recency-sorted changes when the scope is empty", async () => {
    const entries = [
      worktree("front/login", 100),
      worktree("api/cache", 300),
      templateWorkspace("agent/auth", 500),
    ];

    await runSwitchSurface(entries, { kind: "repo", name: "missing" });

    const options = fuzzyOptions();
    expect(selectors(options.items)).toEqual([
      "agent/auth",
      "api/cache",
      "front/login",
    ]);
    expect(options.scopeToggle).toBeUndefined();
    expect(options.onTab).toBeUndefined();
  });

  it("forwards an initial query to the fuzzy list", async () => {
    const entries = [worktree("front/login", 100)];

    await runSwitchSurface(entries, undefined, "login");

    expect(fuzzyOptions().initialQuery).toBe("login");
  });
});

function fuzzyOptions(): FuzzyListOptions<InventoryEntry> {
  const call = createFuzzyListMock.mock.calls[0];
  if (!call) throw new Error("Expected createFuzzyList call");
  return call[0] as FuzzyListOptions<InventoryEntry>;
}

function selectors(
  items: readonly { value: InventoryEntry }[],
): readonly string[] {
  return items.map((item) => item.value.selector);
}

function worktree(selector: string, modifiedAtMs: number): InventoryEntry {
  const [repository = "repo", changeName = "change"] = selector.split("/");
  return {
    type: "worktree",
    selector,
    groupName: repository,
    changeName,
    repository,
    state: "ready",
    modifiedAt: new Date(modifiedAtMs).toISOString(),
    modifiedAtMs,
    path: `/tmp/${selector}`,
  };
}

function templateWorkspace(
  selector: string,
  modifiedAtMs: number,
): InventoryEntry {
  const [groupName = "template", changeName = "change"] = selector.split("/");
  return {
    type: "template-workspace",
    selector,
    groupName,
    changeName,
    repos: ["front"],
    repoSummary: "front",
    state: "ready",
    modifiedAt: new Date(modifiedAtMs).toISOString(),
    modifiedAtMs,
    path: `/tmp/${selector}`,
  };
}
