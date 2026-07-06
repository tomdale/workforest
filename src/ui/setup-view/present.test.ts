import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceEvent } from "../../services/events.ts";
import { workspaceInitializationScope } from "../../workspace/initialization-scope.ts";
import type { RepoPipelineState } from "../../workspace/pipeline.ts";
import {
  createRunSession,
  type RunSession,
} from "../../workspace/run-log/session.ts";
import type { SetupViewEnvironment } from "./grid-view.ts";
import { presentRun } from "./present.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createFixture(): Promise<{
  session: RunSession;
  scope: ReturnType<typeof workspaceInitializationScope>;
  workspaceDir: string;
}> {
  const workspaceDir = await mkdtemp(
    path.join(os.tmpdir(), "workforest-present-"),
  );
  tempDirs.push(workspaceDir);
  const scope = workspaceInitializationScope(workspaceDir);
  const session = await createRunSession({
    scope,
    command: "new",
    repos: ["front"],
  });
  return { session, scope, workspaceDir };
}

function passiveEnvironment(): SetupViewEnvironment {
  let keypress:
    | ((ch: string | undefined, key: { name?: string } | undefined) => void)
    | null = null;
  return {
    createScreen: () => ({
      onKeypress: (handler) => {
        keypress = handler;
      },
      render: vi.fn(),
      destroy: vi.fn(),
    }),
    createGrid: () => ({
      getPane: () => ({
        setLabel: vi.fn(),
        setContent: vi.fn(),
      }),
      render: vi.fn(),
      destroy: vi.fn(),
    }),
    // The completion modal stays up until a keypress; acknowledge it as soon
    // as it appears so tests resolve.
    createCompletionModal: () => {
      queueMicrotask(() => keypress?.(undefined, { name: "x" }));
      return { destroy: vi.fn() };
    },
    renderIntervalMs: 0,
  };
}

describe("presentRun console mode", () => {
  it("drives pipelines, prints per-event lines, and keeps the early-return contract", async () => {
    const { session, scope, workspaceDir } = await createFixture();
    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      session.emit({
        kind: "step-start",
        repo: "front",
        step: "git:mirror",
        title: "mirror",
      });
      session.emit({
        kind: "step-end",
        repo: "front",
        step: "git:mirror",
        outcome: "ok",
        durationMs: 2_100,
      });
      yield { phase: "worktree-ready", hasLockfile: true };
    };
    const events: ServiceEvent[] = [];
    const onBeforeCompletionPrompt = vi.fn();

    const result = await presentRun({
      session,
      scope,
      pipelines: new Map([["front", pipeline()]]),
      repoNames: ["front"],
      interactive: false,
      targetDir: workspaceDir,
      maxConcurrent: 2,
      onEvent: (event) => events.push(event),
      onBeforeCompletionPrompt,
    });

    expect(result.outcome).toBe("background");
    expect(result.results.get("front")).toEqual({ hasLockfile: true });
    expect(onBeforeCompletionPrompt).toHaveBeenCalledWith(result.results);
    const messages = events
      .filter(
        (event): event is Extract<ServiceEvent, { type: "message" }> =>
          event.type === "message",
      )
      .map((event) => event.message);
    expect(messages).toContain("front: mirror in 2.1s");
  });

  it("streams verbose output lines", async () => {
    const { session, scope, workspaceDir } = await createFixture();
    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      session.emit({
        kind: "step-start",
        repo: "front",
        step: "init:pnpm-install",
        title: "pnpm install",
      });
      session.emit({
        kind: "step-output",
        repo: "front",
        step: "init:pnpm-install",
        chunk: "resolved 100 packages\n",
      });
      yield { phase: "worktree-ready", hasLockfile: false };
    };
    const events: ServiceEvent[] = [];

    await presentRun({
      session,
      scope,
      pipelines: new Map([["front", pipeline()]]),
      repoNames: ["front"],
      interactive: false,
      verbose: true,
      targetDir: workspaceDir,
      maxConcurrent: 2,
      onEvent: (event) => events.push(event),
    });

    expect(
      events.some(
        (event) =>
          event.type === "message" &&
          event.message === "front │ resolved 100 packages",
      ),
    ).toBe(true);
  });
});

describe("presentRun attached grid mode", () => {
  it("stays attached until run-end and prints the scrollback summary", async () => {
    const { session, scope, workspaceDir } = await createFixture();
    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      session.emit({
        kind: "step-start",
        repo: "front",
        step: "git:mirror",
        title: "mirror",
      });
      session.emit({
        kind: "step-end",
        repo: "front",
        step: "git:mirror",
        outcome: "ok",
        durationMs: 2_100,
      });
      yield { phase: "worktree-ready", hasLockfile: true };
    };
    const summaries: string[] = [];

    const result = await presentRun({
      session,
      scope,
      pipelines: new Map([["front", pipeline()]]),
      repoNames: ["front"],
      interactive: true,
      targetDir: workspaceDir,
      maxConcurrent: 2,
      nextSteps: ["wf status --watch"],
      shouldUseGrid: () => true,
      environment: passiveEnvironment(),
      // Simulates the last worker finalizing: the driver's completion hook
      // records run-end, which the attached grid observes from the run log.
      onBeforeCompletionPrompt: () => {
        session.emit({
          kind: "repo-end",
          repo: "front",
          outcome: "ready",
          hasLockfile: true,
        });
        session.emit({ kind: "run-end", outcome: "ready", durationMs: 5_000 });
      },
      writeSummary: (text) => summaries.push(text),
    });

    expect(result.outcome).toBe("ready");
    const summary = summaries.join("");
    expect(summary).toContain("Setup complete");
    expect(summary).toContain(workspaceDir);
    expect(summary).toContain("wf status --watch");
  });
});
