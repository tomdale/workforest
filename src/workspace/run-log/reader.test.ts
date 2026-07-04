import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunEvent } from "./events.ts";
import { followRunEvents, readRunEvents } from "./reader.ts";
import {
  MAX_OUTPUT_CHUNK_CHARS,
  RunEventWriter,
  segmentFileName,
} from "./writer.ts";

const tempDirs: string[] = [];

async function createRunDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workforest-runlog-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("run log writer + reader", () => {
  it("round-trips events through a segment file", async () => {
    const runDir = await createRunDir();
    const writer = new RunEventWriter({ runDir, runId: "run-1", src: "cli" });
    writer.emit({
      kind: "run-start",
      command: "new",
      repos: ["api"],
      scope: "workspace",
      pid: 1,
    });
    writer.emit({
      kind: "step-start",
      repo: "api",
      step: "git:mirror",
      title: "mirror",
    });
    await writer.close();

    const events = await readRunEvents(runDir);
    expect(events.map((event) => event.kind)).toEqual([
      "run-start",
      "step-start",
    ]);
    expect(events[0]).toMatchObject({ runId: "run-1", src: "cli", seq: 1 });
    expect(events[1]).toMatchObject({ seq: 2 });
  });

  it("merges multiple segments ordered by timestamp, src, and seq", async () => {
    const runDir = await createRunDir();
    const line = (src: string, seq: number, ts: string): string =>
      `${JSON.stringify({
        v: 1,
        runId: "run-1",
        src,
        seq,
        ts,
        kind: "repo-start",
        repo: src,
      })}\n`;

    await appendFile(
      path.join(runDir, segmentFileName("cli")),
      line("cli", 1, "2026-07-03T10:00:02.000Z") +
        line("cli", 2, "2026-07-03T10:00:02.000Z"),
      "utf8",
    );
    await appendFile(
      path.join(runDir, segmentFileName("worker:api")),
      line("worker:api", 1, "2026-07-03T10:00:01.000Z"),
      "utf8",
    );

    const events = await readRunEvents(runDir);
    expect(events.map((event) => [event.src, event.seq])).toEqual([
      ["worker:api", 1],
      ["cli", 1],
      ["cli", 2],
    ]);
  });

  it("skips torn trailing lines from a crashed writer", async () => {
    const runDir = await createRunDir();
    const writer = new RunEventWriter({ runDir, runId: "run-1", src: "cli" });
    writer.emit({ kind: "repo-start", repo: "api" });
    await writer.close();

    const segment = path.join(runDir, segmentFileName("cli"));
    await appendFile(segment, '{"v":1,"runId":"run-1","src":"cli","se', "utf8");

    const events = await readRunEvents(runDir);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("repo-start");
  });

  it("splits oversized output chunks across events", async () => {
    const runDir = await createRunDir();
    const writer = new RunEventWriter({ runDir, runId: "run-1", src: "cli" });
    const chunk = "x".repeat(MAX_OUTPUT_CHUNK_CHARS * 2 + 10);
    const written = writer.emit({
      kind: "step-output",
      repo: "api",
      step: "init:pnpm-install",
      chunk,
    });
    await writer.close();

    expect(written).toHaveLength(3);
    const events = await readRunEvents(runDir);
    const chunks = events
      .filter(
        (event): event is Extract<RunEvent, { kind: "step-output" }> =>
          event.kind === "step-output",
      )
      .map((event) => event.chunk);
    expect(chunks.join("")).toBe(chunk);
    expect(
      Math.max(...chunks.map((piece) => piece.length)),
    ).toBeLessThanOrEqual(MAX_OUTPUT_CHUNK_CHARS);
  });

  it("sanitizes writer ids into segment file names", async () => {
    const runDir = await createRunDir();
    const writer = new RunEventWriter({
      runDir,
      runId: "run-1",
      src: "worker:vercel/front",
    });
    writer.emit({ kind: "repo-start", repo: "vercel/front" });
    await writer.close();

    const contents = await readFile(
      path.join(runDir, "events.worker-vercel-front.jsonl"),
      "utf8",
    );
    expect(contents).toContain('"repo-start"');
  });
});

describe("followRunEvents", () => {
  it("tails live segments, discovers new writers, and ends on run-end", async () => {
    const runDir = await createRunDir();
    const cli = new RunEventWriter({ runDir, runId: "run-1", src: "cli" });
    cli.emit({
      kind: "run-start",
      command: "new",
      repos: ["api"],
      scope: "workspace",
      pid: 1,
    });
    await cli.flush();

    const seen: RunEvent[] = [];
    const follower = (async () => {
      for await (const event of followRunEvents(runDir, {
        pollIntervalMs: 10,
      })) {
        seen.push(event);
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 30));
    const worker = new RunEventWriter({
      runDir,
      runId: "run-1",
      src: "worker:api",
    });
    worker.emit({
      kind: "repo-end",
      repo: "api",
      outcome: "ready",
      hasLockfile: true,
    });
    await worker.flush();

    await new Promise((resolve) => setTimeout(resolve, 30));
    cli.emit({ kind: "run-end", outcome: "ready", durationMs: 1000 });
    await cli.flush();

    await follower;
    await cli.close();
    await worker.close();

    expect(seen.map((event) => event.kind)).toEqual([
      "run-start",
      "repo-end",
      "run-end",
    ]);
  });

  it("ends when the run directory disappears", async () => {
    const runDir = await createRunDir();
    const writer = new RunEventWriter({ runDir, runId: "run-1", src: "cli" });
    writer.emit({ kind: "repo-start", repo: "api" });
    await writer.close();

    const seen: string[] = [];
    const follower = (async () => {
      for await (const event of followRunEvents(runDir, {
        pollIntervalMs: 10,
      })) {
        seen.push(event.kind);
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 30));
    await rm(runDir, { recursive: true, force: true });
    await follower;

    expect(seen).toEqual(["repo-start"]);
  });

  it("supports starting from the current end of segments", async () => {
    const runDir = await createRunDir();
    const writer = new RunEventWriter({ runDir, runId: "run-1", src: "cli" });
    writer.emit({ kind: "repo-start", repo: "api" });
    await writer.flush();

    const seen: string[] = [];
    const follower = (async () => {
      for await (const event of followRunEvents(runDir, {
        pollIntervalMs: 10,
        fromStart: false,
      })) {
        seen.push(event.kind);
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 30));
    writer.emit({ kind: "run-end", outcome: "ready", durationMs: 5 });
    await writer.flush();
    await follower;
    await writer.close();

    expect(seen).toEqual(["run-end"]);
  });
});
