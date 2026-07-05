import { describe, expect, it } from "vitest";
import type { RunEvent, RunEventBody } from "../../workspace/run-log/events.ts";
import { WORKSPACE_PANE_NAME } from "./model.ts";
import { TerminalTailStore } from "./terminal-tail.ts";

let seq = 0;
function event(body: RunEventBody): RunEvent {
  seq += 1;
  return {
    v: 1,
    runId: "run-1",
    src: "cli",
    seq,
    ts: "2026-07-04T10:00:00.000Z",
    ...body,
  };
}

function output(repo: string | null, chunk: string): RunEvent {
  return event({ kind: "step-output", repo, step: "init:pnpm-install", chunk });
}

describe("TerminalTailStore", () => {
  it("round-trips plain text lines", async () => {
    const store = new TerminalTailStore();
    await store.apply(output("api", "hello\r\n"));
    await store.apply(output("api", "world\r\n"));

    expect(store.linesFor("api")).toEqual(["hello", "world"]);
  });

  it("round-trips SGR color and resets at line end, plain lines stay plain", async () => {
    const store = new TerminalTailStore();
    await store.apply(output("api", "\x1b[31mred\x1b[0m plain\r\n"));
    await store.apply(output("api", "plain only\r\n"));

    const lines = store.linesFor("api");
    expect(lines).not.toBeNull();
    const [redLine, plainLine] = lines ?? [];
    expect(redLine).toBe("\x1b[31mred\x1b[0m plain\x1b[0m");
    expect(plainLine).toBe("plain only");
    expect(plainLine?.includes("\x1b")).toBe(false);
  });

  it("collapses \\r progress rewrites to the final state", async () => {
    const store = new TerminalTailStore();
    await store.apply(
      output("api", "Progress 1\rProgress 2\rProgress 2 done\r\n"),
    );

    expect(store.linesFor("api")).toEqual(["Progress 2 done"]);
  });

  it("handles cursor-up multi-line redraws (pnpm reporter pattern)", async () => {
    const store = new TerminalTailStore();
    await store.apply(output("api", "line A\r\nline B\r\n"));
    await store.apply(
      output("api", "\x1b[2A\x1b[2Kline A2\r\n\x1b[2Kline B2\r\n"),
    );

    expect(store.linesFor("api")).toEqual(["line A2", "line B2"]);
  });

  it("reassembles an escape sequence torn across two apply calls", async () => {
    const store = new TerminalTailStore();
    await store.apply(output("api", "hello \x1b[3"));
    await store.apply(output("api", "1mred\x1b[0m\r\n"));

    expect(store.linesFor("api")).toEqual(["hello \x1b[0m\x1b[31mred\x1b[0m"]);
  });

  it("resets the screen on step-retry and shows only the retry banner", async () => {
    const store = new TerminalTailStore();
    await store.apply(output("api", "attempt one output\r\n"));
    await store.apply(
      event({
        kind: "step-retry",
        repo: "api",
        step: "init:pnpm-install",
        attempt: 2,
        reason: "network timeout",
      }),
    );

    expect(store.linesFor("api")).toEqual(["Retry 2: network timeout"]);
  });

  it("keys workspace-scoped events (repo: null) under WORKSPACE_PANE_NAME", async () => {
    const store = new TerminalTailStore();
    await store.apply(output(null, "workspace hook output\r\n"));

    expect(store.linesFor(WORKSPACE_PANE_NAME)).toEqual([
      "workspace hook output",
    ]);
    expect(store.linesFor("workspace-not-the-real-key")).toBeNull();
  });

  it("returns null for an unknown key, and after dispose", async () => {
    const store = new TerminalTailStore();
    expect(store.linesFor("nope")).toBeNull();

    await store.apply(output("api", "hi\r\n"));
    expect(store.linesFor("api")).toEqual(["hi"]);

    store.dispose();
    expect(store.linesFor("api")).toBeNull();
  });

  it("ignores events without output semantics", async () => {
    const store = new TerminalTailStore();
    await store.apply(
      event({
        kind: "step-start",
        repo: "api",
        step: "init:pnpm-install",
        title: "install",
      }),
    );

    expect(store.linesFor("api")).toBeNull();
  });
});
