import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @unblessed/node requires a real TTY for Screen construction. Mock it so
// tests can exercise the pipeline state machine without a physical terminal.
// vi.mock is hoisted before imports, so this mock is in place when
// grid-consumer.ts loads and calls setRuntime(new NodeRuntime()).
vi.mock("@unblessed/node", () => {
  // Arrow functions are not constructable — use regular functions so that
  // `new Screen(...)`, `new Box(...)`, etc. work correctly in grid-consumer.
  return {
    setRuntime: vi.fn(),
    NodeRuntime: vi.fn(),
    Screen: vi.fn().mockImplementation(function (
      this: Record<string, unknown>,
    ) {
      this["key"] = vi.fn();
      this["once"] = vi.fn((_event: string, handler: () => void) => {
        handler();
      });
      this["render"] = vi.fn();
      this["destroy"] = vi.fn();
      this["append"] = vi.fn();
      this["width"] = 220;
      this["height"] = 50;
    }),
    Box: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
      this["setContent"] = vi.fn();
      this["destroy"] = vi.fn();
    }),
    ScrollableBox: vi.fn().mockImplementation(function (
      this: Record<string, unknown>,
    ) {
      this["key"] = vi.fn();
      this["setContent"] = vi.fn();
      this["setScrollPerc"] = vi.fn();
      this["destroy"] = vi.fn();
      this["height"] = 20;
      this["scroll"] = vi.fn();
    }),
  };
});

import {
  Box,
  NodeRuntime,
  Screen,
  ScrollableBox,
  setRuntime,
} from "@unblessed/node";
import type { RepoPipelineState } from "../workspace/pipeline.ts";
import { renderPipelinesGrid, shouldUseGrid } from "./grid-consumer.ts";

// ─── Regression: runtime initialization ──────────────────────────────────────

describe("module initialization", () => {
  it("calls setRuntime(new NodeRuntime()) at import time", () => {
    // If this call is missing, Screen construction throws "Runtime not
    // initialized" — the error that prompted adding this test.
    expect(vi.mocked(setRuntime)).toHaveBeenCalledWith(
      expect.any(NodeRuntime as ReturnType<typeof vi.fn>),
    );
  });
});

// ─── shouldUseGrid ────────────────────────────────────────────────────────────

describe("shouldUseGrid", () => {
  const originalDescriptors = {
    isTTY: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
    columns: Object.getOwnPropertyDescriptor(process.stdout, "columns"),
    rows: Object.getOwnPropertyDescriptor(process.stdout, "rows"),
  };

  afterEach(() => {
    for (const [key, descriptor] of Object.entries(originalDescriptors)) {
      if (descriptor) {
        Object.defineProperty(process.stdout, key, descriptor);
      }
    }
    vi.unstubAllEnvs();
  });

  function stubTTY(isTTY: boolean, columns = 220, rows = 50): void {
    for (const [key, value] of [
      ["isTTY", isTTY],
      ["columns", columns],
      ["rows", rows],
    ] as const) {
      Object.defineProperty(process.stdout, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
  }

  it("returns false when stdout is not a TTY", () => {
    stubTTY(false);
    expect(shouldUseGrid()).toBe(false);
  });

  it("returns false when terminal is too narrow (< 60 cols)", () => {
    stubTTY(true, 59);
    expect(shouldUseGrid()).toBe(false);
  });

  it("returns false when terminal is too short (< 15 rows)", () => {
    stubTTY(true, 220, 14);
    expect(shouldUseGrid()).toBe(false);
  });

  it("returns false when CI env var is set", () => {
    stubTTY(true);
    vi.stubEnv("CI", "true");
    expect(shouldUseGrid()).toBe(false);
  });

  it("returns false when WORKFOREST_NO_TUI env var is set", () => {
    stubTTY(true);
    vi.stubEnv("WORKFOREST_NO_TUI", "1");
    expect(shouldUseGrid()).toBe(false);
  });

  it("returns true for a large TTY with no CI flags", () => {
    stubTTY(true, 220, 50);
    expect(shouldUseGrid()).toBe(true);
  });

  it("returns true at exactly the minimum terminal size (60×15)", () => {
    stubTTY(true, 60, 15);
    expect(shouldUseGrid()).toBe(true);
  });

  it("returns false when repo count exceeds grid capacity", () => {
    stubTTY(true, 220, 50);
    expect(shouldUseGrid(10)).toBe(false);
  });
});

// ─── renderPipelinesGrid ──────────────────────────────────────────────────────

describe("renderPipelinesGrid", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns hasLockfile result for a completed repo", async () => {
    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield { phase: "git", step: "mirror", status: "running" };
      yield { phase: "git", step: "mirror", status: "completed" };
      yield { phase: "complete", hasLockfile: true };
    };

    const promise = renderPipelinesGrid({
      pipelines: new Map([["repo-a", pipeline()]]),
      repoNames: ["repo-a"],
    });
    await vi.runAllTimersAsync();

    expect(await promise).toEqual(new Map([["repo-a", { hasLockfile: true }]]));
  });

  it("records hasLockfile: false when repo has no lockfile", async () => {
    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield { phase: "complete", hasLockfile: false };
    };

    const promise = renderPipelinesGrid({
      pipelines: new Map([["repo-a", pipeline()]]),
      repoNames: ["repo-a"],
    });
    await vi.runAllTimersAsync();

    expect(await promise).toEqual(
      new Map([["repo-a", { hasLockfile: false }]]),
    );
  });

  it("omits failed repos from results", async () => {
    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield { phase: "git", step: "mirror", status: "running" };
      yield { phase: "failed", error: new Error("Clone failed") };
    };

    const promise = renderPipelinesGrid({
      pipelines: new Map([["repo-a", pipeline()]]),
      repoNames: ["repo-a"],
    });
    await vi.runAllTimersAsync();

    expect((await promise).has("repo-a")).toBe(false);
  });

  it("returns results for all repos in a multi-repo run", async () => {
    const makePipeline = (hasLockfile: boolean) =>
      async function* (): AsyncGenerator<RepoPipelineState> {
        yield { phase: "complete", hasLockfile };
      };

    const promise = renderPipelinesGrid({
      pipelines: new Map([
        ["repo-a", makePipeline(true)()],
        ["repo-b", makePipeline(false)()],
        ["repo-c", makePipeline(true)()],
      ]),
      repoNames: ["repo-a", "repo-b", "repo-c"],
    });
    await vi.runAllTimersAsync();

    const results = await promise;
    expect(results.get("repo-a")).toEqual({ hasLockfile: true });
    expect(results.get("repo-b")).toEqual({ hasLockfile: false });
    expect(results.get("repo-c")).toEqual({ hasLockfile: true });
  });

  it("returns partial results when some repos fail", async () => {
    const successPipeline =
      async function* (): AsyncGenerator<RepoPipelineState> {
        yield { phase: "complete", hasLockfile: true };
      };
    const failPipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield { phase: "failed", error: new Error("Network error") };
    };

    const promise = renderPipelinesGrid({
      pipelines: new Map([
        ["success", successPipeline()],
        ["failed", failPipeline()],
      ]),
      repoNames: ["success", "failed"],
    });
    await vi.runAllTimersAsync();

    const results = await promise;
    expect(results.get("success")).toEqual({ hasLockfile: true });
    expect(results.has("failed")).toBe(false);
  });

  it("handles all pipeline state phases without throwing", async () => {
    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield {
        phase: "git",
        step: "mirror",
        status: "running",
        message: "Fetching...",
      };
      yield {
        phase: "git",
        step: "mirror",
        status: "output",
        output: "remote: Counting objects: 100",
      };
      yield { phase: "git", step: "mirror", status: "completed" };
      yield { phase: "git", step: "worktree", status: "running" };
      yield { phase: "git", step: "worktree", status: "completed" };
      yield {
        phase: "initializer",
        name: "pnpm",
        status: "running",
        message: "Installing...",
      };
      yield {
        phase: "initializer",
        name: "pnpm",
        status: "output",
        output: "node_modules added",
      };
      yield { phase: "initializer", name: "pnpm", status: "completed" };
      yield { phase: "complete", hasLockfile: true };
    };

    const promise = renderPipelinesGrid({
      pipelines: new Map([["repo", pipeline()]]),
      repoNames: ["repo"],
    });
    await vi.runAllTimersAsync();

    const results = await promise;
    expect(results.get("repo")).toEqual({ hasLockfile: true });
  });

  it("batches bursty output into a small number of renders", async () => {
    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      for (let i = 0; i < 50; i++) {
        yield {
          phase: "git",
          step: "mirror",
          status: "output",
          output: `chunk-${i}\n`,
        };
      }
      yield { phase: "complete", hasLockfile: true };
    };

    const promise = renderPipelinesGrid({
      pipelines: new Map([["repo", pipeline()]]),
      repoNames: ["repo"],
    });
    await vi.runAllTimersAsync();
    await promise;

    const screen = vi.mocked(Screen).mock.instances.at(-1) as unknown as {
      render: ReturnType<typeof vi.fn>;
    };

    expect(screen.render.mock.calls.length).toBeLessThan(10);
  });

  it("coalesces chunked output and drops carriage-return rewrites", async () => {
    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield {
        phase: "git",
        step: "mirror",
        status: "output",
        output: "Receiving obj",
      };
      yield {
        phase: "git",
        step: "mirror",
        status: "output",
        output: "ects 50%\r",
      };
      yield {
        phase: "git",
        step: "mirror",
        status: "output",
        output: "Receiving objects 100%\nDone",
      };
      yield { phase: "complete", hasLockfile: true };
    };

    const promise = renderPipelinesGrid({
      pipelines: new Map([["repo", pipeline()]]),
      repoNames: ["repo"],
    });
    await vi.runAllTimersAsync();
    await promise;

    const pane = vi.mocked(ScrollableBox).mock.instances.at(-1) as unknown as {
      setContent: ReturnType<typeof vi.fn>;
    };
    const lastContent = pane.setContent.mock.lastCall?.[0];

    expect(lastContent?.split("\n").slice(0, 2).join("\n")).toBe(
      "Receiving objects 100%\nDone",
    );
  });

  it("supports eager render mode for benchmark environments", async () => {
    const pane = {
      setLabel: vi.fn(),
      appendLine: vi.fn(),
    };
    const grid = {
      getPane: vi.fn(() => pane),
      render: vi.fn(),
      destroy: vi.fn(),
    };
    const screen = {
      key: vi.fn(),
      once: vi.fn((_event: string, handler: () => void) => {
        handler();
      }),
      destroy: vi.fn(),
    };
    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield {
        phase: "git",
        step: "mirror",
        status: "output",
        output: "a\n",
      };
      yield {
        phase: "git",
        step: "mirror",
        status: "output",
        output: "b\n",
      };
      yield { phase: "complete", hasLockfile: true };
    };

    await renderPipelinesGrid({
      pipelines: new Map([["repo", pipeline()]]),
      repoNames: ["repo"],
      environment: {
        createScreen: () => screen,
        createGrid: () => grid,
        renderIntervalMs: 0,
        finalHoldMs: 0,
      },
    });

    expect(grid.render).toHaveBeenCalledTimes(5);
  });

  it("keeps the grid open with a completion modal until acknowledgement", async () => {
    const pane = {
      setLabel: vi.fn(),
      appendLine: vi.fn(),
    };
    const grid = {
      getPane: vi.fn(() => pane),
      render: vi.fn(),
      destroy: vi.fn(),
    };
    const screen = {
      key: vi.fn(),
      once: vi.fn(),
      destroy: vi.fn(),
    };
    const statusLine = {
      setContent: vi.fn(),
      destroy: vi.fn(),
    };
    const modal = {
      destroy: vi.fn(),
    };
    const createCompletionModal = vi.fn(() => modal);
    let acknowledge!: () => void;
    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield { phase: "complete", hasLockfile: true };
    };

    const promise = renderPipelinesGrid({
      pipelines: new Map([["repo", pipeline()]]),
      repoNames: ["repo"],
      environment: {
        createScreen: () => screen,
        createGrid: () => grid,
        createStatusLine: () => statusLine,
        createCompletionModal,
        waitForCompletionAck: () =>
          new Promise((resolve) => {
            acknowledge = resolve;
          }),
        renderIntervalMs: 0,
        finalHoldMs: 0,
      },
    });

    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(createCompletionModal).toHaveBeenCalledWith({
      screen,
      worktreeNames: ["repo"],
      completedCount: 1,
      totalCount: 1,
      setupWarnings: [],
      repoErrors: [],
    });
    expect(pane.appendLine).not.toHaveBeenCalledWith(
      expect.stringContaining("Press any key"),
    );
    expect(statusLine.setContent).not.toHaveBeenCalledWith(
      expect.stringContaining("Press any key"),
    );
    expect(grid.destroy).not.toHaveBeenCalled();
    expect(screen.destroy).not.toHaveBeenCalled();

    acknowledge();

    await expect(promise).resolves.toEqual(
      new Map([["repo", { hasLockfile: true }]]),
    );
    expect(modal.destroy).toHaveBeenCalledTimes(1);
    expect(statusLine.destroy).toHaveBeenCalledTimes(1);
    expect(grid.destroy).toHaveBeenCalledTimes(1);
    expect(screen.destroy).toHaveBeenCalledTimes(1);
  });

  it("renders the default success completion modal content", async () => {
    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield { phase: "complete", hasLockfile: true };
    };

    const promise = renderPipelinesGrid({
      pipelines: new Map([["repo", pipeline()]]),
      repoNames: ["repo"],
      workspacePath: "/tmp/workspace",
    });
    await vi.runAllTimersAsync();
    await promise;

    const modalCall = vi
      .mocked(Box)
      .mock.calls.find((call) =>
        String(call[0]?.content).includes("/tmp/workspace"),
      );

    expect(modalCall?.[0]).toEqual(
      expect.objectContaining({
        content: expect.stringContaining(
          "{cyan-fg}•{/cyan-fg} {bold}repo{/bold}",
        ),
        width: 50,
      }),
    );
    expect(vi.mocked(Box).mock.calls).toContainEqual([
      expect.objectContaining({
        content: "Workspace Created",
      }),
    ]);
    expect(String(modalCall?.[0]?.content)).toContain(
      "{bold}{cyan-fg}press any key{/cyan-fg}{/bold}",
    );
    expect(String(modalCall?.[0]?.content)).not.toContain("Workspace stamped");
    expect(String(modalCall?.[0]?.content)).not.toContain("created");
  });

  it("animates the default success completion modal until acknowledgement", async () => {
    let acknowledge!: () => void;
    vi.mocked(Screen).mockImplementationOnce(function (this: unknown) {
      const screen = this as Record<string, unknown>;
      screen["key"] = vi.fn();
      screen["once"] = vi.fn((_event: string, handler: () => void) => {
        acknowledge = handler;
      });
      screen["render"] = vi.fn();
      screen["destroy"] = vi.fn();
      screen["append"] = vi.fn();
      screen["width"] = 120;
      screen["height"] = 40;
    });

    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield { phase: "complete", hasLockfile: true };
    };

    const promise = renderPipelinesGrid({
      pipelines: new Map([["repo", pipeline()]]),
      repoNames: ["repo"],
    });

    await vi.advanceTimersByTimeAsync(40);
    await Promise.resolve();

    const modalIndex = vi
      .mocked(Box)
      .mock.calls.findIndex((call) =>
        String(call[0]?.content).includes("{bold}repo{/bold}"),
      );
    const modal = vi.mocked(Box).mock.instances[modalIndex] as unknown as {
      setContent: ReturnType<typeof vi.fn>;
    };

    await vi.advanceTimersByTimeAsync(360);

    const renderedFrames = modal.setContent.mock.calls.map(([content]) =>
      String(content),
    );
    expect(new Set(renderedFrames).size).toBeGreaterThan(1);

    acknowledge();
    await expect(promise).resolves.toEqual(
      new Map([["repo", { hasLockfile: true }]]),
    );
  });

  it("renders initializer failures as setup warnings in the completion modal", async () => {
    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield {
        phase: "failed",
        step: "initializer:pnpm install",
        error: new Error("install failed"),
      };
    };

    const promise = renderPipelinesGrid({
      pipelines: new Map([["repo", pipeline()]]),
      repoNames: ["repo"],
    });
    await vi.runAllTimersAsync();
    const results = await promise;

    const modalCall = vi
      .mocked(Box)
      .mock.calls.find((call) =>
        String(call[0]?.content).includes("Setup warnings"),
      );

    expect(results.has("repo")).toBe(false);
    expect(String(modalCall?.[0]?.content)).not.toContain("Workspace stamped");
    expect(String(modalCall?.[0]?.content)).toContain(
      "initializer:pnpm install",
    );
    expect(String(modalCall?.[0]?.content)).toContain("install failed");
  });

  it("renders git and worktree failures as repo errors in the completion modal", async () => {
    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield {
        phase: "failed",
        step: "git:worktree",
        error: new Error("worktree failed"),
      };
    };

    const promise = renderPipelinesGrid({
      pipelines: new Map([["repo", pipeline()]]),
      repoNames: ["repo"],
    });
    await vi.runAllTimersAsync();
    const results = await promise;

    const modalCall = vi
      .mocked(Box)
      .mock.calls.find((call) =>
        String(call[0]?.content).includes("Repository setup needs attention"),
      );

    expect(results.has("repo")).toBe(false);
    expect(String(modalCall?.[0]?.content)).toContain("git:worktree");
    expect(String(modalCall?.[0]?.content)).toContain("worktree failed");
  });

  it("destroys the screen when a pipeline throws", async () => {
    const pane = {
      setLabel: vi.fn(),
      appendLine: vi.fn(),
    };
    const grid = {
      getPane: vi.fn(() => pane),
      render: vi.fn(),
      destroy: vi.fn(),
    };
    const screen = {
      key: vi.fn(),
      once: vi.fn(),
      destroy: vi.fn(),
    };
    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield { phase: "git", step: "mirror", status: "running" };
      throw new Error("workspace setup failed");
    };

    await expect(
      renderPipelinesGrid({
        pipelines: new Map([["repo", pipeline()]]),
        repoNames: ["repo"],
        environment: {
          createScreen: () => screen,
          createGrid: () => grid,
          renderIntervalMs: 33,
          finalHoldMs: 0,
        },
      }),
    ).rejects.toThrow("workspace setup failed");

    expect(grid.destroy).toHaveBeenCalledTimes(1);
    expect(screen.destroy).toHaveBeenCalledTimes(1);

    await vi.runOnlyPendingTimersAsync();
    expect(grid.render).toHaveBeenCalledTimes(1);
  });

  it("rejects instead of silently dropping repos beyond grid capacity", async () => {
    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield { phase: "complete", hasLockfile: true };
    };
    const repoNames = Array.from({ length: 10 }, (_, i) => `repo-${i}`);

    await expect(
      renderPipelinesGrid({
        pipelines: new Map(repoNames.map((name) => [name, pipeline()])),
        repoNames,
        environment: {
          createScreen: () => ({
            key: vi.fn(),
            once: vi.fn(),
            destroy: vi.fn(),
          }),
          createGrid: () => ({
            getPane: vi.fn(),
            render: vi.fn(),
            destroy: vi.fn(),
          }),
          finalHoldMs: 0,
        },
      }),
    ).rejects.toThrow("Grid can render 9 repositories");
  });
});
