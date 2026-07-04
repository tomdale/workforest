import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceInitializationScope } from "../initialization-scope.ts";
import type { RunEvent, RunEventBody } from "./events.ts";
import { readRunEvents } from "./reader.ts";
import { createRunSession, openWorkerRunSession } from "./session.ts";

const tempDirs: string[] = [];

async function createScope() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workforest-session-"));
  tempDirs.push(dir);
  return workspaceInitializationScope(dir);
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("createRunSession", () => {
  it("mints a run, records the run-start event, and reduces state", async () => {
    const scope = await createScope();
    const session = await createRunSession({
      scope,
      command: "new",
      repos: ["api", "docs"],
    });
    await session.close();

    const events = await readRunEvents(session.runDir);
    expect(events[0]).toMatchObject({
      kind: "run-start",
      command: "new",
      repos: ["api", "docs"],
    });
    expect([...session.snapshot().repos.keys()]).toEqual(["api", "docs"]);
  });

  it("records a body stream, preserving the generator's return value", async () => {
    const scope = await createScope();
    const session = await createRunSession({
      scope,
      command: "new",
      repos: ["api"],
    });

    async function* bodies(): AsyncGenerator<RunEventBody, "done"> {
      yield { kind: "repo-start", repo: "api" };
      yield {
        kind: "step-start",
        repo: "api",
        step: "git:mirror",
        title: "mirror",
      };
      return "done";
    }

    const recorded: RunEvent[] = [];
    const generator = session.record(bodies());
    let result: IteratorResult<RunEvent, "done">;
    while (true) {
      result = await generator.next();
      if (result.done) break;
      recorded.push(result.value);
    }
    await session.close();

    expect(result.value).toBe("done");
    expect(recorded.map((event) => event.kind)).toEqual([
      "repo-start",
      "step-start",
    ]);
    const persisted = await readRunEvents(session.runDir);
    expect(persisted.map((event) => event.kind)).toEqual([
      "run-start",
      "repo-start",
      "step-start",
    ]);
    expect(session.snapshot().repos.get("api")?.status).toBe("running");
  });

  it("fans events out to subscribers until close", async () => {
    const scope = await createScope();
    const session = await createRunSession({
      scope,
      command: "new",
      repos: ["api"],
    });

    const seen: string[] = [];
    const subscription = (async () => {
      for await (const event of session.subscribe()) {
        seen.push(event.kind);
      }
    })();

    session.emit({ kind: "repo-start", repo: "api" });
    session.emit({
      kind: "repo-end",
      repo: "api",
      outcome: "ready",
      hasLockfile: false,
    });
    await session.close();
    await subscription;

    expect(seen).toEqual(["repo-start", "repo-end"]);
  });

  it("closes an abandoned body stream so its cleanup runs", async () => {
    const scope = await createScope();
    const session = await createRunSession({
      scope,
      command: "new",
      repos: ["api"],
    });

    let cleanedUp = false;
    async function* bodies(): AsyncGenerator<RunEventBody, void> {
      try {
        yield { kind: "repo-start", repo: "api" };
        yield { kind: "repo-start", repo: "api" };
      } finally {
        cleanedUp = true;
      }
    }

    const generator = session.record(bodies());
    await generator.next();
    await generator.return(undefined);
    await session.close();

    expect(cleanedUp).toBe(true);
  });
});

describe("openWorkerRunSession", () => {
  it("appends a worker segment to the foreground run", async () => {
    const scope = await createScope();
    const foreground = await createRunSession({
      scope,
      command: "new",
      repos: ["api"],
    });
    await foreground.close();

    const worker = await openWorkerRunSession({
      scope,
      repoName: "api",
      runId: foreground.runId,
    });
    worker.emit({
      kind: "repo-end",
      repo: "api",
      outcome: "ready",
      hasLockfile: true,
    });
    await worker.close();

    expect(worker.runId).toBe(foreground.runId);
    const segments = (await readdir(foreground.runDir)).filter((entry) =>
      entry.startsWith("events."),
    );
    expect(segments.sort()).toEqual([
      "events.cli.jsonl",
      "events.worker-api.jsonl",
    ]);

    const events = await readRunEvents(foreground.runDir);
    expect(events.at(-1)).toMatchObject({
      kind: "repo-end",
      src: "worker:api",
      runId: foreground.runId,
    });
  });

  it("falls back to a self-created run when the foreground run is unknown", async () => {
    const scope = await createScope();
    const worker = await openWorkerRunSession({
      scope,
      repoName: "api",
      runId: undefined,
    });
    worker.emit({
      kind: "repo-end",
      repo: "api",
      outcome: "ready",
      hasLockfile: false,
    });
    await worker.close();

    const events = await readRunEvents(worker.runDir);
    expect(events.map((event) => event.kind)).toEqual([
      "run-start",
      "repo-end",
    ]);
    expect(events[0]).toMatchObject({ command: "initializer" });
  });
});
