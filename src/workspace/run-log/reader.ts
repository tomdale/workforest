import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  compareRunEvents,
  parseRunEventLine,
  type RunEvent,
} from "./events.ts";

const SEGMENT_PATTERN = /^events\..+\.jsonl$/;
const NEWLINE_BYTE = 0x0a;

/**
 * Read and merge every segment file in a run directory. Events are ordered
 * by (ts, src, seq); torn trailing lines from crashed writers are skipped.
 */
export async function readRunEvents(runDir: string): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for (const segment of await listSegmentFiles(runDir)) {
    const contents = await fs.readFile(segment, "utf8");
    for (const line of contents.split("\n")) {
      const event = parseRunEventLine(line);
      if (event) events.push(event);
    }
  }
  return events.sort(compareRunEvents);
}

export type FollowRunEventsOptions = {
  /** How often to poll segment files for new bytes. */
  pollIntervalMs?: number;
  /** When false, start tailing from the current end of each segment. */
  fromStart?: boolean;
  signal?: AbortSignal;
};

type SegmentCursor = {
  offset: number;
  /** Bytes after the last newline; kept as a buffer so multi-byte UTF-8
   * characters split across polls are never corrupted. */
  partial: Buffer;
};

/**
 * Tail a run's segment files, yielding events as writers append them. New
 * worker segments are discovered as they appear. Ends after a `run-end`
 * event, when the run directory disappears, or when `signal` aborts.
 */
export async function* followRunEvents(
  runDir: string,
  {
    pollIntervalMs = 100,
    fromStart = true,
    signal,
  }: FollowRunEventsOptions = {},
): AsyncGenerator<RunEvent> {
  const segments = new Map<string, SegmentCursor>();

  if (!fromStart) {
    for (const segment of (await listSegmentFilesOrNull(runDir)) ?? []) {
      segments.set(segment, {
        offset: await fileSize(segment),
        partial: Buffer.alloc(0),
      });
    }
  }

  while (true) {
    if (signal?.aborted) return;

    const segmentFiles = await listSegmentFilesOrNull(runDir);
    if (segmentFiles === null) return;

    const batch: RunEvent[] = [];
    for (const segment of segmentFiles) {
      let cursor = segments.get(segment);
      if (!cursor) {
        cursor = { offset: 0, partial: Buffer.alloc(0) };
        segments.set(segment, cursor);
      }

      const chunk = await readChunk(segment, cursor.offset);
      if (chunk.offset < cursor.offset) {
        // The segment shrank (deleted and recreated); drop stale state.
        cursor.partial = Buffer.alloc(0);
      }
      cursor.offset = chunk.offset;
      if (chunk.contents.length === 0) continue;

      const combined = Buffer.concat([cursor.partial, chunk.contents]);
      const lastNewline = combined.lastIndexOf(NEWLINE_BYTE);
      if (lastNewline === -1) {
        cursor.partial = combined;
        continue;
      }
      cursor.partial = combined.subarray(lastNewline + 1);

      const complete = combined.subarray(0, lastNewline).toString("utf8");
      for (const line of complete.split("\n")) {
        const event = parseRunEventLine(line);
        if (event) batch.push(event);
      }
    }

    batch.sort(compareRunEvents);
    let ended = false;
    for (const event of batch) {
      yield event;
      if (event.kind === "run-end") ended = true;
    }
    if (ended) return;

    if (signal?.aborted) return;
    await delay(pollIntervalMs);
  }
}

async function listSegmentFiles(runDir: string): Promise<string[]> {
  const entries = await fs.readdir(runDir);
  return entries
    .filter((entry) => SEGMENT_PATTERN.test(entry))
    .sort()
    .map((entry) => path.join(runDir, entry));
}

async function listSegmentFilesOrNull(
  runDir: string,
): Promise<string[] | null> {
  try {
    return await listSegmentFiles(runDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function readChunk(
  filePath: string,
  offset: number,
): Promise<{ contents: Buffer; offset: number }> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const stat = await fs.stat(filePath);
    const start = stat.size < offset ? 0 : offset;
    const length = stat.size - start;
    if (length === 0) {
      return { contents: Buffer.alloc(0), offset: stat.size };
    }

    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return { contents: buffer, offset: stat.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { contents: Buffer.alloc(0), offset: 0 };
    }
    throw error;
  } finally {
    await handle?.close();
  }
}
