import { describe, expect, it, vi } from "vitest";

type KeyHandler = () => void;

const testState = vi.hoisted(() => ({
  keyHandler: undefined as KeyHandler | undefined,
  appendLine: vi.fn(),
  destroyScreen: vi.fn(),
}));

vi.mock("../terminal/fullscreen-surface.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../terminal/fullscreen-surface.ts")>();

  return {
    ...actual,
    createFullscreenScreen: () => ({
      key: (_keys: string[], handler: KeyHandler) => {
        testState.keyHandler = handler;
      },
      destroy: testState.destroyScreen,
    }),
    createFullscreenStatusLine: () => ({
      setContent: vi.fn(),
      destroy: vi.fn(),
    }),
  };
});

vi.mock("./grid-layout.ts", () => ({
  calculateGridDimensions: () => ({ rows: 1, cols: 1 }),
  GridLayout: class {
    private pane = {
      setLabel: vi.fn(),
      appendLine: testState.appendLine,
    };

    getPane(): typeof this.pane {
      return this.pane;
    }

    render(): void {}

    destroy(): void {}
  },
}));

vi.mock("../workspace/initialization.ts", () => ({
  readWorkspaceInitializationState: vi.fn().mockResolvedValue({
    status: "ready",
    message: "Initialization complete",
  }),
  watchRepoInitialization: () =>
    (async function* () {
      yield {
        phase: "initializer",
        name: "install",
        status: "output",
        output: "first\n",
      };
      yield {
        phase: "initializer",
        name: "install",
        status: "output",
        output: "second\n",
      };
    })(),
}));

import { renderInitializationStatus } from "./initialization-status.ts";

describe("renderInitializationStatus", () => {
  it("stops rendering queued output after q is pressed", async () => {
    testState.appendLine.mockImplementationOnce(() => {
      queueMicrotask(() => testState.keyHandler?.());
    });

    await renderInitializationStatus("/tmp/workspace", ["repo"]);

    expect(testState.appendLine).toHaveBeenCalledTimes(1);
    expect(testState.destroyScreen).toHaveBeenCalledOnce();
  });
});
