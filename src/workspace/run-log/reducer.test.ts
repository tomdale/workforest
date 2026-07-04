import { describe, expect, it } from "vitest";
import type { RunEvent, RunEventBody } from "./events.ts";
import { createRunReducer } from "./reducer.ts";

let seq = 0;
function event(body: RunEventBody, ts = "2026-07-03T10:00:00.000Z"): RunEvent {
  seq += 1;
  return { v: 1, runId: "run-1", src: "cli", seq, ts, ...body };
}

describe("createRunReducer", () => {
  it("seeds all repos as pending from run-start", () => {
    const reducer = createRunReducer();
    reducer.apply(
      event({
        kind: "run-start",
        command: "new",
        repos: ["api", "docs"],
        scope: "workspace",
        pid: 123,
      }),
    );

    const snapshot = reducer.snapshot();
    expect([...snapshot.repos.keys()]).toEqual(["api", "docs"]);
    expect(snapshot.repos.get("api")?.status).toBe("pending");
    expect(snapshot.command).toBe("new");
  });

  it("tracks step lifecycle with durations and ordering", () => {
    const reducer = createRunReducer();
    reducer.apply(
      event({
        kind: "step-start",
        repo: "api",
        step: "git:mirror",
        title: "mirror",
      }),
    );
    reducer.apply(
      event({
        kind: "step-end",
        repo: "api",
        step: "git:mirror",
        outcome: "ok",
        durationMs: 2100,
      }),
    );
    reducer.apply(
      event({
        kind: "step-start",
        repo: "api",
        step: "git:worktree",
        title: "worktree",
      }),
    );

    const repo = reducer.snapshot().repos.get("api");
    expect(repo?.status).toBe("running");
    expect(repo?.steps.map((step) => step.step)).toEqual([
      "git:mirror",
      "git:worktree",
    ]);
    expect(repo?.steps[0]).toMatchObject({
      status: "ok",
      durationMs: 2100,
      title: "mirror",
    });
    expect(repo?.steps[1]?.status).toBe("running");
  });

  it("collects output tail with carriage-return collapsing", () => {
    const reducer = createRunReducer();
    reducer.apply(
      event({
        kind: "step-start",
        repo: "api",
        step: "init:pnpm-install",
        title: "install",
      }),
    );
    reducer.apply(
      event({
        kind: "step-output",
        repo: "api",
        step: "init:pnpm-install",
        chunk: "progress 10%\rprogress 50%\rprogress 100%\nresolved 1204\n",
      }),
    );

    const repo = reducer.snapshot().repos.get("api");
    expect(repo?.tail).toEqual(["progress 100%", "resolved 1204"]);
  });

  it("resets the tail on step-retry so output is not misattributed", () => {
    const reducer = createRunReducer();
    reducer.apply(
      event({
        kind: "step-start",
        repo: "api",
        step: "git:mirror",
        title: "mirror",
      }),
    );
    reducer.apply(
      event({
        kind: "step-output",
        repo: "api",
        step: "git:mirror",
        chunk: "stale attempt output\n",
      }),
    );
    reducer.apply(
      event({
        kind: "step-retry",
        repo: "api",
        step: "git:mirror",
        attempt: 2,
        reason: "network reset",
      }),
    );

    const repo = reducer.snapshot().repos.get("api");
    expect(repo?.tail).toEqual(["Retry 2: network reset"]);
    expect(repo?.steps[0]).toMatchObject({ status: "retrying", attempt: 2 });
  });

  it("records failures with step attribution", () => {
    const reducer = createRunReducer();
    reducer.apply(
      event({
        kind: "step-start",
        repo: "api",
        step: "git:mirror",
        title: "mirror",
      }),
    );
    reducer.apply(
      event({
        kind: "step-end",
        repo: "api",
        step: "git:mirror",
        outcome: "failed",
        durationMs: 400,
        error: { message: "clone exited with code 128" },
      }),
    );
    reducer.apply(
      event({
        kind: "repo-end",
        repo: "api",
        outcome: "failed",
        step: "git:mirror",
        error: { message: "clone exited with code 128" },
      }),
    );

    const repo = reducer.snapshot().repos.get("api");
    expect(repo?.status).toBe("failed");
    expect(repo?.failedStep).toBe("git:mirror");
    expect(repo?.error).toBe("clone exited with code 128");
  });

  it("tracks handoff, lockfile detection, and run completion", () => {
    const reducer = createRunReducer();
    reducer.apply(
      event({ kind: "worktree-ready", repo: "api", hasLockfile: true }),
    );
    reducer.apply(event({ kind: "repo-handoff", repo: "api", workerPid: 42 }));

    expect(reducer.snapshot().repos.get("api")).toMatchObject({
      status: "handed-off",
      hasLockfile: true,
    });

    reducer.apply(
      event({
        kind: "repo-end",
        repo: "api",
        outcome: "ready",
        hasLockfile: true,
      }),
    );
    reducer.apply(
      event({ kind: "run-end", outcome: "ready", durationMs: 61000 }),
    );

    const snapshot = reducer.snapshot();
    expect(snapshot.repos.get("api")?.status).toBe("ready");
    expect(snapshot.outcome).toBe("ready");
    expect(snapshot.durationMs).toBe(61000);
  });

  it("routes workspace-scoped events to workspace steps and tail", () => {
    const reducer = createRunReducer();
    reducer.apply(
      event({
        kind: "step-start",
        repo: null,
        step: "hook:seed-env",
        title: "seed-env",
      }),
    );
    reducer.apply(
      event({
        kind: "step-output",
        repo: null,
        step: "hook:seed-env",
        chunk: "pulled 12 env vars\n",
      }),
    );
    reducer.apply(
      event({
        kind: "step-end",
        repo: null,
        step: "hook:seed-env",
        outcome: "ok",
        durationMs: 900,
      }),
    );

    const snapshot = reducer.snapshot();
    expect(snapshot.workspaceSteps).toHaveLength(1);
    expect(snapshot.workspaceSteps[0]).toMatchObject({
      step: "hook:seed-env",
      status: "ok",
    });
    expect(snapshot.workspaceTail).toEqual(["pulled 12 env vars"]);
    expect(snapshot.repos.size).toBe(0);
  });

  it("caps the retained tail at the configured line budget", () => {
    const reducer = createRunReducer({ tailLines: 3 });
    reducer.apply(
      event({
        kind: "step-output",
        repo: "api",
        step: "init:pnpm-install",
        chunk: "one\ntwo\nthree\nfour\nfive\n",
      }),
    );

    expect(reducer.snapshot().repos.get("api")?.tail).toEqual([
      "three",
      "four",
      "five",
    ]);
  });
});
