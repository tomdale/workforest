import type { TaskState } from "./task-generator.ts";

export type RetryBackoffOptions = {
  baseMs?: number;
  factor?: number;
  maxMs?: number;
};

export type RetryOptions = {
  attempts: number;
  label: string;
  backoff?: RetryBackoffOptions;
  /** Full jitter: each delay is a uniform draw up to the backoff value. */
  jitter?: boolean;
  /**
   * Runs before each retry attempt. Use it to clear state a failed attempt
   * left behind (e.g. a partially cloned directory).
   */
  onRetry?: (attempt: number, error: unknown) => Promise<void> | void;
};

const DEFAULT_BACKOFF: Required<RetryBackoffOptions> = {
  baseMs: 1_000,
  factor: 2,
  maxMs: 15_000,
};

/**
 * Compute the delay before retry attempt `attempt + 1` (exponential in the
 * failed attempt number, capped, with optional full jitter).
 */
export function computeRetryDelayMs(
  attempt: number,
  { backoff, jitter = true }: Pick<RetryOptions, "backoff" | "jitter">,
  random: () => number = Math.random,
): number {
  const { baseMs, factor, maxMs } = { ...DEFAULT_BACKOFF, ...backoff };
  const capped = Math.min(maxMs, baseMs * factor ** (attempt - 1));
  return jitter ? Math.round(capped / 2 + random() * (capped / 2)) : capped;
}

/**
 * Wraps a promise-returning function as a single-step task generator, so a
 * simple async operation can be passed to withRetry.
 */
export function asTask<T>(
  fn: () => Promise<T>,
): () => AsyncGenerator<TaskState, T, undefined> {
  return async function* () {
    yield { status: "running" };
    return await fn();
  };
}

/**
 * Retries a task generator with capped exponential backoff. Forwards all
 * states from the task generator except intermediate failures, which become
 * `retrying` states so surfaces can show attempt counts without treating
 * the task as failed.
 */
export async function* withRetry<T>(
  taskGen: () => AsyncGenerator<TaskState, T, undefined>,
  options: RetryOptions,
): AsyncGenerator<TaskState, T, undefined> {
  const { attempts, label, onRetry } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const gen = taskGen();
      while (true) {
        const result = await gen.next();
        if (result.done) {
          return result.value;
        }
        // Don't forward failed states during retries (except on last attempt)
        if (result.value.status === "failed" && attempt < attempts) {
          lastError = result.value.error;
          break;
        }
        yield result.value;
      }
    } catch (error_) {
      lastError = error_;
      if (attempt >= attempts) {
        throw lastError;
      }
    }

    const delayMs = computeRetryDelayMs(attempt, options);
    yield {
      status: "retrying",
      reason: `${label} failed: ${describeError(lastError)}`,
      attempt: attempt + 1,
    };
    await onRetry?.(attempt, lastError);
    await wait(delayMs);
  }

  throw lastError ?? new Error(`${label} failed after ${attempts} attempts.`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
