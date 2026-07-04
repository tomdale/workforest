import type { InitializationScope } from "../initialization-scope.ts";
import type { RunEvent, RunEventBody } from "./events.ts";
import { createRunReducer, type RunSnapshot } from "./reducer.ts";
import {
  createRunDir,
  createRunId,
  getRunDir,
  readRunManifest,
} from "./store.ts";
import { RunEventWriter } from "./writer.ts";

/**
 * One process's handle on a run: stamps and appends events to this process's
 * segment file, keeps a live reduced snapshot, and fans events out to any
 * in-process subscribers.
 */
export type RunSession = {
  readonly runId: string;
  readonly runDir: string;
  readonly startedAtMs: number;
  /**
   * Record a stream of event bodies, yielding each stamped event. The
   * generator's return value passes through.
   */
  record<TReturn>(
    bodies: AsyncGenerator<RunEventBody, TReturn>,
  ): AsyncGenerator<RunEvent, TReturn>;
  /** Record one event. Returns what was written (output may split or drop). */
  emit(body: RunEventBody): readonly RunEvent[];
  /** Live feed of every event this session records; ends on close(). */
  subscribe(): AsyncGenerator<RunEvent>;
  snapshot(): RunSnapshot;
  close(): Promise<void>;
};

type Subscriber = {
  queue: RunEvent[];
  wake: (() => void) | null;
};

export type CreateRunSessionOptions = {
  scope: InitializationScope;
  /** The user-facing operation producing this run, e.g. "new" or "retry". */
  command: string;
  repos: readonly string[];
  src?: string;
};

export async function createRunSession({
  scope,
  command,
  repos,
  src = "cli",
}: CreateRunSessionOptions): Promise<RunSession> {
  const runId = createRunId();
  const startedAt = new Date().toISOString();
  const runDir = await createRunDir(scope, {
    v: 1,
    runId,
    startedAt,
    command,
    repos,
    scopeKind: scope.kind,
  });

  const session = openSession({
    runDir,
    runId,
    src,
    startedAtMs: Date.parse(startedAt),
  });
  session.emit({
    kind: "run-start",
    command,
    repos,
    scope: scope.kind,
    pid: process.pid,
  });
  return session;
}

export type OpenWorkerRunSessionOptions = {
  scope: InitializationScope;
  repoName: string;
  /**
   * The run minted by the foreground command. When absent or unknown (for
   * example a version-skewed worker), the worker records into a fresh run of
   * its own so events are never lost.
   */
  runId?: string | undefined;
};

export async function openWorkerRunSession({
  scope,
  repoName,
  runId,
}: OpenWorkerRunSessionOptions): Promise<RunSession> {
  const src = `worker:${repoName}`;

  if (runId !== undefined) {
    try {
      const runDir = getRunDir(scope, runId);
      const manifest = await readRunManifest(runDir);
      if (manifest) {
        return openSession({
          runDir,
          runId,
          src,
          startedAtMs: Date.parse(manifest.startedAt),
        });
      }
    } catch {
      // Invalid or missing run; fall through to a self-created run.
    }
  }

  const fallbackId = createRunId();
  const startedAt = new Date().toISOString();
  const runDir = await createRunDir(scope, {
    v: 1,
    runId: fallbackId,
    startedAt,
    command: "initializer",
    repos: [repoName],
    scopeKind: scope.kind,
  });
  const session = openSession({
    runDir,
    runId: fallbackId,
    src,
    startedAtMs: Date.parse(startedAt),
  });
  session.emit({
    kind: "run-start",
    command: "initializer",
    repos: [repoName],
    scope: scope.kind,
    pid: process.pid,
  });
  return session;
}

function openSession({
  runDir,
  runId,
  src,
  startedAtMs: startedAtOption,
}: {
  runDir: string;
  runId: string;
  src: string;
  startedAtMs: number;
}): RunSession {
  const writer = new RunEventWriter({ runDir, runId, src });
  const reducer = createRunReducer();
  const subscribers = new Set<Subscriber>();
  const startedAtMs = Number.isFinite(startedAtOption)
    ? startedAtOption
    : Date.now();
  let closed = false;

  const broadcast = (event: RunEvent): void => {
    for (const subscriber of subscribers) {
      subscriber.queue.push(event);
      subscriber.wake?.();
      subscriber.wake = null;
    }
  };

  const emit = (body: RunEventBody): readonly RunEvent[] => {
    if (closed) return [];
    const events = writer.emit(body);
    for (const event of events) {
      reducer.apply(event);
      broadcast(event);
    }
    return events;
  };

  return {
    runId,
    runDir,
    startedAtMs,

    emit,

    async *record<TReturn>(
      bodies: AsyncGenerator<RunEventBody, TReturn>,
    ): AsyncGenerator<RunEvent, TReturn> {
      let finished = false;
      try {
        while (true) {
          const next = await bodies.next();
          if (next.done) {
            finished = true;
            return next.value;
          }
          for (const event of emit(next.value)) {
            yield event;
          }
        }
      } finally {
        if (!finished) {
          // The consumer abandoned us mid-stream; close the source so its
          // own finally blocks run. The forced return value is never read.
          await bodies
            .return(undefined as unknown as TReturn)
            .catch(() => undefined);
        }
      }
    },

    async *subscribe(): AsyncGenerator<RunEvent> {
      const subscriber: Subscriber = { queue: [], wake: null };
      subscribers.add(subscriber);
      try {
        while (true) {
          while (subscriber.queue.length > 0) {
            const event = subscriber.queue.shift();
            if (event) yield event;
          }
          if (closed) return;
          await new Promise<void>((resolve) => {
            subscriber.wake = resolve;
          });
        }
      } finally {
        subscribers.delete(subscriber);
      }
    },

    snapshot: () => reducer.snapshot(),

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const subscriber of subscribers) {
        subscriber.wake?.();
        subscriber.wake = null;
      }
      await writer.close();
    },
  };
}
