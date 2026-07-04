import { describe, expect, it } from "vitest";
import type { RunEvent, RunEventBody } from "../../workspace/run-log/events.ts";
import { createRunEventConsoleRenderer } from "./console.ts";

let seq = 0;
function event(body: RunEventBody): RunEvent {
  seq += 1;
  return {
    v: 1,
    runId: "run",
    src: "cli",
    seq,
    ts: new Date(seq).toISOString(),
    ...body,
  };
}

describe("createRunEventConsoleRenderer", () => {
  it("renders step outcomes with titles and durations", () => {
    const renderer = createRunEventConsoleRenderer();
    renderer.render(
      event({
        kind: "step-start",
        repo: "front",
        step: "git:mirror",
        title: "mirror",
      }),
    );
    const lines = renderer.render(
      event({
        kind: "step-end",
        repo: "front",
        step: "git:mirror",
        outcome: "ok",
        durationMs: 2_100,
      }),
    );
    expect(lines).toEqual([
      { level: "info", message: "front: mirror ok 2.1s" },
    ]);
  });

  it("renders retries as warnings", () => {
    const renderer = createRunEventConsoleRenderer();
    renderer.render(
      event({
        kind: "step-start",
        repo: "front",
        step: "git:mirror",
        title: "mirror",
      }),
    );
    const lines = renderer.render(
      event({
        kind: "step-retry",
        repo: "front",
        step: "git:mirror",
        attempt: 2,
        reason: "network flake",
      }),
    );
    expect(lines).toEqual([
      { level: "warning", message: "front: mirror retry 2: network flake" },
    ]);
  });

  it("renders repo outcomes, handoffs, and run end lines", () => {
    const renderer = createRunEventConsoleRenderer();
    expect(
      renderer.render(
        event({ kind: "repo-handoff", repo: "front", workerPid: 42 }),
      )[0]?.message,
    ).toContain("initialization continues in the background");
    expect(
      renderer.render(
        event({ kind: "repo-end", repo: "front", outcome: "ready" }),
      ),
    ).toEqual([{ level: "success", message: "front: ready" }]);

    const failed = renderer.render(
      event({
        kind: "repo-end",
        repo: "api",
        outcome: "failed",
        error: { message: "boom" },
      }),
    );
    expect(failed[0]).toEqual({
      level: "error",
      message: "api: failed: boom",
    });
    expect(failed[1]?.message).toContain("wf init logs --repo api");

    expect(
      renderer.render(
        event({ kind: "run-end", outcome: "ready", durationMs: 102_000 }),
      ),
    ).toEqual([{ level: "success", message: "Setup complete in 1:42" }]);
  });

  it("drops subprocess output unless verbose", () => {
    const quiet = createRunEventConsoleRenderer();
    expect(
      quiet.render(
        event({
          kind: "step-output",
          repo: "front",
          step: "init:pnpm-install",
          chunk: "Progress: resolved 100\n",
        }),
      ),
    ).toEqual([]);
  });

  it("streams verbose output prefixed with the repo name", () => {
    const renderer = createRunEventConsoleRenderer({ verbose: true });
    const first = renderer.render(
      event({
        kind: "step-output",
        repo: "front",
        step: "init:pnpm-install",
        chunk: "resolved 100\npartial",
      }),
    );
    expect(first).toEqual([{ level: "info", message: "front │ resolved 100" }]);

    // The partial line completes with the next chunk.
    const second = renderer.render(
      event({
        kind: "step-output",
        repo: "front",
        step: "init:pnpm-install",
        chunk: " line\n",
      }),
    );
    expect(second).toEqual([
      { level: "info", message: "front │ partial line" },
    ]);
  });

  it("labels workspace-scoped steps as workspace", () => {
    const renderer = createRunEventConsoleRenderer();
    renderer.render(
      event({
        kind: "step-start",
        repo: null,
        step: "hook:lint",
        title: "lint",
      }),
    );
    const lines = renderer.render(
      event({
        kind: "step-end",
        repo: null,
        step: "hook:lint",
        outcome: "ok",
        durationMs: 500,
      }),
    );
    expect(lines[0]?.message).toBe("workspace: lint ok 500ms");
  });
});
