import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import type {
  RepoRunSnapshot,
  RunSnapshot,
  StepSnapshot,
} from "../../workspace/run-log/reducer.ts";
import {
  buildHelpLines,
  buildStatusLine,
  formatElapsed,
  paneLabel,
  renderPaneLines,
  WORKSPACE_PANE_NAME,
  workspacePaneSnapshot,
} from "./model.ts";

function stripTags(value: string): string {
  return value.replace(/\{[^}]*\}/g, "");
}

function step(overrides: Partial<StepSnapshot> = {}): StepSnapshot {
  return {
    step: "git:mirror",
    title: "mirror",
    status: "ok",
    durationMs: 2_100,
    attempt: 1,
    ...overrides,
  };
}

/** A step still in flight: no durationMs, only a start timestamp. */
function liveStep(
  status: "running" | "retrying",
  overrides: Partial<StepSnapshot> = {},
): StepSnapshot {
  return {
    step: "git:mirror",
    title: "mirror",
    status,
    startedAtMs: 0,
    attempt: 1,
    ...overrides,
  };
}

function repo(overrides: Partial<RepoRunSnapshot> = {}): RepoRunSnapshot {
  return {
    repo: "front",
    status: "running",
    steps: [],
    tail: [],
    ...overrides,
  };
}

function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    repos: new Map(),
    workspaceSteps: [],
    workspaceTail: [],
    ...overrides,
  };
}

describe("formatElapsed", () => {
  it.each([
    [500, "500ms"],
    [2_100, "2.1s"],
    [102_000, "1:42"],
  ])("formats %ims as %s", (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected);
  });
});

describe("renderPaneLines", () => {
  it("renders a checklist row per step with glyphs and durations", () => {
    const lines = renderPaneLines(
      repo({
        steps: [
          step(),
          liveStep("running", {
            step: "init:pnpm-install",
            title: "pnpm install",
            startedAtMs: 10_000,
          }),
        ],
      }),
      { width: 40, height: 10 },
      44_000,
    ).map(stripTags);

    expect(lines[0]).toContain("mirror");
    expect(lines[0]).toContain("2.1s");
    // Running steps tick against nowMs.
    expect(lines[1]).toContain("pnpm install");
    expect(lines[1]).toContain("34.0s");
  });

  it("marks retrying steps with their attempt", () => {
    const lines = renderPaneLines(
      repo({
        steps: [liveStep("retrying", { attempt: 2 })],
      }),
      { width: 60, height: 10 },
      5_000,
    ).map(stripTags);

    expect(lines[0]).toContain("(retry 2)");
  });

  it("shows a queued placeholder before any step starts", () => {
    const lines = renderPaneLines(
      repo({ status: "pending" }),
      { width: 40, height: 6 },
      0,
    ).map(stripTags);
    expect(lines[0]).toBe("Queued");
  });

  it("appends the failure message and the newest tail lines that fit", () => {
    const lines = renderPaneLines(
      repo({
        status: "failed",
        error: "pnpm install exited with code 1",
        steps: [step({ status: "failed" })],
        tail: ["one", "two", "three", "four"],
      }),
      { width: 40, height: 6 },
      0,
    ).map(stripTags);

    expect(lines.some((line) => line.includes("pnpm install exited"))).toBe(
      true,
    );
    // Divider plus the newest tail lines that fit the remaining height.
    expect(lines.some((line) => line.startsWith("─"))).toBe(true);
    expect(lines.at(-1)).toBe("four");
    expect(lines.length).toBeLessThanOrEqual(6);
  });

  it("renders tail lines at exactly the pane content width", () => {
    // The pane content width here is `size.width` itself (renderPaneLines
    // truncates tail lines to the full pane width); the content ScrollableBox
    // that actually displays them is one column narrower, which is a
    // separate concern owned by grid-layout.ts.
    const width = 20;
    const exact = "x".repeat(width);
    const overflow = "x".repeat(width + 1);

    const exactLines = renderPaneLines(
      repo({ tail: [exact] }),
      { width, height: 4 },
      0,
    ).map(stripTags);
    expect(exactLines.at(-1)).toBe(exact);
    expect(exactLines.at(-1)?.endsWith("…")).toBe(false);

    const overflowLines = renderPaneLines(
      repo({ tail: [overflow] }),
      { width, height: 4 },
      0,
    ).map(stripTags);
    const last = overflowLines.at(-1) ?? "";
    expect(last.endsWith("…")).toBe(true);
    expect(stringWidth(last)).toBe(width);
  });

  it("prefers styledTail over repo.tail when non-empty", () => {
    const lines = renderPaneLines(
      repo({ tail: ["from reducer"] }),
      { width: 40, height: 6 },
      0,
      ["from emulator"],
    ).map(stripTags);

    expect(lines.some((line) => line.includes("from emulator"))).toBe(true);
    expect(lines.some((line) => line.includes("from reducer"))).toBe(false);
  });

  it("carries SGR codes from styledTail through into the rendered string", () => {
    const lines = renderPaneLines(
      repo({ tail: [] }),
      { width: 40, height: 6 },
      0,
      ["\x1b[32mok\x1b[0m"],
    );

    expect(lines.some((line) => line.includes("\x1b[32m"))).toBe(true);
  });

  it("escapes a literal brace in styledTail instead of parsing it as a tag", () => {
    const lines = renderPaneLines(
      repo({ tail: [] }),
      { width: 40, height: 6 },
      0,
      ["{not a tag}"],
    );

    expect(lines.some((line) => line.includes("{open}"))).toBe(true);
    expect(lines.some((line) => line.includes("{close}"))).toBe(true);
  });

  it("falls back to repo.tail when styledTail is null or empty", () => {
    const nullTail = renderPaneLines(
      repo({ tail: ["from reducer"] }),
      { width: 40, height: 6 },
      0,
      null,
    ).map(stripTags);
    expect(nullTail.some((line) => line.includes("from reducer"))).toBe(true);

    const emptyTail = renderPaneLines(
      repo({ tail: ["from reducer"] }),
      { width: 40, height: 6 },
      0,
      [],
    ).map(stripTags);
    expect(emptyTail.some((line) => line.includes("from reducer"))).toBe(true);
  });

  it("never exceeds the pane height", () => {
    const lines = renderPaneLines(
      repo({
        steps: Array.from({ length: 12 }, (_, i) =>
          step({ step: `init:${i}`, title: `step-${i}` }),
        ),
        tail: ["tail"],
      }),
      { width: 40, height: 5 },
      0,
    );
    expect(lines.length).toBeLessThanOrEqual(5);
  });
});

describe("paneLabel", () => {
  it("labels an active repo with its running step and elapsed time", () => {
    const label = stripTags(
      paneLabel(
        repo({
          steps: [liveStep("running")],
        }),
        2_100,
      ),
    );
    expect(label).toContain("front");
    expect(label).toContain("mirror");
    expect(label).toContain("2.1s");
  });

  it("labels terminal repos with their outcome glyph", () => {
    expect(stripTags(paneLabel(repo({ status: "ready" }), 0))).toContain(
      "front",
    );
    expect(stripTags(paneLabel(repo({ status: "failed" }), 0))).toContain("✗");
    expect(stripTags(paneLabel(repo({ status: "cancelled" }), 0))).toContain(
      "⊘",
    );
  });
});

describe("workspacePaneSnapshot", () => {
  it("returns null while no workspace-scoped work is recorded", () => {
    expect(workspacePaneSnapshot(run())).toBeNull();
  });

  it("projects workspace steps onto a repo-shaped pane", () => {
    const snapshot = workspacePaneSnapshot(
      run({
        workspaceSteps: [
          step({ step: "hook:lint", title: "lint", status: "running" }),
        ],
        workspaceTail: ["hook output"],
      }),
    );
    expect(snapshot?.repo).toBe(WORKSPACE_PANE_NAME);
    expect(snapshot?.status).toBe("running");
    expect(snapshot?.tail).toEqual(["hook output"]);
  });
});

describe("buildStatusLine", () => {
  const snapshot = run({
    startedAtMs: 0,
    repos: new Map([
      ["a", repo({ repo: "a", status: "ready" })],
      ["b", repo({ repo: "b", status: "failed" })],
      ["c", repo({ repo: "c", status: "running" })],
    ]),
  });

  it("summarizes readiness, failures, elapsed time, and key hints", () => {
    const line = stripTags(
      buildStatusLine({
        snapshot,
        repoNames: ["a", "b", "c"],
        page: 0,
        pageCount: 1,
        zoomed: false,
        mode: "until-ready",
        canDetach: true,
        cancelRequested: false,
        nowMs: 102_000,
      }),
    );
    expect(line).toContain("1/3 ready");
    expect(line).toContain("1 failed");
    expect(line).toContain("1:42 elapsed");
    expect(line).toContain("[enter] zoom");
    expect(line).toContain("[d] detach");
    expect(line).toContain("[q] cancel");
    expect(line).toContain("[?] help");
    expect(line).not.toContain("page");
  });

  it("shows the page position and paging hint when panes overflow", () => {
    const line = stripTags(
      buildStatusLine({
        snapshot,
        repoNames: ["a", "b", "c"],
        page: 1,
        pageCount: 2,
        zoomed: false,
        mode: "watch",
        canDetach: false,
        cancelRequested: false,
        nowMs: 0,
      }),
    );
    expect(line).toContain("page 2/2");
    expect(line).toContain("[ ] page");
    expect(line).toContain("[q] quit");
    expect(line).not.toContain("detach");
  });

  it("replaces everything with the cancel warning once cancelling", () => {
    const line = stripTags(
      buildStatusLine({
        snapshot,
        repoNames: ["a"],
        page: 0,
        pageCount: 1,
        zoomed: false,
        mode: "until-ready",
        canDetach: true,
        cancelRequested: true,
        nowMs: 0,
      }),
    );
    expect(line).toBe("Cancelling, press Ctrl-C again to force");
  });

  it("offers esc back while zoomed", () => {
    const line = stripTags(
      buildStatusLine({
        snapshot,
        repoNames: ["a"],
        page: 0,
        pageCount: 1,
        zoomed: true,
        mode: "until-ready",
        canDetach: true,
        cancelRequested: false,
        nowMs: 0,
      }),
    );
    expect(line).toContain("[esc] back");
    expect(line).toContain("[?] help");
    expect(line).not.toContain("[enter] zoom");
  });
});

describe("buildHelpLines", () => {
  it("lists the full keymap for an attached run", () => {
    const text = buildHelpLines({ mode: "until-ready", canDetach: true })
      .map(stripTags)
      .join("\n");
    expect(text).toContain("move focus between panes");
    expect(text).toContain("zoom the focused pane");
    expect(text).toContain("previous / next page");
    expect(text).toContain("detach; setup continues in the background");
    expect(text).toContain("cancel setup");
    expect(text).toContain("press any key to close");
  });

  it("swaps cancel for quit in watch mode and hides detach when unavailable", () => {
    const text = buildHelpLines({ mode: "watch", canDetach: false })
      .map(stripTags)
      .join("\n");
    expect(text).toContain("quit watching; setup keeps running");
    expect(text).not.toContain("detach");
    expect(text).not.toContain("cancel setup");
  });
});
