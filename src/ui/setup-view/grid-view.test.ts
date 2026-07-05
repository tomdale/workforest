import { describe, expect, it, vi } from "vitest";
import type { RunEvent, RunEventBody } from "../../workspace/run-log/events.ts";
import {
  renderSetupGrid,
  type SetupCompletionModalOptions,
  type SetupGridLike,
  type SetupKeyEvent,
  type SetupViewEnvironment,
} from "./grid-view.ts";

function stripTags(value: string): string {
  return value.replace(/\{[^}]*\}/g, "");
}

function createEventSource(): {
  events: AsyncGenerator<RunEvent>;
  push: (body: RunEventBody) => void;
  close: () => void;
} {
  const queue: RunEvent[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let seq = 0;

  const push = (body: RunEventBody): void => {
    seq += 1;
    queue.push({
      v: 1,
      runId: "run",
      src: "cli",
      seq,
      ts: new Date(seq).toISOString(),
      ...body,
    });
    wake?.();
    wake = null;
  };

  const close = (): void => {
    closed = true;
    wake?.();
    wake = null;
  };

  const events = (async function* (): AsyncGenerator<RunEvent> {
    while (true) {
      while (queue.length > 0) {
        const event = queue.shift();
        if (event) yield event;
      }
      if (closed) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();

  return { events, push, close };
}

type MockPane = {
  labels: string[];
  contents: string[];
  focused: boolean[];
  setLabel(label: string): void;
  setContent(content: string): void;
  setFocused(focused: boolean): void;
  getContentSize(): { width: number; height: number };
};

type MockGrid = SetupGridLike & {
  rows: number;
  cols: number;
  panes: Map<number, MockPane>;
  zoomCalls: (number | null)[];
  hideCalls: number[];
  reflowCalls: number;
};

function createMockEnvironment(
  // 100×26 holds a 3×3 of minimum panes, mirroring the old fixed capacity.
  viewport: { width: number; height: number } = { width: 100, height: 26 },
): {
  environment: SetupViewEnvironment;
  grids: MockGrid[];
  statusContents: string[];
  completionCalls: SetupCompletionModalOptions[];
  helpCalls: string[][];
  helpDestroys: number;
  press: (name: string, key?: Partial<SetupKeyEvent>) => void;
  pressChar: (ch: string) => void;
  resize: (next?: { width: number; height: number }) => void;
} {
  let keypressHandler:
    | ((ch: string | undefined, key: SetupKeyEvent | undefined) => void)
    | null = null;
  let resizeHandler: (() => void) | null = null;
  let size = viewport;
  const grids: MockGrid[] = [];
  const statusContents: string[] = [];
  const completionCalls: SetupCompletionModalOptions[] = [];
  const helpCalls: string[][] = [];
  const helpState = { destroys: 0 };

  const makePane = (): MockPane => {
    const pane: MockPane = {
      labels: [],
      contents: [],
      focused: [],
      setLabel: (label) => pane.labels.push(label),
      setContent: (content) => pane.contents.push(content),
      setFocused: (focused) => pane.focused.push(focused),
      getContentSize: () => ({ width: 48, height: 12 }),
    };
    return pane;
  };

  const environment: SetupViewEnvironment = {
    createScreen: () => ({
      onKeypress: (handler) => {
        keypressHandler = handler;
      },
      onResize: (handler) => {
        resizeHandler = handler;
      },
      getSize: () => size,
      render: vi.fn(),
      destroy: vi.fn(),
    }),
    createGrid: ({ rows, cols }) => {
      const grid: MockGrid = {
        rows,
        cols,
        panes: new Map(),
        zoomCalls: [],
        hideCalls: [],
        reflowCalls: 0,
        getPane: (index) => {
          if (index >= rows * cols) return undefined;
          let pane = grid.panes.get(index);
          if (!pane) {
            pane = makePane();
            grid.panes.set(index, pane);
          }
          return pane;
        },
        reflow: () => {
          grid.reflowCalls += 1;
        },
        setZoomedPane: (index) => {
          grid.zoomCalls.push(index);
        },
        setVisiblePane: () => undefined,
        hidePane: (index) => {
          grid.hideCalls.push(index);
        },
        render: vi.fn(),
        destroy: vi.fn(),
      };
      grids.push(grid);
      return grid;
    },
    createStatusLine: () => ({
      setContent: (content) => statusContents.push(content),
      destroy: vi.fn(),
    }),
    createCompletionModal: (options) => {
      completionCalls.push(options);
      return { destroy: vi.fn() };
    },
    createHelpOverlay: ({ lines }) => {
      helpCalls.push([...lines]);
      return {
        destroy: () => {
          helpState.destroys += 1;
        },
      };
    },
    renderIntervalMs: 0,
  };

  return {
    environment,
    grids,
    statusContents,
    completionCalls,
    helpCalls,
    get helpDestroys() {
      return helpState.destroys;
    },
    press: (name, key = {}) => {
      keypressHandler?.(undefined, { name, ...key });
    },
    pressChar: (ch) => {
      keypressHandler?.(ch, undefined);
    },
    resize: (next) => {
      if (next) size = next;
      resizeHandler?.();
    },
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("renderSetupGrid", () => {
  it("renders checklists and keeps the success modal up until a keypress", async () => {
    const { events, push } = createEventSource();
    const mock = createMockEnvironment();

    const promise = renderSetupGrid({
      events,
      repoNames: ["front", "api"],
      mode: "until-ready",
      targetDir: "/ws/billing",
      environment: mock.environment,
    });

    push({
      kind: "run-start",
      command: "new",
      repos: ["front", "api"],
      scope: "workspace",
      pid: 1,
    });
    push({
      kind: "step-start",
      repo: "front",
      step: "git:mirror",
      title: "mirror",
    });
    push({
      kind: "step-end",
      repo: "front",
      step: "git:mirror",
      outcome: "ok",
      durationMs: 2_100,
    });
    push({ kind: "repo-end", repo: "front", outcome: "ready" });
    push({ kind: "repo-end", repo: "api", outcome: "ready" });
    push({ kind: "run-end", outcome: "ready", durationMs: 10_000 });

    // The celebration is never auto-dismissed: the grid stays up until the
    // user acknowledges it.
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    await tick();
    await tick();
    expect(resolved).toBe(false);
    expect(mock.completionCalls).toHaveLength(1);
    expect(mock.completionCalls[0]?.completedCount).toBe(2);
    expect(mock.completionCalls[0]?.failures).toEqual([]);

    mock.press("x");
    const result = await promise;
    expect(result.outcome).toBe("ready");

    const grid = mock.grids[0];
    const frontPane = grid?.panes.get(0);
    expect(frontPane?.labels.map(stripTags).join("\n")).toContain("front");
    expect(frontPane?.contents.map(stripTags).join("\n")).toContain("mirror");
  });

  it("keeps the grid up on failure until a keypress", async () => {
    const { events, push } = createEventSource();
    const mock = createMockEnvironment();

    const promise = renderSetupGrid({
      events,
      repoNames: ["front"],
      mode: "until-ready",
      environment: mock.environment,
    });

    push({
      kind: "repo-end",
      repo: "front",
      outcome: "failed",
      step: "init:pnpm-install",
      error: { message: "boom" },
    });
    push({ kind: "run-end", outcome: "failed", durationMs: 5_000 });

    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    await tick();
    await tick();
    expect(resolved).toBe(false);
    expect(mock.completionCalls[0]?.failures).toEqual([
      { repoName: "front", step: "init:pnpm-install", message: "boom" },
    ]);

    mock.press("x");
    const result = await promise;
    expect(result.outcome).toBe("failed");
  });

  it("hides the status line at a terminal state, before the acknowledging keypress", async () => {
    const { events, push } = createEventSource();
    const mock = createMockEnvironment();
    const originalCreateStatusLine = mock.environment.createStatusLine;
    if (!originalCreateStatusLine) {
      throw new Error(
        "expected the mock environment to provide createStatusLine",
      );
    }
    let createStatusLineCalls = 0;
    let destroyCalls = 0;
    mock.environment.createStatusLine = (options) => {
      createStatusLineCalls += 1;
      const real = originalCreateStatusLine(options);
      return {
        setContent: real.setContent,
        destroy: () => {
          destroyCalls += 1;
          real.destroy();
        },
      };
    };

    const promise = renderSetupGrid({
      events,
      repoNames: ["front"],
      mode: "until-ready",
      environment: mock.environment,
    });
    push({
      kind: "run-start",
      command: "new",
      repos: ["front"],
      scope: "workspace",
      pid: 1,
    });
    await tick();
    expect(createStatusLineCalls).toBe(1);

    push({ kind: "repo-end", repo: "front", outcome: "ready" });
    push({ kind: "run-end", outcome: "ready", durationMs: 1_000 });
    await tick();
    await tick();

    // Terminal state: the modal is about to swallow every key, so the status
    // line (its hints, its ticking elapsed time) is torn down rather than
    // left running dead behind it.
    expect(mock.completionCalls).toHaveLength(1);
    expect(destroyCalls).toBe(1);
    const statusContentsAtTerminal = mock.statusContents.length;

    // A resize while the modal is up must not resurrect the status line.
    mock.resize({ width: 90, height: 24 });
    expect(createStatusLineCalls).toBe(1);
    expect(mock.statusContents.length).toBe(statusContentsAtTerminal);

    // The keypress still resolves the grid as normal.
    mock.press("x");
    const result = await promise;
    expect(result.outcome).toBe("ready");
  });

  it("detaches on d without waiting for run-end", async () => {
    const { events, push } = createEventSource();
    const mock = createMockEnvironment();

    const promise = renderSetupGrid({
      events,
      repoNames: ["front"],
      mode: "until-ready",
      environment: mock.environment,
    });
    push({
      kind: "run-start",
      command: "new",
      repos: ["front"],
      scope: "workspace",
      pid: 1,
    });
    await tick();

    mock.press("d");
    const result = await promise;
    expect(result.outcome).toBe("detached");
  });

  it("requests a graceful cancel on the first press and forces on the second", async () => {
    const { events, push } = createEventSource();
    const mock = createMockEnvironment();
    const onCancelRequest = vi.fn();
    const forceExit = vi.fn();

    const promise = renderSetupGrid({
      events,
      repoNames: ["front"],
      mode: "until-ready",
      onCancelRequest,
      forceExit,
      environment: mock.environment,
    });
    push({
      kind: "run-start",
      command: "new",
      repos: ["front"],
      scope: "workspace",
      pid: 1,
    });
    await tick();

    mock.press("q");
    expect(onCancelRequest).toHaveBeenCalledTimes(1);
    expect(forceExit).not.toHaveBeenCalled();
    expect(
      mock.statusContents
        .map(stripTags)
        .some((line) =>
          line.includes("Cancelling, press Ctrl-C again to force"),
        ),
    ).toBe(true);

    // Second press escalates to a forced exit.
    mock.press("c", { ctrl: true });
    expect(forceExit).toHaveBeenCalledWith(130);

    // The graceful path still resolves once the run reaches its end.
    push({ kind: "run-end", outcome: "failed", durationMs: 1_000 });
    const result = await promise;
    expect(result.outcome).toBe("cancelled");
  });

  it("quits watch mode on q without cancel semantics", async () => {
    const { events, push } = createEventSource();
    const mock = createMockEnvironment();
    const onCancelRequest = vi.fn();

    const promise = renderSetupGrid({
      events,
      repoNames: ["front"],
      mode: "watch",
      onCancelRequest,
      environment: mock.environment,
    });
    push({
      kind: "run-start",
      command: "new",
      repos: ["front"],
      scope: "workspace",
      pid: 1,
    });
    await tick();

    mock.press("q");
    const result = await promise;
    expect(result.outcome).toBe("quit");
    expect(onCancelRequest).not.toHaveBeenCalled();
  });

  it("pages past nine repos with explicit bracket keys", async () => {
    const { events, push, close } = createEventSource();
    const mock = createMockEnvironment();
    const repoNames = Array.from({ length: 12 }, (_, i) => `repo-${i}`);

    const promise = renderSetupGrid({
      events,
      repoNames,
      mode: "watch",
      environment: mock.environment,
    });
    push({
      kind: "run-start",
      command: "new",
      repos: repoNames,
      scope: "workspace",
      pid: 1,
    });
    await tick();

    // Page one renders the first nine panes in a 3×3 grid.
    const first = mock.grids[0];
    expect(first?.rows).toBe(3);
    expect(first?.cols).toBe(3);
    expect(first?.panes.get(0)?.labels.map(stripTags).at(-1)).toContain(
      "repo-0",
    );
    expect(
      mock.statusContents
        .map(stripTags)
        .some((line) => line.includes("page 1/2")),
    ).toBe(true);

    mock.press("]");
    await tick();

    // Page two holds the remaining three panes (a smaller grid shape).
    const second = mock.grids.at(-1);
    expect(second).not.toBe(first);
    expect(second?.panes.get(0)?.labels.map(stripTags).at(-1)).toContain(
      "repo-9",
    );
    expect(
      mock.statusContents
        .map(stripTags)
        .some((line) => line.includes("page 2/2")),
    ).toBe(true);

    mock.press("[");
    await tick();
    expect(
      mock.grids.at(-1)?.panes.get(0)?.labels.map(stripTags).at(-1),
    ).toContain("repo-0");

    close();
    await promise;
  });

  it("zooms the focused pane on enter and restores on escape", async () => {
    const { events, push, close } = createEventSource();
    const mock = createMockEnvironment();

    const promise = renderSetupGrid({
      events,
      repoNames: ["front", "api"],
      mode: "watch",
      environment: mock.environment,
    });
    push({
      kind: "run-start",
      command: "new",
      repos: ["front", "api"],
      scope: "workspace",
      pid: 1,
    });
    await tick();

    mock.press("right");
    mock.press("enter");
    const grid = mock.grids[0];
    expect(grid?.zoomCalls.at(-1)).toBe(1);

    mock.press("escape");
    expect(grid?.zoomCalls.at(-1)).toBeNull();

    close();
    await promise;
  });

  it("fits every pane on one page when the terminal is large enough", async () => {
    const { events, push, close } = createEventSource();
    // 200×41 holds a 6×5 of minimum panes, so 12 repos need no paging.
    const mock = createMockEnvironment({ width: 200, height: 41 });
    const repoNames = Array.from({ length: 12 }, (_, i) => `repo-${i}`);

    const promise = renderSetupGrid({
      events,
      repoNames,
      mode: "watch",
      environment: mock.environment,
    });
    push({
      kind: "run-start",
      command: "new",
      repos: repoNames,
      scope: "workspace",
      pid: 1,
    });
    await tick();

    const grid = mock.grids[0];
    expect(grid?.rows).toBe(3);
    expect(grid?.cols).toBe(4);
    expect(grid?.panes.get(11)?.labels.map(stripTags).at(-1)).toContain(
      "repo-11",
    );
    expect(
      mock.statusContents.map(stripTags).some((line) => line.includes("page")),
    ).toBe(false);

    close();
    await promise;
  });

  it("opens the help overlay on ? and swallows the dismissing key", async () => {
    const { events, push, close } = createEventSource();
    const mock = createMockEnvironment();
    const onCancelRequest = vi.fn();

    const promise = renderSetupGrid({
      events,
      repoNames: ["front"],
      mode: "until-ready",
      onCancelRequest,
      environment: mock.environment,
    });
    push({
      kind: "run-start",
      command: "new",
      repos: ["front"],
      scope: "workspace",
      pid: 1,
    });
    await tick();

    expect(
      mock.statusContents
        .map(stripTags)
        .some((line) => line.includes("[?] help")),
    ).toBe(true);

    mock.pressChar("?");
    expect(mock.helpCalls).toHaveLength(1);
    const helpText = mock.helpCalls[0]?.map(stripTags).join("\n") ?? "";
    expect(helpText).toContain("zoom");
    expect(helpText).toContain("detach");
    expect(helpText).toContain("cancel");

    // Any key closes the overlay without acting: "q" here must not cancel.
    mock.press("q");
    expect(mock.helpDestroys).toBe(1);
    expect(onCancelRequest).not.toHaveBeenCalled();

    // With the overlay closed, "q" acts again.
    mock.press("q");
    expect(onCancelRequest).toHaveBeenCalledTimes(1);

    push({ kind: "run-end", outcome: "failed", durationMs: 1_000 });
    close();
    await promise;
  });

  it("reflows the grid when the terminal resizes", async () => {
    const { events, push, close } = createEventSource();
    const mock = createMockEnvironment();

    const promise = renderSetupGrid({
      events,
      repoNames: ["front"],
      mode: "watch",
      environment: mock.environment,
    });
    push({
      kind: "run-start",
      command: "new",
      repos: ["front"],
      scope: "workspace",
      pid: 1,
    });
    await tick();

    const before = mock.grids[0]?.reflowCalls ?? 0;
    mock.resize();
    expect(mock.grids[0]?.reflowCalls).toBe(before + 1);

    close();
    await promise;
  });

  it("renders panes from the emulator-styled tail instead of the plain tail", async () => {
    const { events, push } = createEventSource();
    const mock = createMockEnvironment();

    const promise = renderSetupGrid({
      events,
      repoNames: ["front"],
      mode: "until-ready",
      environment: mock.environment,
    });
    push({
      kind: "run-start",
      command: "new",
      repos: ["front"],
      scope: "workspace",
      pid: 1,
    });
    push({
      kind: "step-output",
      repo: "front",
      step: "init:pnpm-install",
      chunk: "\x1b[32mok\x1b[0m done\r\n",
    });
    push({ kind: "run-end", outcome: "ready", durationMs: 1_000 });
    await tick();
    await tick();

    const grid = mock.grids[0];
    const frontPane = grid?.panes.get(0);
    const rendered = frontPane?.contents.join("\n") ?? "";
    expect(rendered).toContain("ok");
    expect(rendered).toContain("done");
    expect(rendered).toContain("\x1b[32m");

    mock.press("x");
    await promise;
  });
});
