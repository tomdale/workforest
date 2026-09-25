import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tryAcquireLock, withLock } from "./lock.ts";

const tempDirs: string[] = [];
const DEAD_PID = 2 ** 22 + 11;

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function lockPath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workforest-lock-"));
  tempDirs.push(dir);
  return path.join(dir, "test.lock");
}

function owner(token: string, pid: number, host = os.hostname()): string {
  return JSON.stringify({ token, pid, host });
}

describe("activity locks", () => {
  it("grants exactly one of many concurrent acquirers", async () => {
    const file = await lockPath();
    const results = await Promise.all(
      Array.from({ length: 25 }, () => tryAcquireLock(file)),
    );
    expect(results.filter((lock) => lock !== null)).toHaveLength(1);
  });

  it("never publishes a partially written lock", async () => {
    const file = await lockPath();
    const lock = await tryAcquireLock(file);
    const content = JSON.parse(await readFile(file, "utf8")) as {
      token: string;
    };
    expect(content.token).toBe(lock?.token);
  });

  it("grants exactly one reclaimer of a dead owner's lock", async () => {
    const file = await lockPath();
    await writeFile(file, owner("dead", DEAD_PID));
    const results = await Promise.all(
      Array.from({ length: 25 }, () => tryAcquireLock(file)),
    );
    expect(results.filter((lock) => lock !== null)).toHaveLength(1);
  });

  it("does not let a delayed reclaimer delete a newer owner's lock", async () => {
    const file = await lockPath();
    await writeFile(file, owner("dead", DEAD_PID));
    let resume: () => void = () => {};
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let reachedReclaim: () => void = () => {};
    const atReclaim = new Promise<void>((resolve) => {
      reachedReclaim = resolve;
    });
    // The slow reclaimer reads the dead owner, then stalls.
    const slow = tryAcquireLock(file, {
      beforeReclaim: async () => {
        reachedReclaim();
        await paused;
      },
    });
    await atReclaim;
    const winner = await tryAcquireLock(file);
    expect(winner).not.toBeNull();
    resume();

    expect(await slow).toBeNull();
    const content = JSON.parse(await readFile(file, "utf8")) as {
      token: string;
    };
    expect(content.token).toBe(winner?.token);
  });

  it("recovers when a reclaimer crashed while holding the marker", async () => {
    const file = await lockPath();
    await writeFile(file, owner("dead-original", DEAD_PID));
    await writeFile(
      `${file}.reclaim-dead-original`,
      owner("dead-reclaimer", 2_147_483_647),
    );

    const lock = await tryAcquireLock(file);

    expect(lock).not.toBeNull();
    const content = JSON.parse(await readFile(file, "utf8")) as {
      token: string;
    };
    expect(content.token).toBe(lock?.token);
  });

  it("waits for a live reclaimer holding the marker", async () => {
    const file = await lockPath();
    await writeFile(file, owner("dead-original", DEAD_PID));
    await writeFile(
      `${file}.reclaim-dead-original`,
      owner("live-reclaimer", process.pid),
    );

    expect(await tryAcquireLock(file)).toBeNull();
    expect(await readFile(file, "utf8")).toContain("dead-original");
  });

  it("never evicts a live owner regardless of age", async () => {
    const file = await lockPath();
    await writeFile(file, owner("live", process.pid));
    expect(await tryAcquireLock(file)).toBeNull();
  });

  it("does not reclaim unreadable or foreign-host locks", async () => {
    const file = await lockPath();
    await writeFile(file, "");
    expect(await tryAcquireLock(file)).toBeNull();
    await writeFile(file, owner("remote", DEAD_PID, "another-host"));
    expect(await tryAcquireLock(file)).toBeNull();
  });

  it("releases only its own token", async () => {
    const file = await lockPath();
    const lock = await tryAcquireLock(file);
    await writeFile(file, owner("other", process.pid));
    await lock?.release();
    expect(await readFile(file, "utf8")).toContain('"other"');
  });

  it("serializes critical sections", async () => {
    const file = await lockPath();
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        withLock(file, async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await new Promise((resolve) => setTimeout(resolve, 2));
          inside -= 1;
        }),
      ),
    );
    expect(maxInside).toBe(1);
  });
});
