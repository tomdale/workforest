import { createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";
import type { RunEvent, RunEventBody } from "./events.ts";

/** Output chunks larger than this are split across multiple events. */
export const MAX_OUTPUT_CHUNK_CHARS = 8 * 1024;

/**
 * Once a segment has recorded this much step output, further output events
 * are dropped (a single warning event marks the truncation). Bounds JSONL
 * growth for pathological command output.
 */
export const MAX_SEGMENT_OUTPUT_BYTES = 32 * 1024 * 1024;

export function segmentFileName(src: string): string {
  const slug = src.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `events.${slug}.jsonl`;
}

export type RunEventWriterOptions = {
  runDir: string;
  runId: string;
  /** Writer id recorded in every envelope, e.g. "cli" or `worker:<repo>`. */
  src: string;
};

/**
 * Appends run events to this process's segment file. Exactly one writer owns
 * a segment for its whole life, so events within a segment are totally
 * ordered by `seq` and no cross-process locking is needed.
 */
export class RunEventWriter {
  readonly #runId: string;
  readonly #src: string;
  readonly #stream: WriteStream;
  #seq = 0;
  #outputBytes = 0;
  #outputTruncated = false;
  #pendingWrites: Promise<void> = Promise.resolve();
  #writeError: Error | null = null;

  constructor({ runDir, runId, src }: RunEventWriterOptions) {
    this.#runId = runId;
    this.#src = src;
    this.#stream = createWriteStream(path.join(runDir, segmentFileName(src)), {
      flags: "a",
      encoding: "utf8",
    });
    this.#stream.on("error", (error) => {
      this.#writeError = error;
    });
  }

  /**
   * Stamp the envelope and append the event. Oversized output chunks are
   * split; output beyond the segment cap is dropped after a warning event.
   * Returns every event actually recorded (usually one).
   */
  emit(body: RunEventBody): readonly RunEvent[] {
    const events = this.#expand(body).map((expanded) => this.#stamp(expanded));
    for (const event of events) {
      this.#enqueue(`${JSON.stringify(event)}\n`);
    }
    return events;
  }

  async flush(): Promise<void> {
    await this.#pendingWrites;
    if (this.#writeError) throw this.#writeError;
  }

  async close(): Promise<void> {
    await this.#pendingWrites;
    if (!this.#stream.closed && !this.#stream.destroyed) {
      const finished = new Promise<void>((resolve) => {
        const settle = (): void => {
          this.#stream.off("finish", settle);
          this.#stream.off("close", settle);
          this.#stream.off("error", settle);
          resolve();
        };
        this.#stream.once("finish", settle);
        this.#stream.once("close", settle);
        this.#stream.once("error", settle);
      });
      this.#stream.end();
      await finished;
    }
    if (this.#writeError) throw this.#writeError;
  }

  #expand(body: RunEventBody): RunEventBody[] {
    if (body.kind !== "step-output") return [body];

    const chunkBytes = Buffer.byteLength(body.chunk, "utf8");
    if (this.#outputBytes + chunkBytes > MAX_SEGMENT_OUTPUT_BYTES) {
      if (this.#outputTruncated) return [];
      this.#outputTruncated = true;
      return [
        {
          kind: "step-log",
          repo: body.repo,
          step: body.step,
          level: "warn",
          message:
            "Command output exceeded the run log limit; further output is omitted from this run log.",
        },
      ];
    }
    this.#outputBytes += chunkBytes;

    if (body.chunk.length <= MAX_OUTPUT_CHUNK_CHARS) return [body];
    const pieces: RunEventBody[] = [];
    for (let i = 0; i < body.chunk.length; i += MAX_OUTPUT_CHUNK_CHARS) {
      pieces.push({
        ...body,
        chunk: body.chunk.slice(i, i + MAX_OUTPUT_CHUNK_CHARS),
      });
    }
    return pieces;
  }

  #stamp(body: RunEventBody): RunEvent {
    this.#seq += 1;
    return {
      v: 1,
      runId: this.#runId,
      src: this.#src,
      seq: this.#seq,
      ts: new Date().toISOString(),
      ...body,
    };
  }

  #enqueue(line: string): void {
    this.#pendingWrites = this.#pendingWrites.then(
      () =>
        new Promise<void>((resolve) => {
          if (
            this.#writeError ||
            this.#stream.closed ||
            this.#stream.destroyed
          ) {
            resolve();
            return;
          }
          // The callback fires once the bytes reach the file, so flush()
          // means "visible to readers", not just "buffered in the stream".
          this.#stream.write(line, "utf8", (error) => {
            if (error) this.#writeError ??= error;
            resolve();
          });
        }),
    );
  }
}
