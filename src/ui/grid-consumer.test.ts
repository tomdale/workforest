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

import { Box, Screen, ScrollableBox } from "@unblessed/node";
import stringWidth from "string-width";
import {
  createFullscreenKeypress,
  type FullscreenKeypress,
  type FullscreenScreen,
} from "../terminal/fullscreen-surface.ts";
import type { RepoPipelineState } from "../workspace/pipeline.ts";
import {
  getCompletionModalContent,
  renderPipelinesGrid,
  shouldUseGrid,
} from "./grid-consumer.ts";

function createManualKeypress(
  setReceive: (receive: () => void) => void,
): FullscreenKeypress {
  return createFullscreenKeypress({
    once: (_event: string, receive: () => void) => {
      setReceive(receive);
    },
  } as unknown as FullscreenScreen);
}

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

  it("supports a single repository", () => {
    stubTTY(true);
    expect(shouldUseGrid(1)).toBe(true);
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

  it("returns completed repo results and omits failed repos", async () => {
    const makePipeline = (hasLockfile: boolean) =>
      async function* (): AsyncGenerator<RepoPipelineState> {
        yield { phase: "complete", hasLockfile };
      };
    const failPipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield { phase: "failed", error: new Error("Network error") };
    };

    const promise = renderPipelinesGrid({
      pipelines: new Map([
        ["repo-a", makePipeline(true)()],
        ["repo-b", makePipeline(false)()],
        ["repo-c", failPipeline()],
      ]),
      repoNames: ["repo-a", "repo-b", "repo-c"],
    });
    await vi.runAllTimersAsync();

    const results = await promise;
    expect(results.get("repo-a")).toEqual({ hasLockfile: true });
    expect(results.get("repo-b")).toEqual({ hasLockfile: false });
    expect(results.has("repo-c")).toBe(false);
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
        createCompletionAck: () =>
          createManualKeypress((receive) => {
            acknowledge = receive;
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

  it("stops rendering queued output after completion acknowledgement", async () => {
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
      yield { phase: "worktree-ready", hasLockfile: true };
      yield {
        phase: "initializer",
        name: "pnpm install",
        status: "output",
        output: "queued output\n",
      };
    };

    const promise = renderPipelinesGrid({
      pipelines: new Map([["repo", pipeline()]]),
      repoNames: ["repo"],
      completeOnWorktreesReady: true,
      environment: {
        createScreen: () => screen,
        createGrid: () => grid,
        createCompletionModal: () => ({ destroy: vi.fn() }),
        createCompletionAck: () => {
          let acknowledge!: () => void;
          const keypress = createManualKeypress((receive) => {
            acknowledge = receive;
          });
          acknowledge();
          return keypress;
        },
        renderIntervalMs: 0,
        finalHoldMs: 0,
      },
    });

    await expect(promise).resolves.toEqual(
      new Map([["repo", { hasLockfile: true }]]),
    );
    expect(pane.appendLine).not.toHaveBeenCalledWith("queued output");
  });

  it("shows completion at worktree readiness and returns while initialization continues", async () => {
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
    const modal = { destroy: vi.fn() };
    let acknowledge!: () => void;
    let monitorClosed = false;
    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      try {
        yield { phase: "worktree-ready", hasLockfile: true };
        await new Promise((resolve) => setTimeout(resolve, 100));
        yield {
          phase: "initializer",
          name: "pnpm install",
          status: "running",
        };
      } finally {
        monitorClosed = true;
      }
    };
    const onBeforeCompletionPrompt = vi.fn();

    const promise = renderPipelinesGrid({
      pipelines: new Map([["repo", pipeline()]]),
      repoNames: ["repo"],
      completeOnWorktreesReady: true,
      backgroundInitialization: true,
      onBeforeCompletionPrompt,
      environment: {
        createScreen: () => screen,
        createGrid: () => grid,
        createCompletionModal: vi.fn(() => modal),
        createCompletionAck: () =>
          createManualKeypress((receive) => {
            acknowledge = receive;
          }),
        renderIntervalMs: 0,
        finalHoldMs: 0,
      },
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(onBeforeCompletionPrompt).toHaveBeenCalledWith(
      new Map([["repo", { hasLockfile: true }]]),
    );

    await vi.advanceTimersByTimeAsync(100);
    expect(
      pane.setLabel.mock.calls.some(([label]) =>
        String(label).includes("pnpm install"),
      ),
    ).toBe(true);

    acknowledge();
    await expect(promise).resolves.toEqual(
      new Map([["repo", { hasLockfile: true }]]),
    );
    expect(monitorClosed).toBe(true);
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
        content: expect.stringContaining("•{"),
        width: 50,
      }),
    );
    expect(String(modalCall?.[0]?.content)).toContain("{bold}repo{/bold}");
    expect(String(modalCall?.[0]?.content)).toContain(
      "{bold}press any key{/bold}",
    );
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
    expect(String(modalCall?.[0]?.content)).toContain("Setup warnings");
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

describe("completion modal content layout", () => {
  const stripTags = (line: string): string => line.replace(/\{[^}]*\}/g, "");
  const visibleWidth = (line: string): number => stringWidth(stripTags(line));

  const baseOptions = {
    completedCount: 3,
    totalCount: 3,
    workspacePath: "/Users/me/Code/Workspaces/vercel-agent/auth-redesign",
    worktreeNames: ["front", "api", "edge-config-store"],
    setupWarnings: [],
    repoErrors: [],
    backgroundInitialization: true,
  };

  // The confetti layer animates by re-rendering with fresh random star rows.
  // If any composed line is wider than the content width the modal box wraps it
  // onto a second visual row, which shoves the text up and down between frames.
  // Across many random frames every line must stay within the content width and
  // the line count must never change.
  it("keeps every line within the content width across animation frames", () => {
    const contentWidth = 58;

    const firstFrame = getCompletionModalContent({
      ...baseOptions,
      contentWidth,
    });
    const lineCount = firstFrame.length;
    expect(lineCount).toBeGreaterThan(0);

    for (let frame = 0; frame < 250; frame += 1) {
      const lines = getCompletionModalContent({ ...baseOptions, contentWidth });
      expect(lines).toHaveLength(lineCount);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(contentWidth);
      }
    }
  });
});
