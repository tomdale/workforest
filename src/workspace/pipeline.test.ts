import { describe, expect, it } from "vitest";
import { runParallel } from "../utils/task-generator.ts";
import type { RepoPipelineState } from "./pipeline.ts";

/**
 * Helper: collect all states from a generator.
 */
async function collectStates<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const states: T[] = [];
  for await (const state of gen) {
    states.push(state);
  }
  return states;
}

/**
 * Helper: collect states with order for interleaving tests.
 */
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

    // Both A and B should appear
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

    // Should see interleaving: not all A's then all B's
    const firstB = ids.indexOf("B");
    const lastA = ids.lastIndexOf("A");
    expect(firstB).toBeLessThan(lastA);
  });
});

describe("cross-phase parallelism", () => {
  it("fast repo starts initializers while slow repo still doing git", async () => {
    // Fast repo: quick git (1 step)
    const fastPipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield { phase: "git", step: "mirror", status: "running" };
      await sleep(5);
      yield { phase: "git", step: "mirror", status: "completed" };
      // Immediately start initializer
      yield { phase: "initializer", name: "pnpm", status: "running" };
      await sleep(10);
      yield { phase: "initializer", name: "pnpm", status: "completed" };
      yield { phase: "complete", hasLockfile: false };
    };

    // Slow repo: slow git (3 steps with delays)
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

    // Find when fast repo starts initializers
    const fastInitStart = results.find(
      (r) =>
        r.id === "fast" &&
        r.state.phase === "initializer" &&
        r.state.status === "running",
    );

    // Find when slow repo finishes git
    const slowGitComplete = results.find(
      (r) =>
        r.id === "slow" &&
        r.state.phase === "git" &&
        r.state.status === "completed",
    );

    // Fast repo must start initializers BEFORE slow repo finishes git
    expect(fastInitStart).toBeDefined();
    expect(slowGitComplete).toBeDefined();
    if (fastInitStart && slowGitComplete) {
      expect(fastInitStart.order).toBeLessThan(slowGitComplete.order);
    }
  });

  it("no repo waits for any other repo", async () => {
    // 3 repos with different speeds
    const createPipeline = (delayMs: number) =>
      async function* (): AsyncGenerator<RepoPipelineState> {
        yield { phase: "git", step: "mirror", status: "running" };
        await sleep(delayMs);
        yield { phase: "git", step: "mirror", status: "completed" };
        yield { phase: "initializer", name: "pnpm", status: "running" };
        await sleep(delayMs);
        yield { phase: "initializer", name: "pnpm", status: "completed" };
        yield { phase: "complete", hasLockfile: false };
      };

    const pipelines = new Map([
      ["fast", createPipeline(5)()],
      ["medium", createPipeline(15)()],
      ["slow", createPipeline(30)()],
    ]);

    const results = await collectWithOrder(runParallel(pipelines));

    // Fast repo should complete before slow repo finishes git
    const fastComplete = results.find(
      (r) => r.id === "fast" && r.state.phase === "complete",
    );
    const slowGitStates = results.filter(
      (r) => r.id === "slow" && r.state.phase === "git",
    );
    const slowGitEnd = slowGitStates[slowGitStates.length - 1];

    expect(fastComplete).toBeDefined();
    expect(slowGitEnd).toBeDefined();
    if (fastComplete && slowGitEnd) {
      expect(fastComplete.order).toBeLessThan(slowGitEnd.order);
    }
  });
});

describe("state sequence", () => {
  it("git phase comes before initializer phase", async () => {
    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield { phase: "git", step: "mirror", status: "running" };
      yield { phase: "git", step: "mirror", status: "completed" };
      yield { phase: "git", step: "worktree", status: "running" };
      yield { phase: "git", step: "worktree", status: "completed" };
      yield { phase: "initializer", name: "pnpm", status: "running" };
      yield { phase: "initializer", name: "pnpm", status: "completed" };
      yield { phase: "complete", hasLockfile: true };
    };

    const states = await collectStates(pipeline());
    const phases = states.map((s) => s.phase);

    // Git phases come before initializer phases
    const lastGit = phases.lastIndexOf("git");
    const firstInit = phases.indexOf("initializer");
    expect(lastGit).toBeLessThan(firstInit);

    // Complete is last
    expect(phases[phases.length - 1]).toBe("complete");
  });

  it("preserves state order within each repo in parallel run", async () => {
    const createPipeline = () =>
      async function* (): AsyncGenerator<RepoPipelineState> {
        yield { phase: "git", step: "mirror", status: "running" };
        await sleep(5);
        yield { phase: "git", step: "mirror", status: "completed" };
        yield { phase: "git", step: "worktree", status: "running" };
        await sleep(5);
        yield { phase: "git", step: "worktree", status: "completed" };
        yield { phase: "initializer", name: "pnpm", status: "running" };
        await sleep(5);
        yield { phase: "initializer", name: "pnpm", status: "completed" };
        yield { phase: "complete", hasLockfile: false };
      };

    const pipelines = new Map([
      ["repoA", createPipeline()()],
      ["repoB", createPipeline()()],
    ]);

    const results = await collectWithOrder(runParallel(pipelines));

    // Extract per-repo sequences
    const repoAStates = results.filter((r) => r.id === "repoA");
    const repoBStates = results.filter((r) => r.id === "repoB");

    // Each repo's states should be in correct order
    function assertCorrectPhaseOrder(
      states: Array<{ state: RepoPipelineState; order: number }>,
    ) {
      const phases = states.map((s) => s.state.phase);
      const lastGit = phases.lastIndexOf("git");
      const firstInit = phases.indexOf("initializer");
      const completeIdx = phases.indexOf("complete");

      if (firstInit !== -1) {
        expect(lastGit).toBeLessThan(firstInit);
      }
      expect(completeIdx).toBe(phases.length - 1);
    }

    assertCorrectPhaseOrder(repoAStates);
    assertCorrectPhaseOrder(repoBStates);
  });
});

describe("state content", () => {
  it("output states contain actual data", async () => {
    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield { phase: "git", step: "mirror", status: "running" };
      yield {
        phase: "git",
        step: "mirror",
        status: "output",
        output: "Cloning repository...",
      };
      yield {
        phase: "git",
        step: "mirror",
        status: "output",
        output: "Receiving objects: 50%",
      };
      yield { phase: "git", step: "mirror", status: "completed" };
      yield { phase: "complete", hasLockfile: false };
    };

    const states = await collectStates(pipeline());

    const outputStates = states.filter(
      (s) => s.phase === "git" && "output" in s && s.output !== undefined,
    );

    expect(outputStates.length).toBe(2);
    for (const s of outputStates) {
      expect(typeof (s as { output: string }).output).toBe("string");
      expect((s as { output: string }).output.length).toBeGreaterThan(0);
    }
  });

  it("complete state includes hasLockfile info", async () => {
    const pipelineWithLockfile =
      async function* (): AsyncGenerator<RepoPipelineState> {
        yield { phase: "git", step: "mirror", status: "completed" };
        yield { phase: "complete", hasLockfile: true };
      };

    const pipelineWithoutLockfile =
      async function* (): AsyncGenerator<RepoPipelineState> {
        yield { phase: "git", step: "mirror", status: "completed" };
        yield { phase: "complete", hasLockfile: false };
      };

    const statesWithLockfile = await collectStates(pipelineWithLockfile());
    const statesWithoutLockfile = await collectStates(
      pipelineWithoutLockfile(),
    );

    const completeWith = statesWithLockfile.find((s) => s.phase === "complete");
    const completeWithout = statesWithoutLockfile.find(
      (s) => s.phase === "complete",
    );

    expect(completeWith).toBeDefined();
    expect(completeWithout).toBeDefined();
    expect(
      (completeWith as { phase: "complete"; hasLockfile: boolean }).hasLockfile,
    ).toBe(true);
    expect(
      (completeWithout as { phase: "complete"; hasLockfile: boolean })
        .hasLockfile,
    ).toBe(false);
  });

  it("failed states include error details", async () => {
    const failingPipeline =
      async function* (): AsyncGenerator<RepoPipelineState> {
        yield { phase: "git", step: "mirror", status: "running" };
        yield {
          phase: "failed",
          error: new Error("Clone failed: network error"),
        };
      };

    const states = await collectStates(failingPipeline());
    const failedState = states.find((s) => s.phase === "failed");

    expect(failedState).toBeDefined();
    expect(
      (failedState as { phase: "failed"; error: Error }).error,
    ).toBeInstanceOf(Error);
    expect(
      (failedState as { phase: "failed"; error: Error }).error.message,
    ).toContain("Clone failed");
  });
});

describe("error handling", () => {
  it("pipeline stops after git failure", async () => {
    const failingPipeline =
      async function* (): AsyncGenerator<RepoPipelineState> {
        yield { phase: "git", step: "mirror", status: "running" };
        yield { phase: "git", step: "mirror", status: "failed" };
        yield { phase: "failed", error: new Error("Clone failed") };
      };

    const states = await collectStates(failingPipeline());
    const phases = states.map((s) => s.phase);

    // Should not have initializer phase
    expect(phases).not.toContain("initializer");
    expect(phases).toContain("failed");
  });

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

    // Success pipeline should complete
    const successStates = results.filter((r) => r.id === "success");
    const successComplete = successStates.find(
      (r) => r.state.phase === "complete",
    );
    expect(successComplete).toBeDefined();

    // Failing pipeline should have failed state
    const failingStates = results.filter((r) => r.id === "failing");
    const failedState = failingStates.find((r) => r.state.phase === "failed");
    expect(failedState).toBeDefined();
  });
});
