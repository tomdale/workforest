import { promises as fs } from "node:fs";
import path from "node:path";
import { getCacheDir } from "../config.ts";
import type { DisposeWorktreeEvent } from "./dispose-worktree.ts";

const LOG_DIRNAME = "system-logs";
const LOG_PREFIX = "delete-";
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type DeleteSystemLogEntry = Readonly<{
  timestamp: string;
  event: DisposeWorktreeEvent;
}>;

/** Best-effort internal diagnostics for investigating slow deletion. */
export type DeleteSystemLogger = Readonly<{
  record(event: DisposeWorktreeEvent): Promise<void>;
  flush(): Promise<void>;
}>;

export function createDeleteSystemLogger(
  now: () => Date = () => new Date(),
): DeleteSystemLogger {
  let queue = Promise.resolve();

  return {
    record(event) {
      queue = queue
        .catch(() => undefined)
        .then(async () => {
          const current = now();
          const directory = path.join(getCacheDir(), LOG_DIRNAME);
          await fs.mkdir(directory, { recursive: true });
          const filename = `${LOG_PREFIX}${current.toISOString().slice(0, 10)}.ndjson`;
          const logPath = path.join(directory, filename);
          const entry: DeleteSystemLogEntry = {
            timestamp: current.toISOString(),
            event,
          };
          await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
          await removeExpiredLogs(directory, current.getTime());
        });
      return queue.catch(() => undefined);
    },
    flush() {
      return queue.catch(() => undefined);
    },
  };
}

async function removeExpiredLogs(
  directory: string,
  nowMs: number,
): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.startsWith(LOG_PREFIX) &&
          entry.name.endsWith(".ndjson"),
      )
      .map(async (entry) => {
        const target = path.join(directory, entry.name);
        const stat = await fs.stat(target);
        if (nowMs - stat.mtimeMs > RETENTION_MS) {
          await fs.rm(target, { force: true });
        }
      }),
  );
}
