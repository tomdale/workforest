import {
  spawnCommand as coreSpawnCommand,
  type RunCommandOptions,
  type SpawnedCommandHandle,
  type TaskGenerator,
} from "@wf-plugin/core";

export type {
  RunCommandOptions,
  SpawnedCommandHandle,
  TaskGenerator,
  TaskState,
} from "@wf-plugin/core";

const activeCommandHandles = new Set<SpawnedCommandHandle>();

/**
 * Spawns a command and yields state updates as it runs. Thin wrapper around
 * core's spawnCommand (the same implementation the package manager
 * initializers use directly): tracks the resulting handle so
 * terminateRunningCommands can stop everything this process started.
 */
export function spawnCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): TaskGenerator {
  return coreSpawnCommand(command, args, {
    ...options,
    onSpawn: (handle) => {
      activeCommandHandles.add(handle);
      void handle.wait().finally(() => {
        activeCommandHandles.delete(handle);
      });
      options.onSpawn?.(handle);
    },
  });
}

/**
 * Stops every command this process has spawned via spawnCommand. Used on
 * shutdown paths (Ctrl-C, fatal error) so orphaned children don't outlive
 * the CLI.
 */
export async function terminateRunningCommands(): Promise<void> {
  const handles = [...activeCommandHandles];
  if (handles.length === 0) return;

  for (const handle of handles) {
    handle.kill("SIGTERM");
  }

  await Promise.race([
    Promise.all(handles.map((handle) => handle.wait())),
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ]);

  for (const handle of handles) {
    if (activeCommandHandles.has(handle)) {
      handle.kill("SIGKILL");
    }
  }
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
