import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canRunForegroundTask,
  runForegroundTask,
  type TaskState,
} from "./index.ts";

async function collectStates(
  generator: AsyncGenerator<TaskState>,
): Promise<TaskState[]> {
  const states: TaskState[] = [];
  for await (const state of generator) {
    states.push(state);
  }
  return states;
}

const originalBackgroundWorker = process.env["WORKFOREST_BACKGROUND_WORKER"];
const originalTtyDescriptors = new Map<object, PropertyDescriptor | undefined>([
  [process.stdin, Object.getOwnPropertyDescriptor(process.stdin, "isTTY")],
  [process.stdout, Object.getOwnPropertyDescriptor(process.stdout, "isTTY")],
  [process.stderr, Object.getOwnPropertyDescriptor(process.stderr, "isTTY")],
]);

afterEach(() => {
  if (originalBackgroundWorker === undefined) {
    delete process.env["WORKFOREST_BACKGROUND_WORKER"];
  } else {
    process.env["WORKFOREST_BACKGROUND_WORKER"] = originalBackgroundWorker;
  }
  restoreTtyProperties();
  vi.restoreAllMocks();
});

describe("canRunForegroundTask", () => {
  it("requires terminal stdio and no background worker marker", () => {
    setTtyProperties(true, true, true);
    delete process.env["WORKFOREST_BACKGROUND_WORKER"];

    expect(canRunForegroundTask()).toBe(true);

    process.env["WORKFOREST_BACKGROUND_WORKER"] = "1";
    expect(canRunForegroundTask()).toBe(false);
  });

  it("returns false when stdio is not a TTY", () => {
    setTtyProperties(false, true, true);
    delete process.env["WORKFOREST_BACKGROUND_WORKER"];

    expect(canRunForegroundTask()).toBe(false);
  });
});

function setTtyProperties(stdin: boolean, stdout: boolean, stderr: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: stdin,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: stdout,
  });
  Object.defineProperty(process.stderr, "isTTY", {
    configurable: true,
    value: stderr,
  });
}

function restoreTtyProperties(): void {
  for (const [stream, descriptor] of originalTtyDescriptors) {
    if (descriptor === undefined) {
      delete (stream as { isTTY?: boolean }).isTTY;
      continue;
    }

    Object.defineProperty(stream, "isTTY", descriptor);
  }
}

describe("runForegroundTask", () => {
  it("reports inherited-stdio subprocess completion", async () => {
    const states = await collectStates(
      runForegroundTask(process.execPath, ["-e", ""], { cwd: process.cwd() }),
    );

    expect(states).toEqual([
      { status: "running", message: `${process.execPath} -e ` },
      { status: "completed" },
    ]);
  });

  it("reports inherited-stdio subprocess failures", async () => {
    const states = await collectStates(
      runForegroundTask(process.execPath, ["-e", "process.exit(7)"], {
        cwd: process.cwd(),
      }),
    );

    expect(states.at(-1)).toMatchObject({
      status: "failed",
      error: expect.objectContaining({
        message: expect.stringContaining("exited with code 7"),
      }),
    });
  });
});
