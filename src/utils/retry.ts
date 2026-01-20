import type { TaskState } from "./task-generator.ts";

export type RetryOptions = {
  attempts: number;
  label: string;
};

/**
 * Wraps a promise-returning function as a generator.
 * This is useful when you need to pass a simple async operation to withRetryGenerator.
 */
export function asGenerator<T>(
  fn: () => Promise<T>,
): () => AsyncGenerator<TaskState, T, undefined> {
  return async function* () {
    yield { status: "running" };
    return await fn();
  };
}

/**
 * Generator-based retry that yields log messages for retry warnings.
 * Forwards all states from the task generator.
 */
export async function* withRetryGenerator<T>(
  taskGen: () => AsyncGenerator<TaskState, T, undefined>,
  { attempts, label }: RetryOptions,
): AsyncGenerator<TaskState, T, undefined> {
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

      // If we got here via a break, we need to retry
      const delay = attempt * 1000;
      yield {
        status: "log",
        level: "warn",
        message: `${label} failed (attempt ${attempt}/${attempts}). Retrying in ${delay}ms...`,
      };
      await wait(delay);
    } catch (error_) {
      lastError = error_;
      const delay = attempt * 1000;
      if (attempt < attempts) {
        yield {
          status: "log",
          level: "warn",
          message: `${label} failed (attempt ${attempt}/${attempts}). Retrying in ${delay}ms...`,
        };
        await wait(delay);
      } else {
        yield {
          status: "log",
          level: "warn",
          message: `${label} failed on final attempt (${attempts}/${attempts}).`,
        };
      }
    }
  }

  throw lastError ?? new Error(`${label} failed after ${attempts} attempts.`);
}

/**
 * @deprecated Use withRetryGenerator for generator-based tasks.
 * Promise-based retry for backwards compatibility.
 */
export async function withRetry<T>(
  task: () => Promise<T>,
  { attempts, label }: RetryOptions,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error_) {
      lastError = error_;
      const delay = attempt * 1000;
      if (attempt < attempts) {
        // In non-generator context, warnings are silently dropped
        // Callers should migrate to withRetryGenerator
        await wait(delay);
      }
    }
  }

  throw lastError ?? new Error(`${label} failed after ${attempts} attempts.`);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
