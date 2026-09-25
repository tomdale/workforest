import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceConfig } from "../types.ts";
import {
  writeWorkspaceMetadata,
  writeWorktreeMetadata,
} from "../workspace/metadata.ts";
import {
  type ActivityEngineOptions,
  generateForTarget,
  runService,
  runSweep,
} from "./engine.ts";
import {
  type DigestGenerator,
  type EvidencePacket,
  validateDigestOutput,
} from "./generate.ts";
import { readActivityViews, recordActivityInput } from "./index.ts";
import { observeTarget } from "./observe.ts";
import {
  DEFAULT_ACTIVITY_POLICY,
  decideGeneration,
  isCheckDue,
} from "./policy.ts";
import { activityKey, emptyRecord, mutateRecord, readRecord } from "./store.ts";
import { type ActivityTarget, collectActivityTargets } from "./targets.ts";
import type { ActivityRecord } from "./types.ts";

const tempDirs: string[] = [];
const MINUTE = 60_000;

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    { cwd, env: { ...process.env, ...env }, encoding: "utf8" },
  );
}

async function initRepo(dir: string, commitDate?: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(dir, ".gitignore"), "dist/\nnode_modules/\n");
  await writeFile(path.join(dir, "index.ts"), "export const value = 1;\n");
  git(dir, ["add", "."]);
  const env = commitDate
    ? { GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate }
    : {};
  git(dir, ["commit", "-q", "-m", "Initial commit"], env);
}

type Fixture = {
  base: string;
  root: string;
  config: WorkspaceConfig;
  worktreePath: string;
  workspacePath: string;
};

async function createFixture(options: { commitDate?: string } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "workforest-activity-"));
  tempDirs.push(base);
  const config: WorkspaceConfig = { directory: { base } };
  const repoRoot = path.join(base, "Repos", "widget");
  const worktreePath = path.join(repoRoot, "retry-logic");
  await initRepo(worktreePath, options.commitDate);
  await writeWorktreeMetadata(repoRoot, {
    featureName: "retry-logic",
    repos: [
      {
        name: "widget",
        remote: "https://example.com/widget.git",
        hasLockfile: false,
      },
    ],
  });

  const workspacePath = path.join(base, "Workspaces", "_adhoc", "billing");
  await initRepo(path.join(workspacePath, "api"), options.commitDate);
  await initRepo(path.join(workspacePath, "web"), options.commitDate);
  await initRepo(
    path.join(workspacePath, "_tasks", "api", "fix-tests"),
    options.commitDate,
  );
  await writeWorkspaceMetadata(workspacePath, {
    featureName: "billing",
    repos: [
      {
        name: "api",
        remote: "https://example.com/api.git",
        hasLockfile: false,
      },
      {
        name: "web",
        remote: "https://example.com/web.git",
        hasLockfile: false,
      },
    ],
  });
  const { appendTasks } = await import("../workspace/metadata.ts");
  await appendTasks(workspacePath, [
    {
      slug: "fix-tests",
      parent_repo: "api",
      path: "_tasks/api/fix-tests",
      branch: "billing--fix-tests",
      base_branch: "main",
      base_sha: "0000000000000000000000000000000000000000",
      created_at: new Date().toISOString(),
      setup_status: "skipped",
    },
  ]);

  return {
    base,
    root: path.join(base, "activity-store"),
    config,
    worktreePath,
    workspacePath,
  } satisfies Fixture;
}

function fakeClock(start = Date.now()) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function fakeGenerator(
  onCall?: (packet: EvidencePacket) => Promise<void> | void,
): DigestGenerator & { calls: EvidencePacket[] } {
  const calls: EvidencePacket[] = [];
  const generator = async (packet: EvidencePacket) => {
    calls.push(packet);
    await onCall?.(packet);
    return {
      output: {
        purpose: "Add retry logic",
        latest: `Observed ${packet.checkouts.length} checkouts`,
        likelyNext: null,
        likelyNextBasis: "unknown" as const,
        confidence: "medium" as const,
        insufficientContext: false,
        evidence: [],
      },
      provider: "fake",
      model: "fake-mini",
    };
  };
  return Object.assign(generator, { calls });
}

async function targetFor(fixture: Fixture, selector: string) {
  const targets = await collectActivityTargets(fixture.config);
  const target = targets.find((entry) => entry.identity.selector === selector);
  if (!target) throw new Error(`missing target ${selector}`);
  return target;
}

function engine(
  fixture: Fixture,
  generator: DigestGenerator,
  clock: ReturnType<typeof fakeClock>,
): ActivityEngineOptions {
  return { root: fixture.root, generator, now: clock.now };
}

describe("activity detection", () => {
  it("changes the fingerprint for repeated edits to an already dirty file", async () => {
    const fixture = await createFixture();
    const target = await targetFor(fixture, "widget/retry-logic");
    const clean = await observeTarget(target, null);

    await writeFile(path.join(fixture.worktreePath, "index.ts"), "edit 1\n");
    const firstEdit = await observeTarget(target, null);
    await writeFile(path.join(fixture.worktreePath, "index.ts"), "edit two\n");
    const secondEdit = await observeTarget(target, null);
    const unchanged = await observeTarget(target, null);

    expect(firstEdit.fingerprint).not.toBe(clean.fingerprint);
    expect(secondEdit.fingerprint).not.toBe(firstEdit.fingerprint);
    expect(unchanged.fingerprint).toBe(secondEdit.fingerprint);
  });

  it("ignores gitignored build and dependency output", async () => {
    const fixture = await createFixture();
    const target = await targetFor(fixture, "widget/retry-logic");
    const before = await observeTarget(target, null);

    await mkdir(path.join(fixture.worktreePath, "dist"), { recursive: true });
    await writeFile(path.join(fixture.worktreePath, "dist", "out.js"), "x");
    await mkdir(path.join(fixture.worktreePath, "node_modules", "pkg"), {
      recursive: true,
    });
    await writeFile(
      path.join(fixture.worktreePath, "node_modules", "pkg", "index.js"),
      "x",
    );

    expect((await observeTarget(target, null)).fingerprint).toBe(
      before.fingerprint,
    );
  });

  it("aggregates every repository and task checkout of a workspace", async () => {
    const fixture = await createFixture();
    const target = await targetFor(fixture, "_adhoc/billing");
    const before = await observeTarget(target, null);

    expect(target.checkouts.map((checkout) => checkout.label)).toEqual([
      "api",
      "web",
      "api/fix-tests",
    ]);
    await writeFile(
      path.join(fixture.workspacePath, "_tasks", "api", "fix-tests", "new.ts"),
      "x",
    );
    expect((await observeTarget(target, null)).fingerprint).not.toBe(
      before.fingerprint,
    );
  });

  it("gives a deleted and recreated checkout a new identity", async () => {
    const fixture = await createFixture();
    const clock = fakeClock();
    const target = await targetFor(fixture, "widget/retry-logic");
    await generateForTarget(
      target,
      engine(fixture, fakeGenerator(), clock),
      "force",
    );

    const recreated: ActivityTarget = {
      ...target,
      identity: {
        ...target.identity,
        createdAt: "2031-01-01T00:00:00.000Z",
        key: activityKey(target.identity.path, "2031-01-01T00:00:00.000Z"),
      },
    };

    expect(recreated.identity.key).not.toBe(target.identity.key);
    expect(await readRecord(fixture.root, recreated.identity.key)).toBeNull();
    expect(
      (await readRecord(fixture.root, target.identity.key))?.digest,
    ).not.toBeNull();
  });
});

describe("activity sweeps", () => {
  it("summarizes once and skips unchanged checkouts on later sweeps", async () => {
    const fixture = await createFixture();
    const clock = fakeClock();
    const generator = fakeGenerator();
    const targets = await collectActivityTargets(fixture.config);
    const options = engine(fixture, generator, clock);

    await runSweep(targets, options);
    expect(generator.calls).toHaveLength(0); // first sight: settling

    clock.advance(DEFAULT_ACTIVITY_POLICY.debounceMs);
    const second = await runSweep(targets, options);
    expect(second.generated).toBe(2);

    clock.advance(DEFAULT_ACTIVITY_POLICY.minIntervalMs * 3);
    const third = await runSweep(targets, options);
    expect(third.generated).toBe(0);
    expect(generator.calls).toHaveLength(2);

    const views = await readActivityViews(
      fixture.config,
      {},
      fixture.root,
      clock.now(),
    );
    expect(views.map((view) => view.freshness)).toEqual(["current", "current"]);
  });

  it("does not summarize inactive checkouts and only rechecks them occasionally", async () => {
    const fixture = await createFixture({ commitDate: "2020-01-01T00:00:00Z" });
    const clock = fakeClock();
    const generator = fakeGenerator();
    const targets = await collectActivityTargets(fixture.config);
    const options = engine(fixture, generator, clock);

    await runSweep(targets, options);
    clock.advance(DEFAULT_ACTIVITY_POLICY.maxDelayMs);
    const later = await runSweep(targets, options);

    expect(generator.calls).toHaveLength(0);
    expect(later.checked).toBe(0);

    clock.advance(DEFAULT_ACTIVITY_POLICY.discoveryIntervalMs);
    await writeFile(path.join(fixture.worktreePath, "index.ts"), "new work\n");
    const discovery = await runSweep(targets, options);
    expect(discovery.checked).toBe(2);
    expect(discovery.changed).toBe(1);
  });

  it("serializes sweeps across processes and reclaims dead owners", async () => {
    const fixture = await createFixture();
    const clock = fakeClock();
    const targets = await collectActivityTargets(fixture.config);
    const lockPath = path.join(fixture.root, "sweep.lock");
    await mkdir(fixture.root, { recursive: true });

    await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: 0 }));
    const blocked = await runSweep(
      targets,
      engine(fixture, fakeGenerator(), clock),
    );
    expect(blocked.skippedReason).toBe("already-running");

    await writeFile(lockPath, JSON.stringify({ pid: 2 ** 22 + 7, at: 0 }));
    const reclaimed = await runSweep(
      targets,
      engine(fixture, fakeGenerator(), clock),
    );
    expect(reclaimed.skippedReason).toBeUndefined();
    expect(reclaimed.checked).toBe(2);
  });

  it("runs a bounded service loop with a heartbeat and releases ownership", async () => {
    const fixture = await createFixture();
    const clock = fakeClock();
    const result = await runService({
      root: fixture.root,
      intervalMs: 5,
      collectTargets: () => collectActivityTargets(fixture.config),
      engine: { generator: fakeGenerator(), now: clock.now },
      maxSweeps: 2,
    });
    const { readServiceStatus } = await import("./engine.ts");
    const status = await readServiceStatus(fixture.root);

    expect(result).toBe("stopped");
    expect(status.state?.lastSweep?.targets).toBe(2);
    const again = await runService({
      root: fixture.root,
      intervalMs: 5,
      collectTargets: async () => [],
      engine: { generator: fakeGenerator(), now: clock.now },
      maxSweeps: 1,
    });
    expect(again).toBe("stopped");
  });
});

describe("activity generation", () => {
  it("never marks changes made during generation as current", async () => {
    const fixture = await createFixture();
    const clock = fakeClock();
    const target = await targetFor(fixture, "widget/retry-logic");
    const generator = fakeGenerator(async () => {
      await writeFile(path.join(fixture.worktreePath, "later.ts"), "x");
    });

    const outcome = await generateForTarget(
      target,
      engine(fixture, generator, clock),
      "force",
    );
    expect(outcome.result).toBe("generated");

    clock.advance(MINUTE);
    await runSweep([target], {
      ...engine(fixture, generator, clock),
      inferenceEnabled: false,
    });
    const [view] = await readActivityViews(
      fixture.config,
      { repo: "widget" },
      fixture.root,
      clock.now(),
    );
    expect(view?.freshness).toBe("outdated");
    expect(view?.latest).toBe("Observed 1 checkouts");
  });

  it("keeps the previous digest when a later generation fails", async () => {
    const fixture = await createFixture();
    const clock = fakeClock();
    const target = await targetFor(fixture, "widget/retry-logic");
    await generateForTarget(
      target,
      engine(fixture, fakeGenerator(), clock),
      "force",
    );

    await writeFile(path.join(fixture.worktreePath, "index.ts"), "changed\n");
    clock.advance(MINUTE);
    const failing: DigestGenerator = async () => {
      throw new Error("provider exploded");
    };
    const outcome = await generateForTarget(
      target,
      engine(fixture, failing, clock),
      "refresh",
    );
    const record = await readRecord(fixture.root, target.identity.key);

    expect(outcome.result).toBe("failed");
    expect(record?.digest?.latest).toBe("Observed 1 checkouts");
    expect(record?.generation.state).toBe("failed");
    expect(record?.generation.lastError).toBe("provider exploded");
    expect(
      decideGeneration(
        record as ActivityRecord,
        clock.now() + DEFAULT_ACTIVITY_POLICY.debounceMs,
      ),
    ).toMatchObject({ kind: "skip", reason: "backoff" });
  });

  it("does not let an older, slower run replace a newer digest", async () => {
    const fixture = await createFixture();
    const clock = fakeClock();
    const target = await targetFor(fixture, "widget/retry-logic");
    let releaseSlow: () => void = () => {};
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const slow = generateForTarget(
      target,
      engine(
        fixture,
        fakeGenerator(() => slowGate),
        clock,
      ),
      "force",
    );
    // Wait for the slow run's claim, then make it look abandoned.
    for (let i = 0; i < 100; i += 1) {
      const record = await readRecord(fixture.root, target.identity.key);
      if (record?.generation.state === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    clock.advance(DEFAULT_ACTIVITY_POLICY.staleRunMs);
    const newer = fakeGenerator();
    const fast = await generateForTarget(
      target,
      engine(
        fixture,
        async (packet, signal) => {
          const result = await newer(packet, signal);
          return {
            ...result,
            output: { ...result.output, latest: "newer run" },
          };
        },
        clock,
      ),
      "force",
    );
    releaseSlow();
    await slow;

    const record = await readRecord(fixture.root, target.identity.key);
    expect(fast.result).toBe("generated");
    expect(record?.digest?.latest).toBe("newer run");
    expect(record?.generation.state).toBe("idle");
  });

  it("reads cached views without running Git or a model", async () => {
    const fixture = await createFixture();
    const clock = fakeClock();
    const target = await targetFor(fixture, "widget/retry-logic");
    await generateForTarget(
      target,
      engine(fixture, fakeGenerator(), clock),
      "force",
    );

    const started = performance.now();
    const views = await readActivityViews(
      fixture.config,
      {},
      fixture.root,
      clock.now(),
    );
    const elapsed = performance.now() - started;

    expect(views).toHaveLength(2);
    expect(
      views.find((view) => view.selector === "_adhoc/billing")?.freshness,
    ).toBe("missing");
    expect(elapsed).toBeLessThan(500);
  });

  it("lets explicit purpose and handoff notes outrank inference", async () => {
    const fixture = await createFixture();
    const clock = fakeClock();
    const target = await targetFor(fixture, "widget/retry-logic");
    await generateForTarget(
      target,
      engine(fixture, fakeGenerator(), clock),
      "force",
    );
    clock.advance(MINUTE);

    await recordActivityInput(
      target,
      { kind: "purpose", purpose: "Ship retries" },
      fixture.root,
      clock.now(),
    );
    const view = await recordActivityInput(
      target,
      {
        kind: "note",
        source: "bb:thr_1",
        summary: "Added tests",
        next: "Wire CLI",
      },
      fixture.root,
      clock.now(),
    );

    expect(view.purpose).toBe("Ship retries");
    expect(view.purposeSource).toBe("user");
    expect(view.likelyNext).toBe("Wire CLI");
    expect(view.likelyNextBasis).toBe("handoff");
    const packetSeen = fakeGenerator();
    clock.advance(MINUTE);
    await generateForTarget(
      target,
      engine(fixture, packetSeen, clock),
      "refresh",
    );
    expect(packetSeen.calls[0]?.userPurpose).toBe("Ship retries");
    expect(packetSeen.calls[0]?.handoffs[0]?.next).toBe("Wire CLI");
  });
});

describe("activity policy", () => {
  const nowMs = Date.parse("2030-01-01T12:00:00.000Z");
  function record(
    overrides: Partial<ActivityRecord["observation"] & object> = {},
    digest = false,
  ): ActivityRecord {
    const base = emptyRecord({
      key: "k",
      selector: "repo/x",
      type: "worktree",
      path: "/tmp/x",
      createdAt: "2030-01-01T00:00:00.000Z",
    });
    return {
      ...base,
      observation: {
        fingerprint: "new",
        checkedAt: new Date(nowMs).toISOString(),
        lastActivityAt: new Date(nowMs).toISOString(),
        pendingSince: new Date(nowMs).toISOString(),
        ...overrides,
      },
      digest: digest
        ? {
            purpose: null,
            purposeSource: null,
            latest: "old",
            likelyNext: null,
            likelyNextBasis: null,
            confidence: "low",
            insufficientContext: false,
            evidence: [],
            observedThrough: new Date(nowMs - 60 * MINUTE).toISOString(),
            generatedAt: new Date(nowMs - 60 * MINUTE).toISOString(),
            fingerprint: "old",
            provider: "fake",
            model: null,
            promptVersion: 1,
          }
        : null,
    };
  }

  it("debounces continuous changes but enforces a maximum delay", () => {
    expect(decideGeneration(record(), nowMs)).toMatchObject({
      kind: "skip",
      reason: "debouncing",
    });
    const continuous = record({
      pendingSince: new Date(
        nowMs - DEFAULT_ACTIVITY_POLICY.maxDelayMs,
      ).toISOString(),
    });
    expect(decideGeneration(continuous, nowMs)).toEqual({
      kind: "generate",
      fingerprint: "new",
    });
  });

  it("spaces generations by the minimum interval", () => {
    const recent = record(
      { lastActivityAt: new Date(nowMs - 5 * MINUTE).toISOString() },
      true,
    );
    const spaced = {
      ...recent,
      digest: recent.digest && {
        ...recent.digest,
        generatedAt: new Date(nowMs - MINUTE).toISOString(),
      },
    };
    expect(decideGeneration(recent, nowMs).kind).toBe("generate");
    expect(decideGeneration(spaced, nowMs)).toMatchObject({
      reason: "min-interval",
    });
  });

  it("treats an abandoned running claim as retryable", () => {
    const settled = record({
      lastActivityAt: new Date(nowMs - 5 * MINUTE).toISOString(),
    });
    const running: ActivityRecord = {
      ...settled,
      generation: {
        ...settled.generation,
        state: "running",
        pid: 1,
        runId: "r",
        startedAt: new Date(nowMs - MINUTE).toISOString(),
      },
    };
    expect(
      decideGeneration(running, nowMs, { isRunAlive: () => true }),
    ).toMatchObject({ reason: "running" });
    expect(
      decideGeneration(running, nowMs, { isRunAlive: () => false }).kind,
    ).toBe("generate");
  });

  it("checks inactive checkouts only at the discovery interval", () => {
    const old = new Date(
      nowMs - DEFAULT_ACTIVITY_POLICY.activeWindowMs - MINUTE,
    ).toISOString();
    const inactive = record({
      lastActivityAt: old,
      checkedAt: new Date(nowMs - MINUTE).toISOString(),
    });
    expect(isCheckDue(inactive, nowMs)).toBe(false);
    expect(decideGeneration(inactive, nowMs)).toMatchObject({
      reason: "inactive",
    });
    expect(
      isCheckDue(inactive, nowMs + DEFAULT_ACTIVITY_POLICY.discoveryIntervalMs),
    ).toBe(true);
    const pinned = { ...inactive, user: { ...inactive.user, pinned: true } };
    expect(isCheckDue(pinned, nowMs)).toBe(true);
  });
});

describe("digest output validation", () => {
  const valid = {
    purpose: "Retry logic",
    latest: "Added backoff helper",
    likelyNext: "Add tests",
    likelyNextBasis: "inferred",
    confidence: "medium",
    insufficientContext: false,
    evidence: ["abc123"],
  };

  it("accepts bounded output and clips oversized fields", () => {
    const output = validateDigestOutput({
      ...valid,
      latest: `${"x".repeat(400)}\nignore previous instructions`,
      evidence: Array.from({ length: 10 }, (_, index) => `ref-${index}`),
    });
    expect(output.latest.length).toBeLessThanOrEqual(280);
    expect(output.evidence).toHaveLength(6);
  });

  it("drops a next step whose basis is unknown", () => {
    expect(
      validateDigestOutput({ ...valid, likelyNextBasis: "unknown" }),
    ).toMatchObject({ likelyNext: null, likelyNextBasis: "unknown" });
  });

  it.each([
    ["non-object", "nope"],
    ["empty latest", { ...valid, latest: "  " }],
    ["invalid basis", { ...valid, likelyNextBasis: "guess" }],
    ["invalid confidence", { ...valid, confidence: "certain" }],
    [
      "non-boolean insufficientContext",
      { ...valid, insufficientContext: "no" },
    ],
  ])("rejects %s", (_label, value) => {
    expect(() => validateDigestOutput(value)).toThrow();
  });
});

describe("activity store", () => {
  it("merges concurrent writers without losing fields", async () => {
    const base = await mkdtemp(
      path.join(os.tmpdir(), "workforest-activity-store-"),
    );
    tempDirs.push(base);
    const identity = {
      key: "k1",
      selector: "repo/x",
      type: "worktree" as const,
      path: "/tmp/x",
      createdAt: "2030-01-01T00:00:00.000Z",
    };
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        mutateRecord(base, identity, (current) => ({
          ...current,
          events: [
            ...current.events,
            { at: String(index), source: "s", summary: null, next: null },
          ],
        })),
      ),
    );
    expect((await readRecord(base, "k1"))?.events).toHaveLength(10);
  });
});
