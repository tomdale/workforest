import { spawn } from "node:child_process";
import { TailBuffer } from "./tail-buffer.ts";

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
};

type CommandExit =
  | { type: "close"; code: number | null }
  | { type: "error"; error: Error };

type QueuedOutput = {
  data: string;
  bytes: number;
};

const MAX_STDERR_CHARS = 4096;
const MAX_QUEUED_OUTPUT_BYTES = 1024 * 1024;
const RESUME_QUEUED_OUTPUT_BYTES = MAX_QUEUED_OUTPUT_BYTES / 2;

/**
 * Generator that spawns a command and yields state updates as it runs.
 * Yields output chunks as they arrive from stdout/stderr.
 */
export async function* runCommandGenerator(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): TaskGenerator {
  yield { status: "running", message: `${command} ${args.join(" ")}` };

  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const outputQueue: QueuedOutput[] = [];
  let queuedBytes = 0;
  let streamsPaused = false;
  let wakeOutputConsumer: (() => void) | undefined;
  const stderrTail = new TailBuffer(MAX_STDERR_CHARS);

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

      if (exitResult.type === "error") {
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

/**
 * Runs multiple generators concurrently, yielding updates as they arrive from any generator.
 * Uses Promise.race to get the next available update from any active generator.
 */
export async function* runParallel<T>(
  tasks: Map<string, AsyncGenerator<T>>,
): AsyncGenerator<ParallelUpdate<T>> {
  // Track active iterators and their pending promises
  const active = new Map<
    string,
    {
      iterator: AsyncIterator<T>;
      pendingPromise: Promise<{ id: string; result: IteratorResult<T> }> | null;
    }
  >();

  // Initialize all iterators
  for (const [id, gen] of tasks) {
    active.set(id, {
      iterator: gen[Symbol.asyncIterator](),
      pendingPromise: null,
    });
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
    } else {
      yield { id, state: result.value };
    }
  }
}
