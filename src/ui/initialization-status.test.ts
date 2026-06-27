import { beforeEach, describe, expect, it, vi } from "vitest";

type KeyHandler = () => void;

const testState = vi.hoisted(() => ({
  keyHandler: undefined as KeyHandler | undefined,
  appendLine: vi.fn(),
  destroyScreen: vi.fn(),
  labels: [] as string[],
  workspaceStates: [] as Array<{
    status: string;
    message?: string;
    warnings?: string[];
  }>,
  metadata: null as null | {
    workspace: { template_id?: string; template_variant?: string };
  },
  template: null as null | { config: Record<string, unknown> },
  loadedTemplates: [] as string[],
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
  calculateGridDimensions: (count: number) => ({ rows: 1, cols: count }),
  GridLayout: class {
    private panes = Array.from({ length: 8 }, () => ({
      setLabel: (label: string) => {
        testState.labels.push(label);
      },
      appendLine: testState.appendLine,
    }));

    getPane(index = 0): (typeof this.panes)[number] | undefined {
      return this.panes[index];
    }

    render(): void {}

    destroy(): void {}
  },
}));

vi.mock("../workspace/metadata.ts", () => ({
  readWorkspaceMetadata: vi.fn(async () => testState.metadata),
}));

vi.mock("../templates/index.ts", () => ({
  formatTemplateIdentifier: ({
    parent,
    variant,
  }: {
    parent: string;
    variant?: string;
  }) => (variant ? `${parent}+${variant}` : parent),
  loadTemplate: vi.fn(async (templateId: string) => {
    testState.loadedTemplates.push(templateId);
    return testState.template;
  }),
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

vi.mock("../workspace/initialization-scope.ts", () => ({
  getInitializationRootDir: (target: { workspaceDir: string }) =>
    target.workspaceDir,
}));

import { renderInitializationStatus } from "./initialization-status.ts";

describe("renderInitializationStatus", () => {
  beforeEach(() => {
    testState.keyHandler = undefined;
    testState.labels = [];
    testState.loadedTemplates = [];
    testState.metadata = null;
    testState.template = null;
    testState.appendLine.mockReset();
    testState.destroyScreen.mockClear();
  });

  it("stops rendering queued output after q is pressed", async () => {
    testState.appendLine.mockImplementationOnce(() => {
      queueMicrotask(() => testState.keyHandler?.());
    });

    await renderInitializationStatus("/tmp/workspace", ["repo"]);

    expect(testState.appendLine).toHaveBeenCalledTimes(1);
    expect(testState.destroyScreen).toHaveBeenCalledOnce();
  });

  it("adds a virtual AGENTS.md pane for template guidance refresh", async () => {
    testState.metadata = { workspace: { template_id: "agents-template" } };
    testState.template = { config: { "AGENTS.md": { focus: "settings" } } };
    testState.appendLine.mockImplementationOnce(() => {
      queueMicrotask(() => testState.keyHandler?.());
    });

    await renderInitializationStatus("/tmp/workspace", ["front"]);

    expect(testState.labels.some((label) => label.includes("AGENTS.md"))).toBe(
      true,
    );
  });

  it("uses the template variant when deciding whether to show AGENTS.md", async () => {
    testState.metadata = {
      workspace: {
        template_id: "agents-template",
        template_variant: "focused",
      },
    };
    testState.template = { config: { "AGENTS.md": { focus: "settings" } } };
    testState.appendLine.mockImplementationOnce(() => {
      queueMicrotask(() => testState.keyHandler?.());
    });

    await renderInitializationStatus("/tmp/workspace", ["front"]);

    expect(testState.loadedTemplates).toContain("agents-template+focused");
    expect(testState.labels.some((label) => label.includes("AGENTS.md"))).toBe(
      true,
    );
  });
});
