import { describe, expect, it, vi } from "vitest";
import type {
  RepoRunSnapshot,
  RunSnapshot,
} from "../../workspace/run-log/reducer.ts";
import { formatRunSummary, printRunSummary } from "./summary.ts";

function repo(overrides: Partial<RepoRunSnapshot> = {}): RepoRunSnapshot {
  return {
    repo: "front",
    status: "ready",
    steps: [
      {
        step: "git:mirror",
        title: "mirror",
        status: "ok",
        durationMs: 2_100,
        attempt: 1,
      },
      {
        step: "init:pnpm-install",
        title: "pnpm install",
        status: "ok",
        durationMs: 30_000,
        attempt: 1,
      },
    ],
    tail: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    repos: new Map([["front", repo()]]),
    workspaceSteps: [],
    workspaceTail: [],
    startedAtMs: 0,
    durationMs: 102_000,
    outcome: "ready",
    ...overrides,
  };
}

describe("formatRunSummary", () => {
  it("renders the success heading, target path, timings, and next steps", () => {
    const summary = formatRunSummary({
      snapshot: snapshot(),
      targetDir: "/ws/billing",
      outcome: "ready",
      nextSteps: ["cd /ws/billing", "wf status --watch"],
      nowMs: 102_000,
    });

    expect(summary).toContain("Setup complete in 1:42");
    expect(summary).toContain("/ws/billing");
    expect(summary).toContain("front");
    // Every repo landed ready, so the redundant label column is dropped and
    // the glyph carries the outcome.
    expect(summary).not.toContain("ready");
    // Total repo duration is the sum of its step durations.
    expect(summary).toContain("32.1s");
    expect(summary).toContain("Next steps");
    expect(summary).toContain("wf status --watch");
  });

  it("keeps outcome labels when outcomes are mixed", () => {
    const summary = formatRunSummary({
      snapshot: snapshot({
        outcome: "failed",
        repos: new Map([
          ["front", repo()],
          ["api", repo({ repo: "api", status: "failed", error: "boom" })],
        ]),
      }),
      targetDir: "/ws/billing",
      outcome: "failed",
      nowMs: 102_000,
    });

    expect(summary).toContain("ready");
    expect(summary).toContain("failed");
  });

  it("lists failures with wf init logs pointers", () => {
    const summary = formatRunSummary({
      snapshot: snapshot({
        outcome: "failed",
        repos: new Map([
          ["front", repo()],
          [
            "api",
            repo({
              repo: "api",
              status: "failed",
              error: "pnpm install exited with code 1",
              failedStep: "init:pnpm-install",
            }),
          ],
        ]),
      }),
      targetDir: "/ws/billing",
      outcome: "failed",
      nowMs: 102_000,
    });

    expect(summary).toContain("Setup failed");
    expect(summary).toContain("Failures");
    expect(summary).toContain("api (init:pnpm-install): pnpm install exited");
    expect(summary).toContain("wf init logs --repo api");
  });

  it("points detached runs at wf status --watch", () => {
    const { outcome: _outcome, durationMs: _durationMs, ...live } = snapshot();
    const summary = formatRunSummary({
      snapshot: live,
      targetDir: "/ws/billing",
      outcome: "detached",
      nowMs: 10_000,
    });

    expect(summary).toContain("Setup continues in the background");
    expect(summary).toContain("wf status --watch");
  });

  it("includes failed workspace steps", () => {
    const summary = formatRunSummary({
      snapshot: snapshot({
        outcome: "failed",
        workspaceSteps: [
          {
            step: "hook:lint",
            title: "lint",
            status: "failed",
            durationMs: 900,
            attempt: 1,
            lastMessage: "lint exploded",
          },
        ],
      }),
      targetDir: "/ws/billing",
      outcome: "failed",
      nowMs: 0,
    });
    expect(summary).toContain("workspace lint: lint exploded");
  });

  it("marks cancelled repos in the outcome table", () => {
    const summary = formatRunSummary({
      snapshot: snapshot({
        outcome: "cancelled",
        repos: new Map([["front", repo({ status: "cancelled", steps: [] })]]),
      }),
      targetDir: "/ws/billing",
      outcome: "cancelled",
      nowMs: 0,
    });
    expect(summary).toContain("Setup cancelled");
    expect(summary).toContain("cancelled");
  });
});

describe("printRunSummary", () => {
  it("writes the formatted summary through the injected writer", () => {
    const write = vi.fn();
    printRunSummary(
      {
        snapshot: snapshot(),
        targetDir: "/ws/billing",
        outcome: "ready",
        nowMs: 0,
      },
      write,
    );
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toContain("/ws/billing");
  });
});
