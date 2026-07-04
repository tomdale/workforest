import { describe, expect, it, vi } from "vitest";
import { computeRetryDelayMs, withRetry } from "./retry.ts";
import type { TaskState } from "./task-generator.ts";

const FAST_BACKOFF = { baseMs: 1, factor: 2, maxMs: 4 };

async function collect<T>(
  gen: AsyncGenerator<TaskState, T>,
): Promise<{ states: TaskState[]; value: T }> {
  const states: TaskState[] = [];
  while (true) {
    const next = await gen.next();
    if (next.done) return { states, value: next.value };
    states.push(next.value);
  }
}

describe("computeRetryDelayMs", () => {
  it("grows exponentially and caps without jitter", () => {
    const options = {
      backoff: { baseMs: 1000, factor: 2, maxMs: 5000 },
      jitter: false,
    };
    expect(computeRetryDelayMs(1, options)).toBe(1000);
    expect(computeRetryDelayMs(2, options)).toBe(2000);
    expect(computeRetryDelayMs(3, options)).toBe(4000);
    expect(computeRetryDelayMs(4, options)).toBe(5000);
  });

  it("applies full jitter within the half-to-full window", () => {
    const options = { backoff: { baseMs: 1000, factor: 2, maxMs: 5000 } };
    expect(computeRetryDelayMs(1, options, () => 0)).toBe(500);
    expect(computeRetryDelayMs(1, options, () => 1)).toBe(1000);
    expect(computeRetryDelayMs(2, options, () => 0.5)).toBe(1500);
  });
});

describe("withRetry", () => {
  it("emits retrying states and runs the cleanup hook between attempts", async () => {
    let attempts = 0;
    const onRetry = vi.fn();
    const task = () =>
      (async function* (): AsyncGenerator<TaskState, string> {
        attempts += 1;
        if (attempts < 3) {
          yield { status: "failed", error: new Error(`boom ${attempts}`) };
          return "unreachable";
        }
        yield { status: "completed" };
        return "done";
      })();

    const { states, value } = await collect(
      withRetry(task, {
        attempts: 3,
        label: "clone",
        backoff: FAST_BACKOFF,
        onRetry,
      }),
    );

    expect(value).toBe("done");
    expect(states).toEqual([
      { status: "retrying", reason: "clone failed: boom 1", attempt: 2 },
      { status: "retrying", reason: "clone failed: boom 2", attempt: 3 },
      { status: "completed" },
    ]);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Error));
  });

  it("forwards the failure on the final attempt instead of retrying", async () => {
    const task = () =>
      (async function* (): AsyncGenerator<TaskState, void> {
        yield { status: "failed", error: new Error("always fails") };
      })();

    const { states } = await collect(
      withRetry(task, { attempts: 2, label: "fetch", backoff: FAST_BACKOFF }),
    );

    expect(states.at(-1)).toMatchObject({
      status: "failed",
      error: expect.objectContaining({ message: "always fails" }),
    });
    expect(states.filter((state) => state.status === "retrying")).toHaveLength(
      1,
    );
  });

  it("throws after exhausting attempts when the task throws", async () => {
    const task = () =>
      (async function* (): AsyncGenerator<TaskState, void> {
        yield { status: "running" };
        throw new Error("network down");
      })();

    await expect(
      collect(
        withRetry(task, { attempts: 2, label: "clone", backoff: FAST_BACKOFF }),
      ),
    ).rejects.toThrow("network down");
  });
});
