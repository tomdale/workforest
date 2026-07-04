import { type ChildProcess, spawn } from "node:child_process";
import { createSpawnEnv, TailBuffer } from "@wf-plugin/core";

/**
 * State emitted by task generators to provide visibility into execution progress.
 */
export type TaskState =
  | { status: "pending" }
  | { status: "running"; message?: string }
  | { status: "output"; data: string }
  | { status: "log"; level: "info" | "warn" | "error"; message: string }
  | { status: "retrying"; reason: string; attempt: number }
  | { status: "completed" }
  | { status: "failed"; error: Error }
  | { status: "skipped"; reason: string };

export type TaskGenerator = AsyncGenerator<TaskState, void, undefined>;

export type RunCommandOptions = {
  cwd?: string;
  /** Fail the command if it runs longer than this in total. */
  timeoutMs?: number;
  /** Fail the command if it produces no output for this long. */
  inactivityTimeoutMs?: number;
};

type CommandExit =
  | { type: "close"; code: number | null }
  | { type: "error"; error: Error };

type CommandKill = {
  kind: "timeout" | "inactivity";
  limitMs: number;
};

const MAX_STDERR_CHARS = 4096;
const MAX_QUEUED_OUTPUT_BYTES = 1024 * 1024;
const RESUME_QUEUED_OUTPUT_BYTES = MAX_QUEUED_OUTPUT_BYTES / 2;
const TIMEOUT_FORCE_KILL_DELAY_MS = 5_000;
const activeCommandChildren = new Set<ChildProcess>();

type QueuedOutput = {
  data: string;
  bytes: number;
};

/**
 * Spawns a command and yields state updates as it runs.
 * Yields output chunks as they arrive from stdout/stderr.
 */
export async function* spawnCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): TaskGenerator {
  yield { status: "running", message: `${command} ${args.join(" ")}` };

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: createSpawnEnv(options.cwd),
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeCommandChildren.add(child);

  const outputQueue: QueuedOutput[] = [];
  let queuedBytes = 0;
  let streamsPaused = false;
  let wakeOutputConsumer: (() => void) | undefined;
  const stderrTail = new TailBuffer(MAX_STDERR_CHARS);

  let killedBy: CommandKill | null = null;
  let overallTimer: ReturnType<typeof setTimeout> | undefined;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

  const killForLimit = (kill: CommandKill): void => {
    if (killedBy) return;
    killedBy = kill;
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(
      () => child.kill("SIGKILL"),
      TIMEOUT_FORCE_KILL_DELAY_MS,
    );
    forceKillTimer.unref();
  };
  const clearTimers = (): void => {
    if (overallTimer) clearTimeout(overallTimer);
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
  };
  const resetInactivityTimer = (): void => {
    const limitMs = options.inactivityTimeoutMs;
    if (!limitMs) return;
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(
      () => killForLimit({ kind: "inactivity", limitMs }),
      limitMs,
    );
    inactivityTimer.unref();
  };

  if (options.timeoutMs) {
    const limitMs = options.timeoutMs;
    overallTimer = setTimeout(
      () => killForLimit({ kind: "timeout", limitMs }),
      limitMs,
    );
    overallTimer.unref();
  }
  resetInactivityTimer();

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  function wakeConsumer(): void {
    wakeOutputConsumer?.();
    wakeOutputConsumer = undefined;
  }

  function pauseStreamsIfNeeded(): void {
    if (streamsPaused || queuedBytes < MAX_QUEUED_OUTPUT_BYTES) {
      return;
    }

    child.stdout.pause();
    child.stderr.pause();
    streamsPaused = true;
  }

  function resumeStreamsIfNeeded(): void {
    if (!streamsPaused || queuedBytes > RESUME_QUEUED_OUTPUT_BYTES) {
      return;
    }

    child.stdout.resume();
    child.stderr.resume();
    streamsPaused = false;
  }

  function enqueueOutput(chunk: string): void {
    const bytes = Buffer.byteLength(chunk, "utf8");
    outputQueue.push({ data: chunk, bytes });
    queuedBytes += bytes;
    resetInactivityTimer();
    pauseStreamsIfNeeded();
    wakeConsumer();
  }

  child.stdout.on("data", enqueueOutput);

  child.stderr.on("data", (chunk: string) => {
    stderrTail.append(chunk);
    enqueueOutput(chunk);
  });

  let exitResult: CommandExit | undefined;
  const exitPromise = new Promise<CommandExit>((resolve) => {
    child.on("error", (error) => resolve({ type: "error", error }));
    child.on("close", (code) => resolve({ type: "close", code }));
  }).then((exit) => {
    activeCommandChildren.delete(child);
    clearTimers();
    exitResult = exit;
    wakeConsumer();
    return exit;
  });

  function* drainOutput(): Generator<TaskState> {
    let chunk = outputQueue.shift();
    while (chunk !== undefined) {
      queuedBytes -= chunk.bytes;
      resumeStreamsIfNeeded();
      yield { status: "output", data: chunk.data };
      chunk = outputQueue.shift();
    }
  }

  function waitForOutputOrExit(): Promise<void> {
    if (outputQueue.length > 0 || exitResult) {
      return Promise.resolve();
    }

    return Promise.race([
      exitPromise.then(() => {
        wakeOutputConsumer = undefined;
      }),
      new Promise<void>((resolve) => {
        wakeOutputConsumer = resolve;
      }),
    ]);
  }

  // Yield output chunks as they arrive
  while (true) {
    yield* drainOutput();

    if (exitResult) {
      // Drain any remaining chunks
      yield* drainOutput();

      if (killedBy) {
        yield {
          status: "failed",
          error: new Error(
            formatKillMessage(command, args, killedBy, stderrTail.toString()),
          ),
        };
      } else if (exitResult.type === "error") {
        yield {
          status: "failed",
          error: formatCommandStartError(command, args, exitResult.error),
        };
      } else if (exitResult.code === 0) {
        yield { status: "completed" };
      } else {
        yield {
          status: "failed",
          error: new Error(
            `${command} ${args.join(" ")} exited with code ${exitResult.code}. ${stderrTail.toString()}`,
          ),
        };
      }
      return;
    }

    await waitForOutputOrExit();
  }
}

function formatKillMessage(
  command: string,
  args: string[],
  kill: CommandKill,
  stderrTail: string,
): string {
  const commandLine = `${command} ${args.join(" ")}`.trim();
  const cause =
    kill.kind === "timeout"
      ? `timed out after ${kill.limitMs}ms`
      : `produced no output for ${kill.limitMs}ms`;
  const tail = stderrTail.trim();
  return `${commandLine} ${cause} and was terminated.${tail ? ` ${tail}` : ""}`;
}

export async function terminateRunningCommands(): Promise<void> {
  const children = [...activeCommandChildren];
  if (children.length === 0) return;

  for (const child of children) {
    child.kill("SIGTERM");
  }

  await Promise.race([
    Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            child.once("close", () => resolve());
          }),
      ),
    ),
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ]);

  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
}

function formatCommandStartError(
  command: string,
  args: string[],
  error: Error,
): Error {
  const commandLine = `${command} ${args.join(" ")}`.trim();
  const code = (error as NodeJS.ErrnoException).code;

  if (code === "ENOENT") {
    return new Error(
      `${commandLine} failed to start: command not found (${command}). Install ${command} or ensure it is available on PATH.`,
      { cause: error },
    );
  }

  return new Error(`${commandLine} failed to start: ${error.message}`, {
    cause: error,
  });
}

/**
 * Update from a parallel generator run, tagged with the task ID.
 */
export type ParallelUpdate<T> = { id: string; state: T };

export type RunParallelOptions = {
  maxConcurrent?: number;
};

/**
 * Runs multiple generators concurrently, yielding updates as they arrive from any generator.
 * Uses Promise.race to get the next available update from any active generator.
 */
export async function* runParallel<T>(
  tasks: Map<string, AsyncGenerator<T>>,
  options: RunParallelOptions = {},
): AsyncGenerator<ParallelUpdate<T>> {
  // Track active iterators and their pending promises
  const active = new Map<
    string,
    {
      iterator: AsyncIterator<T>;
      pendingPromise: Promise<{ id: string; result: IteratorResult<T> }> | null;
    }
  >();
  const pending = [...tasks.entries()];
  const maxConcurrent = normalizeMaxConcurrent(options.maxConcurrent);

  function startPendingTasks(): void {
    while (pending.length > 0 && active.size < maxConcurrent) {
      const next = pending.shift();
      if (!next) {
        return;
      }

      const [id, gen] = next;
      active.set(id, {
        iterator: gen[Symbol.asyncIterator](),
        pendingPromise: null,
      });
    }
  }

  // Helper to get or create a pending promise for an iterator
  function getPromise(
    id: string,
    entry: {
      iterator: AsyncIterator<T>;
      pendingPromise: Promise<{ id: string; result: IteratorResult<T> }> | null;
    },
  ): Promise<{ id: string; result: IteratorResult<T> }> {
    if (!entry.pendingPromise) {
      entry.pendingPromise = entry.iterator
        .next()
        .then((result) => ({ id, result }));
    }
    return entry.pendingPromise;
  }

  startPendingTasks();

  try {
    while (active.size > 0) {
      // Create promises for all active generators
      const promises = [...active.entries()].map(([id, entry]) =>
        getPromise(id, entry),
      );

      // Wait for any generator to yield
      const { id, result } = await Promise.race(promises);

      // Clear the pending promise for this iterator
      const entry = active.get(id);
      if (!entry) {
        // This shouldn't happen, but handle it gracefully
        continue;
      }
      entry.pendingPromise = null;

      if (result.done) {
        active.delete(id);
        startPendingTasks();
      } else {
        yield { id, state: result.value };
      }
    }
  } finally {
    await Promise.all(
      [...active.values()].map(async ({ iterator }) => {
        await iterator.return?.();
      }),
    );
  }
}

function normalizeMaxConcurrent(value: number | undefined): number {
  if (value === undefined) {
    return Number.POSITIVE_INFINITY;
  }

  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError("maxConcurrent must be a positive finite number.");
  }

  return Math.floor(value);
}
