import { describe, expect, it } from "vitest";
import type { SingleRepoInitializerState } from "../../services/initializers/index.ts";
import type { TaskState } from "../../utils/task-generator.ts";
import type { RepoPipelineState } from "../pipeline.ts";
import type { RunEventBody } from "./events.ts";
import {
  createPipelineStateConverter,
  initializerStatesToEvents,
  taskToEvents,
} from "./instrument.ts";

async function collectWithReturn<T, TReturn>(
  generator: AsyncGenerator<T, TReturn>,
): Promise<{ values: T[]; returned: TReturn }> {
  const values: T[] = [];
  while (true) {
    const next = await generator.next();
    if (next.done) return { values, returned: next.value };
    values.push(next.value);
  }
}

async function* states(...items: TaskState[]): AsyncGenerator<TaskState> {
  yield* items;
}

describe("taskToEvents", () => {
  it("wraps a successful task as a timed step", async () => {
    const { values, returned } = await collectWithReturn(
      taskToEvents(
        states(
          { status: "running", message: "git clone --bare" },
          { status: "output", data: "Receiving objects: 42%\n" },
          { status: "completed" },
        ),
        { repo: "api", step: "git:mirror", title: "mirror" },
      ),
    );

    expect(values.map((event) => event.kind)).toEqual([
      "step-start",
      "step-log",
      "step-output",
      "step-end",
    ]);
    expect(values[0]).toMatchObject({ step: "git:mirror", title: "mirror" });
    expect(values.at(-1)).toMatchObject({ outcome: "ok" });
    expect(returned.outcome).toBe("ok");
  });

  it("converts failures, retries, and thrown errors into events", async () => {
    const failure = new Error("exited with code 128");
    const { values, returned } = await collectWithReturn(
      taskToEvents(
        states(
          { status: "retrying", reason: "network reset", attempt: 2 },
          { status: "failed", error: failure },
        ),
        { repo: "api", step: "git:mirror", title: "mirror" },
      ),
    );
    expect(values.map((event) => event.kind)).toEqual([
      "step-start",
      "step-retry",
      "step-end",
    ]);
    expect(values.at(-1)).toMatchObject({
      outcome: "failed",
      error: { message: "exited with code 128" },
    });
    expect(returned).toMatchObject({ outcome: "failed", error: failure });

    async function* throwing(): AsyncGenerator<TaskState> {
      yield { status: "running" };
      throw new Error("spawn ENOENT");
    }
    const thrown = await collectWithReturn(
      taskToEvents(throwing(), {
        repo: "api",
        step: "git:mirror",
        title: "mirror",
      }),
    );
    expect(thrown.returned).toMatchObject({ outcome: "failed" });
    expect(thrown.values.at(-1)).toMatchObject({
      kind: "step-end",
      outcome: "failed",
      error: { message: "spawn ENOENT" },
    });
  });

  it("marks tasks that only yielded skipped as skipped steps", async () => {
    const { values, returned } = await collectWithReturn(
      taskToEvents(states({ status: "skipped", reason: "no lockfile" }), {
        repo: "api",
        step: "init:pnpm-install",
        title: "install",
      }),
    );
    expect(values.at(-1)).toMatchObject({
      kind: "step-end",
      outcome: "skipped",
      reason: "no lockfile",
    });
    expect(returned.outcome).toBe("skipped");
  });
});

describe("initializerStatesToEvents", () => {
  async function* initializerRun(): AsyncGenerator<SingleRepoInitializerState> {
    yield { phase: "detecting" };
    yield {
      phase: "running",
      initializerId: "pnpm-install",
      initializerName: "Install dependencies",
      state: { status: "running", message: "pnpm install" },
    };
    yield {
      phase: "running",
      initializerId: "pnpm-install",
      initializerName: "Install dependencies",
      state: { status: "output", data: "resolved 1204\n" },
    };
    yield {
      phase: "running",
      initializerId: "pnpm-install",
      initializerName: "Install dependencies",
      state: { status: "completed" },
    };
    yield {
      phase: "skipped",
      initializerId: "vercel-link",
      reason: "not a Vercel project",
    };
    yield { phase: "complete" };
  }

  it("produces detect and per-initializer steps", async () => {
    const { values, returned } = await collectWithReturn(
      initializerStatesToEvents(initializerRun(), "api"),
    );

    expect(
      values.map((event) => [event.kind, "step" in event ? event.step : null]),
    ).toEqual([
      ["step-start", "init:detect"],
      ["step-end", "init:detect"],
      ["step-start", "init:pnpm-install"],
      ["step-log", "init:pnpm-install"],
      ["step-output", "init:pnpm-install"],
      ["step-end", "init:pnpm-install"],
      ["step-start", "init:vercel-link"],
      ["step-end", "init:vercel-link"],
    ]);
    expect(returned).toEqual({ outcome: "ok" });
  });

  it("stops at a failed initializer and reports its step", async () => {
    async function* failing(): AsyncGenerator<SingleRepoInitializerState> {
      yield { phase: "detecting" };
      yield {
        phase: "running",
        initializerId: "pnpm-install",
        initializerName: "Install dependencies",
        state: { status: "failed", error: new Error("install failed") },
      };
    }

    const { values, returned } = await collectWithReturn(
      initializerStatesToEvents(failing(), "api"),
    );
    expect(values.at(-1)).toMatchObject({
      kind: "step-end",
      step: "init:pnpm-install",
      outcome: "failed",
    });
    expect(returned).toMatchObject({
      outcome: "failed",
      step: "init:pnpm-install",
      stepTitle: "Install dependencies",
    });
  });
});

describe("createPipelineStateConverter", () => {
  function convertAll(bodies: RunEventBody[]): RepoPipelineState[] {
    const converter = createPipelineStateConverter();
    return bodies.flatMap((body) => converter.convert(body));
  }

  it("maps git step events to legacy git states", () => {
    const legacy = convertAll([
      { kind: "repo-start", repo: "api" },
      { kind: "step-start", repo: "api", step: "git:mirror", title: "mirror" },
      {
        kind: "step-log",
        repo: "api",
        step: "git:mirror",
        level: "info",
        message: "Seeding pristine repo",
      },
      {
        kind: "step-output",
        repo: "api",
        step: "git:mirror",
        chunk: "Receiving objects\n",
      },
      {
        kind: "step-end",
        repo: "api",
        step: "git:mirror",
        outcome: "ok",
        durationMs: 5,
      },
      { kind: "worktree-ready", repo: "api", hasLockfile: true },
    ]);

    expect(legacy).toEqual([
      { phase: "git", step: "mirror", status: "running" },
      {
        phase: "git",
        step: "mirror",
        status: "running",
        message: "Seeding pristine repo",
      },
      {
        phase: "git",
        step: "mirror",
        status: "output",
        output: "Receiving objects\n",
      },
      { phase: "git", step: "mirror", status: "completed" },
      { phase: "complete", hasLockfile: true },
    ]);
  });

  it("maps initializer failures with legacy step names", () => {
    const legacy = convertAll([
      {
        kind: "step-start",
        repo: "api",
        step: "init:pnpm-install",
        title: "Install dependencies",
      },
      {
        kind: "step-end",
        repo: "api",
        step: "init:pnpm-install",
        outcome: "failed",
        durationMs: 5,
        error: { message: "install failed" },
      },
      {
        kind: "repo-end",
        repo: "api",
        outcome: "failed",
        step: "init:pnpm-install",
        error: { message: "install failed" },
      },
    ]);

    expect(legacy[0]).toMatchObject({
      phase: "initializer",
      name: "Install dependencies",
      status: "running",
    });
    expect(legacy[1]).toMatchObject({
      phase: "initializer",
      name: "Install dependencies",
      status: "failed",
    });
    expect(legacy[2]).toMatchObject({
      phase: "failed",
      step: "initializer:Install dependencies",
    });
    const failed = legacy[2];
    if (failed?.phase !== "failed") throw new Error("expected failed state");
    expect(failed.error.message).toBe("install failed");
  });

  it("suppresses detect step ends and workspace-scoped steps", () => {
    const legacy = convertAll([
      { kind: "step-start", repo: "api", step: "init:detect", title: "detect" },
      {
        kind: "step-end",
        repo: "api",
        step: "init:detect",
        outcome: "ok",
        durationMs: 2,
      },
      { kind: "step-start", repo: null, step: "hook:seed", title: "seed" },
      { kind: "repo-end", repo: "api", outcome: "ready", hasLockfile: false },
    ]);

    expect(legacy).toEqual([
      {
        phase: "initializer",
        name: "detecting",
        status: "running",
        message: "Detecting project type...",
      },
      { phase: "complete", hasLockfile: false },
    ]);
  });
});
