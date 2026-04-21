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
      this.key = vi.fn();
      this.render = vi.fn();
      this.destroy = vi.fn();
      this.append = vi.fn();
      this.width = 220;
      this.height = 50;
    }),
    Box: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
      this.setContent = vi.fn();
      this.destroy = vi.fn();
    }),
    ScrollableBox: vi.fn().mockImplementation(function (
      this: Record<string, unknown>,
    ) {
      this.key = vi.fn();
      this.setContent = vi.fn();
      this.setScrollPerc = vi.fn();
      this.destroy = vi.fn();
      this.height = 20;
      this.scroll = vi.fn();
    }),
  };
});

import { NodeRuntime, setRuntime } from "@unblessed/node";
import { Screen, ScrollableBox } from "@unblessed/node";
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
});

// ─── renderPipelinesGrid ──────────────────────────────────────────────────────

describe("renderPipelinesGrid", () => {
  beforeEach(() => {
    vi.useFakeTimers();
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

    const screen = vi.mocked(Screen).mock.instances.at(-1) as {
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

    const pane = vi.mocked(ScrollableBox).mock.instances.at(-1) as {
      setContent: ReturnType<typeof vi.fn>;
    };
    const lastContent = pane.setContent.mock.lastCall?.[0];

    expect(lastContent).toBe("Receiving objects 100%\nDone");
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

    expect(grid.render).toHaveBeenCalledTimes(4);
  });
});
