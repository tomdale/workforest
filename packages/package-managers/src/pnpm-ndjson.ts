import type { TaskState } from "@wf-plugin/core";

type PnpmEvent = {
  name?: unknown;
  status?: unknown;
  current?: unknown;
  total?: unknown;
  prefix?: unknown;
};

/**
 * Converts pnpm's documented NDJSON reporter into stable progress states while
 * retaining the raw stream for persisted diagnostics.
 */
export class PnpmNdjsonAdapter {
  #buffer = "";
  #source: "stdout" | "stderr" | undefined;

  *push(state: TaskState): Generator<TaskState> {
    if (state.status !== "output" || state.source === "stderr") {
      yield state;
      return;
    }

    this.#buffer += state.data;
    this.#source = state.source;
    yield* this.#drain();
  }

  /** Flush a final unterminated record when the child closes. */
  *finish(): Generator<TaskState> {
    if (this.#buffer) {
      const line = this.#buffer;
      const source = this.#source;
      this.#buffer = "";
      this.#source = undefined;
      yield* this.#record(line, source);
    }
  }

  *#drain(): Generator<TaskState> {
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline + 1);
      this.#buffer = this.#buffer.slice(newline + 1);
      yield* this.#record(line, this.#source);
      newline = this.#buffer.indexOf("\n");
    }
  }

  *#record(
    line: string,
    source: "stdout" | "stderr" | undefined,
  ): Generator<TaskState> {
    const parsed = parseRecord(line);
    const progress = parsed ? progressOf(parsed) : undefined;
    yield {
      status: "output",
      data: line,
      ...(source !== undefined ? { source } : {}),
      ...(parsed ? { format: "ndjson" as const } : {}),
    };
    if (progress) yield { status: "progress", progress };
  }
}

function parseRecord(line: string): PnpmEvent | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as PnpmEvent)
      : undefined;
  } catch {
    return undefined;
  }
}

function progressOf(event: PnpmEvent):
  | { current?: number; total?: number; message?: string }
  | undefined {
  if (event.name !== "pnpm:progress") return undefined;
  const current = finite(event.current);
  const total = finite(event.total);
  const status = typeof event.status === "string" ? event.status : undefined;
  return {
    ...(current !== undefined ? { current } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(status !== undefined ? { message: `pnpm ${status}` } : {}),
  };
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
