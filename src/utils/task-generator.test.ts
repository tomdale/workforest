import { describe, expect, it } from "vitest";
import type { TaskState } from "./task-generator.ts";
import { runCommandGenerator } from "./task-generator.ts";

async function collectStates(
  generator: AsyncGenerator<TaskState>,
): Promise<TaskState[]> {
  const states: TaskState[] = [];
  for await (const state of generator) {
    states.push(state);
  }
  return states;
}

describe("runCommandGenerator", () => {
  it("reports command start failures as failed states", async () => {
    const states = await collectStates(
      runCommandGenerator("__workforest_missing_command__", ["--version"]),
    );

    const failedState = states.find((state) => state.status === "failed");

    expect(failedState).toBeDefined();
    expect(
      (failedState as Extract<TaskState, { status: "failed" }>).error.message,
    ).toContain("command not found");
  });

  it("drains high-volume output from child processes", async () => {
    const states = await collectStates(
      runCommandGenerator(process.execPath, [
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
      runCommandGenerator(process.execPath, [
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
});
