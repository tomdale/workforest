import { describe, expect, it } from "vitest";
import type { SpawnedCommandHandle, TaskState } from "./task-generator.ts";
import {
  runParallel,
  spawnCommand,
  terminateRunningCommands,
} from "./task-generator.ts";

async function collectStates(
  generator: AsyncGenerator<TaskState>,
): Promise<TaskState[]> {
  const states: TaskState[] = [];
  for await (const state of generator) {
    states.push(state);
  }
  return states;
}

async function collectUpdates<T>(
  generator: AsyncGenerator<{ id: string; state: T }>,
): Promise<Array<{ id: string; state: T }>> {
  const states: Array<{ id: string; state: T }> = [];
  for await (const state of generator) {
    states.push(state);
  }
  return states;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("spawnCommand", () => {
  it("reports command start failures as failed states", async () => {
    const states = await collectStates(
      spawnCommand("__workforest_missing_command__", ["--version"]),
    );

    const failedState = states.find((state) => state.status === "failed");

    expect(failedState).toBeDefined();
    expect(
      (failedState as Extract<TaskState, { status: "failed" }>).error.message,
    ).toContain("command not found");
  });

  it("drains high-volume output from child processes", async () => {
    const states = await collectStates(
      spawnCommand(process.execPath, [
        "-e",
        "for (let i = 0; i < 2048; i++) process.stdout.write('x'.repeat(1024));",
      ]),
    );

    const outputBytes = states
      .filter((state): state is Extract<TaskState, { status: "output" }> => {
        return state.status === "output";
      })
      .reduce((sum, state) => sum + Buffer.byteLength(state.data), 0);

    expect(outputBytes).toBe(2048 * 1024);
    expect(states.at(-1)).toEqual({ status: "completed" });
  });

  it("keeps failed command stderr messages bounded to the tail", async () => {
    const states = await collectStates(
      spawnCommand(process.execPath, [
        "-e",
        [
          "process.stderr.write('early-' + 'marker');",
          "process.stderr.write('x'.repeat(8192));",
          "process.stderr.write('late-marker');",
          "process.exit(1);",
        ].join(""),
      ]),
    );

    const failedState = states.find(
      (state): state is Extract<TaskState, { status: "failed" }> =>
        state.status === "failed",
    );

    expect(failedState?.error.message).not.toContain("early-marker");
    expect(failedState?.error.message).toContain("late-marker");
  });

  it("terminates commands that exceed the overall timeout", async () => {
    const states = await collectStates(
      spawnCommand(process.execPath, ["-e", "setTimeout(() => {}, 60_000);"], {
        timeoutMs: 150,
      }),
    );

    expect(states.at(-1)).toMatchObject({
      status: "failed",
      error: expect.objectContaining({
        message: expect.stringContaining("timed out after 150ms"),
      }),
    });
  });

  it("terminates commands that go silent past the inactivity timeout", async () => {
    const states = await collectStates(
      spawnCommand(
        process.execPath,
        [
          "-e",
          "process.stdout.write('started'); setTimeout(() => {}, 60_000);",
        ],
        { inactivityTimeoutMs: 150 },
      ),
    );

    expect(states.some((state) => state.status === "output")).toBe(true);
    expect(states.at(-1)).toMatchObject({
      status: "failed",
      error: expect.objectContaining({
        message: expect.stringContaining("produced no output for 150ms"),
      }),
    });
  });

  it("does not trip the inactivity timeout while output flows", async () => {
    const states = await collectStates(
      spawnCommand(
        process.execPath,
        [
          "-e",
          [
            "let ticks = 0;",
            "const timer = setInterval(() => {",
            "  process.stdout.write('tick');",
            "  if (++ticks === 5) { clearInterval(timer); }",
            "}, 60);",
          ].join("\n"),
        ],
        { inactivityTimeoutMs: 250 },
      ),
    );

    expect(states.at(-1)).toEqual({ status: "completed" });
  });

  it("invokes onSpawn with a usable handle", async () => {
    const handles: SpawnedCommandHandle[] = [];

    const states = await collectStates(
      spawnCommand(process.execPath, ["-e", "process.exit(0)"], {
        onSpawn: (handle) => handles.push(handle),
      }),
    );

    expect(states.at(-1)).toEqual({ status: "completed" });
    expect(handles).toHaveLength(1);
    expect(typeof handles[0]?.pid).toBe("number");
    await expect(handles[0]?.wait()).resolves.toBeUndefined();
  });

  it("terminateRunningCommands stops a long-running child", async () => {
    const states: TaskState[] = [];
    const generator = spawnCommand(process.execPath, [
      "-e",
      "setTimeout(() => {}, 60_000);",
    ]);

    const consumed = (async () => {
      for await (const state of generator) {
        states.push(state);
      }
    })();

    // Give the child a moment to actually start before terminating it.
    await sleep(50);
    await terminateRunningCommands();
    await consumed;

    expect(states.at(-1)?.status).toBe("failed");
  });
});

describe("runParallel", () => {
  it("limits active generators when maxConcurrent is set", async () => {
    let active = 0;
    let maxActive = 0;
    const started: string[] = [];

    const makeTask = (id: string) =>
      async function* () {
        active += 1;
        maxActive = Math.max(maxActive, active);
        started.push(id);
        yield "running";
        await sleep(5);
        active -= 1;
      };

    const tasks = new Map(
      ["a", "b", "c", "d", "e"].map((id) => [id, makeTask(id)()]),
    );

    const states = await collectUpdates(
      runParallel(tasks, { maxConcurrent: 2 }),
    );

    expect(states).toHaveLength(5);
    expect(started).toEqual(["a", "b", "c", "d", "e"]);
    expect(maxActive).toBe(2);
  });
});
