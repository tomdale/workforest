import { describe, expect, it } from "vitest";
import { runParallel } from "../utils/task-generator.ts";
import type { RepoPipelineState } from "./pipeline.ts";

async function collectWithOrder<T>(
  gen: AsyncGenerator<{ id: string; state: T }>,
): Promise<Array<{ id: string; state: T; order: number }>> {
  const results: Array<{ id: string; state: T; order: number }> = [];
  let order = 0;
  for await (const { id, state } of gen) {
    results.push({ id, state, order: order++ });
  }
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runParallel", () => {
  it("runs multiple generators concurrently", async () => {
    const gen1 = (async function* () {
      yield "a1";
      await sleep(10);
      yield "a2";
    })();

    const gen2 = (async function* () {
      yield "b1";
      await sleep(10);
      yield "b2";
    })();

    const tasks = new Map<string, AsyncGenerator<string>>([
      ["A", gen1],
      ["B", gen2],
    ]);

    const results = await collectWithOrder(runParallel(tasks));
    const ids = results.map((r) => r.id);

    expect(ids).toContain("A");
    expect(ids).toContain("B");
    expect(results.length).toBe(4);
  });

  it("interleaves output from concurrent generators", async () => {
    const gen1 = (async function* () {
      yield "a1";
      await sleep(10);
      yield "a2";
      await sleep(10);
      yield "a3";
    })();

    const gen2 = (async function* () {
      yield "b1";
      await sleep(10);
      yield "b2";
      await sleep(10);
      yield "b3";
    })();

    const tasks = new Map<string, AsyncGenerator<string>>([
      ["A", gen1],
      ["B", gen2],
    ]);

    const results = await collectWithOrder(runParallel(tasks));
    const ids = results.map((r) => r.id);

    const firstB = ids.indexOf("B");
    const lastA = ids.lastIndexOf("A");
    expect(firstB).toBeLessThan(lastA);
  });
});

describe("cross-phase parallelism", () => {
  it("fast repo starts initializers while slow repo still doing git", async () => {
    const fastPipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield { phase: "git", step: "mirror", status: "running" };
      await sleep(5);
      yield { phase: "git", step: "mirror", status: "completed" };
      yield { phase: "initializer", name: "pnpm", status: "running" };
      await sleep(10);
      yield { phase: "initializer", name: "pnpm", status: "completed" };
      yield { phase: "complete", hasLockfile: false };
    };

    const slowPipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield { phase: "git", step: "mirror", status: "running" };
      await sleep(20);
      yield {
        phase: "git",
        step: "mirror",
        status: "output",
        output: "slow...",
      };
      await sleep(20);
      yield { phase: "git", step: "mirror", status: "completed" };
      yield { phase: "initializer", name: "pnpm", status: "running" };
      yield { phase: "initializer", name: "pnpm", status: "completed" };
      yield { phase: "complete", hasLockfile: false };
    };

    const pipelines = new Map([
      ["fast", fastPipeline()],
      ["slow", slowPipeline()],
    ]);

    const results = await collectWithOrder(runParallel(pipelines));

    const fastInitStart = results.find(
      (r) =>
        r.id === "fast" &&
        r.state.phase === "initializer" &&
        r.state.status === "running",
    );

    const slowGitComplete = results.find(
      (r) =>
        r.id === "slow" &&
        r.state.phase === "git" &&
        r.state.status === "completed",
    );

    expect(fastInitStart).toBeDefined();
    expect(slowGitComplete).toBeDefined();
    if (fastInitStart && slowGitComplete) {
      expect(fastInitStart.order).toBeLessThan(slowGitComplete.order);
    }
  });

  it("no repo waits for any other repo", async () => {
    let releaseSlowGit: (() => void) | undefined;
    const slowGit = new Promise<void>((resolve) => {
      releaseSlowGit = resolve;
    });

    const fastPipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield { phase: "git", step: "mirror", status: "running" };
      yield { phase: "git", step: "mirror", status: "completed" };
      yield { phase: "initializer", name: "pnpm", status: "running" };
      yield { phase: "initializer", name: "pnpm", status: "completed" };
      yield { phase: "complete", hasLockfile: false };
    };

    const slowPipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield { phase: "git", step: "mirror", status: "running" };
      await slowGit;
      yield { phase: "git", step: "mirror", status: "completed" };
      yield { phase: "complete", hasLockfile: false };
    };

    const pipelines = new Map([
      ["fast", fastPipeline()],
      ["slow", slowPipeline()],
    ]);

    const updates = runParallel(pipelines);
    while (true) {
      const next = await updates.next();
      expect(next.done).toBe(false);
      if (
        !next.done &&
        next.value.id === "fast" &&
        next.value.state.phase === "complete"
      ) {
        break;
      }
    }

    releaseSlowGit?.();
    const remaining = await collectWithOrder(updates);
    expect(remaining).toContainEqual(
      expect.objectContaining({
        id: "slow",
        state: expect.objectContaining({ phase: "complete" }),
      }),
    );
  });
});

describe("error handling", () => {
  it("one repo failing does not affect other repos", async () => {
    const failingPipeline =
      async function* (): AsyncGenerator<RepoPipelineState> {
        yield { phase: "git", step: "mirror", status: "running" };
        await sleep(5);
        yield { phase: "failed", error: new Error("Clone failed") };
      };

    const successPipeline =
      async function* (): AsyncGenerator<RepoPipelineState> {
        yield { phase: "git", step: "mirror", status: "running" };
        await sleep(10);
        yield { phase: "git", step: "mirror", status: "completed" };
        yield { phase: "initializer", name: "pnpm", status: "running" };
        await sleep(10);
        yield { phase: "initializer", name: "pnpm", status: "completed" };
        yield { phase: "complete", hasLockfile: false };
      };

    const pipelines = new Map([
      ["failing", failingPipeline()],
      ["success", successPipeline()],
    ]);

    const results = await collectWithOrder(runParallel(pipelines));

    const successStates = results.filter((r) => r.id === "success");
    const successComplete = successStates.find(
      (r) => r.state.phase === "complete",
    );
    expect(successComplete).toBeDefined();

    const failingStates = results.filter((r) => r.id === "failing");
    const failedState = failingStates.find((r) => r.state.phase === "failed");
    expect(failedState).toBeDefined();
  });
});
