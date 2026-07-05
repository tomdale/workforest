import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  canRunForegroundTask,
  runForegroundTask,
  spawnCommand,
  type SpawnedCommandHandle,
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
  vi.unstubAllEnvs();
});

function outputOf(states: TaskState[]): string {
  return states
    .filter(
      (state): state is Extract<TaskState, { status: "output" }> =>
        state.status === "output",
    )
    .map((state) => state.data)
    .join("");
}

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

describe("spawnCommand", () => {
  it("invokes onSpawn with a usable handle in pipe mode", async () => {
    const handles: SpawnedCommandHandle[] = [];

    const states = await collectStates(
      spawnCommand(process.execPath, ["-e", "process.exit(0)"], {
        cwd: process.cwd(),
        onSpawn: (handle) => handles.push(handle),
      }),
    );

    expect(states.at(-1)).toEqual({ status: "completed" });
    expect(handles).toHaveLength(1);
    expect(typeof handles[0]?.pid).toBe("number");
    await expect(handles[0]?.wait()).resolves.toBeUndefined();
  });

  it("forces the pipe path when WORKFOREST_NO_PTY=1 even with pty requested", async () => {
    vi.stubEnv("WORKFOREST_NO_PTY", "1");

    const states = await collectStates(
      spawnCommand(
        process.execPath,
        ["-e", "process.stdout.write(String(Boolean(process.stdout.isTTY)))"],
        { cwd: process.cwd(), pty: true },
      ),
    );

    expect(outputOf(states)).toBe("false");
    expect(states.at(-1)).toEqual({ status: "completed" });
  });
});

describe("spawnCommand PTY mode", () => {
  let ptyAvailable = false;

  beforeAll(async () => {
    try {
      const ptyMod = await import("@lydell/node-pty");
      await new Promise<void>((resolve, reject) => {
        const probe = ptyMod.spawn("/bin/echo", ["ok"], {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
        });
        const timeout = setTimeout(
          () => reject(new Error("pty probe timed out")),
          2_000,
        );
        timeout.unref();
        probe.onExit(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
      ptyAvailable = true;
    } catch {
      ptyAvailable = false;
    }
  });

  it("gives the child a real TTY", async (ctx) => {
    ctx.skip(!ptyAvailable, "PTY allocation unavailable in this environment");

    const states = await collectStates(
      spawnCommand(
        process.execPath,
        ["-e", "process.stdout.write(String(Boolean(process.stdout.isTTY)))"],
        { cwd: process.cwd(), pty: true },
      ),
    );

    expect(outputOf(states)).toContain("true");
    expect(states.at(-1)).toEqual({ status: "completed" });
  });

  it("merges stderr into the same output stream", async (ctx) => {
    ctx.skip(!ptyAvailable, "PTY allocation unavailable in this environment");

    const states = await collectStates(
      spawnCommand(
        process.execPath,
        ["-e", "process.stderr.write('stderr-marker')"],
        { cwd: process.cwd(), pty: true },
      ),
    );

    expect(outputOf(states)).toContain("stderr-marker");
  });

  it("strips ANSI codes from a failure message even when the child colored its output", async (ctx) => {
    ctx.skip(!ptyAvailable, "PTY allocation unavailable in this environment");

    const states = await collectStates(
      spawnCommand(
        process.execPath,
        [
          "-e",
          "process.stderr.write('\\u001b[31mboom\\u001b[0m'); process.exit(1);",
        ],
        { cwd: process.cwd(), pty: true },
      ),
    );

    const failure = states.at(-1);
    expect(failure).toMatchObject({ status: "failed" });
    const message = failure?.status === "failed" ? failure.error.message : "";
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the ANSI escape is gone
    expect(message).not.toMatch(/\x1b/);
    expect(message).toContain("boom");
  });
});
