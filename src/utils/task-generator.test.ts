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
});
