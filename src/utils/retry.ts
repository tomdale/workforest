import { log } from "../logger.ts";

export type RetryOptions = {
  attempts: number;
  label: string;
};

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
        log.warn(
          `${label} failed (attempt ${attempt}/${attempts}). Retrying in ${delay}ms...`,
        );
        await wait(delay);
      } else {
        log.warn(`${label} failed on final attempt (${attempts}/${attempts}).`);
      }
    }
  }

  throw lastError ?? new Error(`${label} failed after ${attempts} attempts.`);
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
