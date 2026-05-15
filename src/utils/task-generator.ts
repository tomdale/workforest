import { spawn } from "node:child_process";

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

  // Set up data handlers that collect and yield output
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  // Keep only the tail of stderr for error messages to avoid OOM on verbose commands.
  const MAX_STDERR_CHARS = 4096;
  let stderrTail = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk: string) => {
    stdoutChunks.push(chunk);
  });

  child.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-MAX_STDERR_CHARS);
    stderrChunks.push(chunk);
  });

  // Poll for new output chunks while process is running
  const exitPromise = new Promise<CommandExit>((resolve) => {
    child.on("error", (error) => resolve({ type: "error", error }));
    child.on("close", (code) => resolve({ type: "close", code }));
  });

  // Helper to drain chunks from an array
  function* drainChunks(chunks: string[]): Generator<TaskState> {
    let chunk = chunks.shift();
    while (chunk !== undefined) {
      yield { status: "output", data: chunk };
      chunk = chunks.shift();
    }
  }

  // Yield output chunks as they arrive
  while (true) {
    // Check for new stdout chunks
    yield* drainChunks(stdoutChunks);

    // Check for new stderr chunks
    yield* drainChunks(stderrChunks);

    // Check if process has exited
    const exit = await Promise.race([
      exitPromise,
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 50),
      ),
    ]);

    if (exit !== "pending") {
      // Drain any remaining chunks
      yield* drainChunks(stdoutChunks);
      yield* drainChunks(stderrChunks);

      if (exit.type === "error") {
        yield {
          status: "failed",
          error: formatCommandStartError(command, args, exit.error),
        };
      } else if (exit.code === 0) {
        yield { status: "completed" };
      } else {
        yield {
          status: "failed",
          error: new Error(
            `${command} ${args.join(" ")} exited with code ${exit.code}. ${stderrTail}`,
          ),
        };
      }
      return;
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
