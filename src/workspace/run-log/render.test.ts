import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import type { RunEvent, RunEventBody, RunManifest } from "./events.ts";
import { formatDuration, renderRunList, renderRunLog } from "./render.ts";

let seq = 0;
function event(body: RunEventBody): RunEvent {
  seq += 1;
  return {
    v: 1,
    runId: "20260704-100000-abc123",
    src: "cli",
    seq,
    ts: "2026-07-04T10:00:00.000Z",
    ...body,
  };
}

const manifest: RunManifest = {
  v: 1,
  runId: "20260704-100000-abc123",
  startedAt: "2026-07-04T10:00:00.000Z",
  command: "new",
  repos: ["api"],
  scopeKind: "workspace",
};

const sampleEvents: RunEvent[] = [
  event({
    kind: "run-start",
    command: "new",
    repos: ["api"],
    scope: "workspace",
    pid: 1,
  }),
  event({
    kind: "step-start",
    repo: "api",
    step: "git:mirror",
    title: "mirror",
  }),
  event({
    kind: "step-output",
    repo: "api",
    step: "git:mirror",
    chunk: "Receiving objects: 100%\n",
  }),
  event({
    kind: "step-end",
    repo: "api",
    step: "git:mirror",
    outcome: "ok",
    durationMs: 2100,
  }),
  event({
    kind: "step-start",
    repo: "api",
    step: "init:pnpm-install",
    title: "pnpm install",
  }),
  event({
    kind: "step-end",
    repo: "api",
    step: "init:pnpm-install",
    outcome: "failed",
    durationMs: 12400,
    error: { message: "pnpm install exited with code 1" },
  }),
  event({
    kind: "repo-end",
    repo: "api",
    outcome: "failed",
    step: "init:pnpm-install",
    error: { message: "pnpm install exited with code 1" },
  }),
  event({
    kind: "step-start",
    repo: null,
    step: "hook:seed-env",
    title: "seed-env",
  }),
  event({
    kind: "step-end",
    repo: null,
    step: "hook:seed-env",
    outcome: "ok",
    durationMs: 900,
  }),
  event({ kind: "run-end", outcome: "failed", durationMs: 61000 }),
];

describe("renderRunLog", () => {
  it("renders steps per repo with durations, output, and failures", () => {
    const output = stripAnsi(renderRunLog(sampleEvents, manifest));

    expect(output).toContain("Run 20260704-100000-abc123");
    expect(output).toContain("api");
    expect(output).toContain("mirror");
    expect(output).toContain("2.1s");
    expect(output).toContain("Receiving objects: 100%");
    expect(output).toContain("pnpm install");
    expect(output).toContain("Error: pnpm install exited with code 1");
    expect(output).toContain("workspace");
    expect(output).toContain("seed-env");
    expect(output).toContain("failed in 1:01");
  });

  it("filters by repo and step", () => {
    const output = stripAnsi(
      renderRunLog(sampleEvents, manifest, {
        repo: "api",
        step: "git:mirror",
      }),
    );

    expect(output).toContain("mirror");
    expect(output).not.toContain("pnpm install");
    expect(output).not.toContain("seed-env");
  });

  it("reports an empty state when nothing matches", () => {
    const output = stripAnsi(
      renderRunLog(sampleEvents, manifest, { repo: "nope" }),
    );
    expect(output).toContain("No matching events in this run.");
  });
});

describe("renderRunList", () => {
  it("lists runs with outcomes and shows an empty state", () => {
    const listed = stripAnsi(renderRunList([{ manifest, outcome: "failed" }]));
    expect(listed).toContain("20260704-100000-abc123");
    expect(listed).toContain("failed");

    expect(stripAnsi(renderRunList([]))).toContain(
      "No recorded setup runs for this selector.",
    );
  });
});

describe("formatDuration", () => {
  it("scales units readably", () => {
    expect(formatDuration(450)).toBe("450ms");
    expect(formatDuration(2100)).toBe("2.1s");
    expect(formatDuration(61000)).toBe("1:01");
    expect(formatDuration(3_720_000)).toBe("1h02m");
  });
});
