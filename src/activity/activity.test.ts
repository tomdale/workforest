import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceConfig } from "../types.ts";
import {
  appendTasks,
  writeWorkspaceMetadata,
  writeWorktreeMetadata,
} from "../workspace/metadata.ts";
import {
  type ActivityEngineOptions,
  generateForTarget,
  readServiceStatus,
  runService,
  runSweep,
} from "./engine.ts";
import {
  boundPacket,
  collectEvidence,
  type DigestGenerator,
  type EvidencePacket,
  validateDigestOutput,
} from "./generate.ts";
import { readActivityView, recordActivityInput } from "./index.ts";
import { observeTarget } from "./observe.ts";
import {
  DEFAULT_ACTIVITY_POLICY,
  decideGeneration,
  isCheckDue,
} from "./policy.ts";
import {
  type ActivityPaths,
  activityKey,
  emptyInputs,
  emptyRecord,
  mutateRecord,
  readInputs,
  readRecord,
} from "./store.ts";
import { type ActivityTarget, collectActivityTargets } from "./targets.ts";
import type { ActivityRecord, ActivityState } from "./types.ts";

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

function dateEnv(date?: string): NodeJS.ProcessEnv {
  return date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
}

/** A repo whose `main` holds shared history (several upstream commits). */
async function initRepo(dir: string, commitDate?: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(dir, ".gitignore"), "dist/\nnode_modules/\n");
  await writeFile(path.join(dir, "index.ts"), "export const value = 1;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "Initial commit"], dateEnv(commitDate));
  await writeFile(path.join(dir, "upstream.txt"), "shared");
  git(dir, ["add", "."]);
  git(
    dir,
    ["commit", "-q", "-m", "Upstream: refactor billing"],
    dateEnv(commitDate),
  );
}

async function commitFeature(dir: string, subject: string, date?: string) {
  git(dir, ["checkout", "-q", "-B", "feature"]);
  await writeFile(path.join(dir, "feature.ts"), subject);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", subject], dateEnv(date));
}

type Fixture = {
  base: string;
  paths: ActivityPaths;
  config: WorkspaceConfig;
  worktreePath: string;
  workspacePath: string;
};

async function createFixture(
  options: {
    commitDate?: string;
    featureCommit?: boolean;
    workspace?: boolean;
  } = {},
): Promise<Fixture> {
  const base = await mkdtemp(path.join(os.tmpdir(), "workforest-activity-"));
  tempDirs.push(base);
  const config: WorkspaceConfig = { directory: { base } };
  const { commitDate } = options;
  const repoRoot = path.join(base, "Repos", "widget");
  const worktreePath = path.join(repoRoot, "retry-logic");
  await initRepo(worktreePath, commitDate);
  if (options.featureCommit !== false) {
    await commitFeature(worktreePath, "Add retry helper", commitDate);
  }
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
  if (options.workspace) await createWorkspace(workspacePath, commitDate);

  return {
    base,
    paths: {
      cacheRoot: path.join(base, "cache", "_activity"),
      inputsRoot: path.join(base, "config", "activity"),
    },
    config,
    worktreePath,
    workspacePath,
  };
}

async function createWorkspace(workspacePath: string, commitDate?: string) {
  await initRepo(path.join(workspacePath, "api"), commitDate);
  await initRepo(path.join(workspacePath, "web"), commitDate);
  await initRepo(
    path.join(workspacePath, "_tasks", "api", "fix-tests"),
    commitDate,
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
  latest = "Observed work",
): DigestGenerator & { calls: EvidencePacket[] } {
  const calls: EvidencePacket[] = [];
  const generator = async (packet: EvidencePacket) => {
    calls.push(packet);
    await onCall?.(packet);
    return {
      output: {
        purpose: "Add retry logic",
        latest,
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

async function allTargets(fixture: Fixture) {
  return (await collectActivityTargets(fixture.config)).targets;
}

async function targetFor(fixture: Fixture, selector: string) {
  const target = (await allTargets(fixture)).find(
    (entry) => entry.identity.selector === selector,
  );
  if (!target) throw new Error(`missing target ${selector}`);
  return target;
}

function engine(
  fixture: Fixture,
  generator: DigestGenerator,
  clock: ReturnType<typeof fakeClock>,
): ActivityEngineOptions {
  return { paths: fixture.paths, generator, now: clock.now };
}

async function observe(target: ActivityTarget) {
  return observeTarget(target, emptyInputs(target.identity), Date.now());
}

describe("activity detection", () => {
  it("changes the fingerprint for repeated edits to an already dirty file", async () => {
    const fixture = await createFixture();
    const target = await targetFor(fixture, "widget/retry-logic");
    const clean = await observe(target);

    await writeFile(path.join(fixture.worktreePath, "index.ts"), "edit 1\n");
    const firstEdit = await observe(target);
    await writeFile(path.join(fixture.worktreePath, "index.ts"), "edit two\n");
    const secondEdit = await observe(target);
    const unchanged = await observe(target);

    expect(firstEdit.fingerprint).not.toBe(clean.fingerprint);
    expect(secondEdit.fingerprint).not.toBe(firstEdit.fingerprint);
    expect(unchanged.fingerprint).toBe(secondEdit.fingerprint);
  });

  it("ignores gitignored build and dependency output", async () => {
    const fixture = await createFixture();
    const target = await targetFor(fixture, "widget/retry-logic");
    const before = await observe(target);

    await mkdir(path.join(fixture.worktreePath, "dist"), { recursive: true });
    await writeFile(path.join(fixture.worktreePath, "dist", "out.js"), "x");
    await mkdir(path.join(fixture.worktreePath, "node_modules", "pkg"), {
      recursive: true,
    });
    await writeFile(
      path.join(fixture.worktreePath, "node_modules", "pkg", "index.js"),
      "x",
    );

    expect((await observe(target)).fingerprint).toBe(before.fingerprint);
  });

  it("aggregates every repository and task checkout of a workspace", async () => {
    const fixture = await createFixture({ workspace: true });
    const target = await targetFor(fixture, "_adhoc/billing");
    const before = await observe(target);

    expect(target.checkouts.map((checkout) => checkout.label)).toEqual([
      "api",
      "web",
      "api/fix-tests",
    ]);
    await writeFile(
      path.join(fixture.workspacePath, "_tasks", "api", "fix-tests", "new.ts"),
      "x",
    );
    expect((await observe(target)).fingerprint).not.toBe(before.fingerprint);
  });

  it("separates checkout commits from shared baseline history", async () => {
    const fixture = await createFixture({ workspace: true });
    const feature = await targetFor(fixture, "widget/retry-logic");
    const freshMain = await targetFor(fixture, "_adhoc/billing");

    const featureObserved = await observe(feature);
    const mainObserved = await observe(freshMain);
    const featurePacket = await collectEvidence(
      feature,
      featureObserved,
      emptyInputs(feature.identity),
    );
    const mainPacket = await collectEvidence(
      freshMain,
      mainObserved,
      emptyInputs(freshMain.identity),
    );

    expect(featureObserved.hasEvidence).toBe(true);
    expect(featurePacket.checkouts[0]).toMatchObject({
      baseline: "main",
      ownCommitsTotal: 1,
    });
    expect(featurePacket.checkouts[0]?.ownCommits).toHaveLength(1);
    expect(featurePacket.checkouts[0]?.ownCommits[0]).toContain(
      "Add retry helper",
    );
    expect(mainObserved.hasEvidence).toBe(false);
    expect(mainPacket.checkouts.every((c) => c.ownCommits.length === 0)).toBe(
      true,
    );
    expect(JSON.stringify(mainPacket)).not.toContain("Upstream:");
  });

  it("estimates first activity from checkout work, not shared history", async () => {
    const fixture = await createFixture({ featureCommit: false });
    const target = await targetFor(fixture, "widget/retry-logic");
    // Shared history is recent, but the checkout has no work of its own.
    const observed = await observe(target);
    expect(observed.estimatedActivityAtMs).toBeNull();
    expect(observed.hasEvidence).toBe(false);
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

    const createdAt = "2031-01-01T00:00:00.000Z";
    const recreated = {
      ...target.identity,
      createdAt,
      key: activityKey(target.identity.path, createdAt),
    };

    expect(recreated.key).not.toBe(target.identity.key);
    expect((await readRecord(fixture.paths, recreated)).digest).toBeNull();
    expect(
      (await readRecord(fixture.paths, target.identity)).digest,
    ).not.toBeNull();
  });
});

describe("activity sweeps", () => {
  it("summarizes once and skips unchanged checkouts on later sweeps", async () => {
    const fixture = await createFixture({ workspace: true });
    const clock = fakeClock();
    const generator = fakeGenerator();
    const targets = await allTargets(fixture);
    const options = engine(fixture, generator, clock);

    await runSweep(targets, options);
    expect(generator.calls).toHaveLength(0); // first sight: settling

    clock.advance(DEFAULT_ACTIVITY_POLICY.debounceMs);
    const second = await runSweep(targets, options);
    // Only the feature worktree has checkout-specific work.
    expect(second.generated).toBe(1);

    clock.advance(DEFAULT_ACTIVITY_POLICY.minIntervalMs * 3);
    const third = await runSweep(targets, options);
    expect(third.generated).toBe(0);
    expect(generator.calls).toHaveLength(1);
    expect(generator.calls[0]?.selector).toBe("widget/retry-logic");
  });

  it("does not summarize inactive checkouts and only rechecks them occasionally", async () => {
    const fixture = await createFixture({
      commitDate: "2020-01-01T00:00:00Z",
    });
    const clock = fakeClock();
    const generator = fakeGenerator();
    // The workspace was created just now, so only the worktree is inactive.
    const targets = [await targetFor(fixture, "widget/retry-logic")];
    const options = engine(fixture, generator, clock);

    await runSweep(targets, options);
    clock.advance(DEFAULT_ACTIVITY_POLICY.maxDelayMs);
    const later = await runSweep(targets, options);

    expect(generator.calls).toHaveLength(0);
    expect(later.checked).toBe(0);

    clock.advance(DEFAULT_ACTIVITY_POLICY.discoveryIntervalMs);
    await writeFile(path.join(fixture.worktreePath, "index.ts"), "new work\n");
    const discovery = await runSweep(targets, options);
    expect(discovery.checked).toBe(1);
    expect(discovery.changed).toBe(1);
  });

  it("serializes sweeps and reclaims only dead owners", async () => {
    const fixture = await createFixture({ workspace: true });
    const clock = fakeClock();
    const targets = await allTargets(fixture);
    const lockPath = path.join(fixture.paths.cacheRoot, "sweep.lock");
    await mkdir(fixture.paths.cacheRoot, { recursive: true });
    const owner = (pid: number) =>
      JSON.stringify({ token: `t-${pid}`, pid, host: os.hostname() });

    await writeFile(lockPath, owner(process.pid));
    const blocked = await runSweep(
      targets,
      engine(fixture, fakeGenerator(), clock),
    );
    expect(blocked.skippedReason).toBe("already-running");

    await writeFile(lockPath, owner(2 ** 22 + 7));
    const reclaimed = await runSweep(
      targets,
      engine(fixture, fakeGenerator(), clock),
    );
    expect(reclaimed.skippedReason).toBeUndefined();
    expect(reclaimed.checked).toBe(2);
  });

  it("runs a bounded service loop with a heartbeat and releases ownership", async () => {
    const fixture = await createFixture({ workspace: true });
    const clock = fakeClock();
    const result = await runService({
      paths: fixture.paths,
      intervalMs: 5,
      collectTargets: () => collectActivityTargets(fixture.config),
      engine: { generator: fakeGenerator(), now: clock.now },
      maxSweeps: 2,
    });
    const status = await readServiceStatus(fixture.paths);

    expect(result).toBe("stopped");
    expect(status.running).toBe(false);
    expect(status.state?.lastSweep?.targets).toBe(2);
    const again = await runService({
      paths: fixture.paths,
      intervalMs: 5,
      collectTargets: async () => ({ targets: [], complete: false }),
      engine: { generator: fakeGenerator(), now: clock.now },
      maxSweeps: 1,
    });
    expect(again).toBe("stopped");
  });
});

describe("activity generation", () => {
  it("reconciles changes made during inference without another sweep", async () => {
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
    const view = await readActivityView(target, fixture.paths, clock.now());

    expect(outcome.result).toBe("generated");
    expect(view.freshness).toBe("outdated");
    expect(view.latest).toBe("Observed work");
  });

  it("marks a digest current when nothing changed during inference", async () => {
    const fixture = await createFixture();
    const clock = fakeClock();
    const target = await targetFor(fixture, "widget/retry-logic");

    await generateForTarget(
      target,
      engine(fixture, fakeGenerator(), clock),
      "force",
    );

    expect(
      (await readActivityView(target, fixture.paths, clock.now())).freshness,
    ).toBe("current");
  });

  it("never launches the model for an already-aborted signal", async () => {
    const fixture = await createFixture();
    const clock = fakeClock();
    const target = await targetFor(fixture, "widget/retry-logic");
    const generator = fakeGenerator();
    const controller = new AbortController();
    controller.abort();

    const outcome = await generateForTarget(
      target,
      { ...engine(fixture, generator, clock), signal: controller.signal },
      "force",
    );

    expect(outcome.result).toBe("cancelled");
    expect(generator.calls).toHaveLength(0);
    expect(
      (await readRecord(fixture.paths, target.identity)).generation.state,
    ).not.toBe("running");
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
    const record = await readRecord(fixture.paths, target.identity);
    const inputs = await readInputs(fixture.paths, target.identity);

    expect(outcome.result).toBe("failed");
    expect(record.digest?.latest).toBe("Observed work");
    expect(record.generation.state).toBe("failed");
    expect(record.generation.lastError).toBe("provider exploded");
    expect(
      decideGeneration(
        { record, inputs },
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
        fakeGenerator(() => slowGate, "older run"),
        clock,
      ),
      "force",
    );
    for (let i = 0; i < 200; i += 1) {
      const record = await readRecord(fixture.paths, target.identity);
      if (record.generation.state === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // The slow claim now looks abandoned; a newer run takes over.
    clock.advance(DEFAULT_ACTIVITY_POLICY.staleRunMs);
    const fast = await generateForTarget(
      target,
      engine(fixture, fakeGenerator(undefined, "newer run"), clock),
      "force",
    );
    releaseSlow();
    await slow;

    const record = await readRecord(fixture.paths, target.identity);
    expect(fast.result).toBe("generated");
    expect(record.digest?.latest).toBe("newer run");
    expect(record.generation.state).toBe("idle");
  });

  it("does not let a stale capture overwrite a newer observation", async () => {
    const fixture = await createFixture();
    const target = await targetFor(fixture, "widget/retry-logic");
    const inputs = emptyInputs(target.identity);
    const old = await observeTarget(target, inputs, 1_000);
    await writeFile(path.join(fixture.worktreePath, "index.ts"), "newer\n");
    const newer = await observeTarget(target, inputs, 2_000);
    const { applyObservation } = await import("./policy.ts");

    const stored = await mutateRecord(fixture.paths, target.identity, (r) => ({
      ...r,
      observation: applyObservation(r, newer, 3_000),
    }));
    expect(applyObservation(stored, old, 4_000)).toBeNull();
  });
});

describe("explicit activity inputs", () => {
  async function currentDigest(fixture: Fixture, clock = fakeClock()) {
    const target = await targetFor(fixture, "widget/retry-logic");
    await generateForTarget(
      target,
      engine(fixture, fakeGenerator(), clock),
      "force",
    );
    return { target, clock };
  }

  it.each([
    ["setting a purpose", { kind: "purpose", purpose: "Ship retries" }],
    [
      "adding a handoff",
      { kind: "note", source: "bb:1", summary: "Done", next: "Wire CLI" },
    ],
  ] as const)("invalidates a current digest immediately when %s", async (_label, input) => {
    const fixture = await createFixture();
    const { target, clock } = await currentDigest(fixture);
    expect(
      (await readActivityView(target, fixture.paths, clock.now())).freshness,
    ).toBe("current");

    const view = await recordActivityInput(
      target,
      input,
      fixture.paths,
      clock.now(),
    );

    expect(view.freshness).toBe("outdated");
  });

  it("invalidates when a purpose is cleared", async () => {
    const fixture = await createFixture();
    const { target, clock } = await currentDigest(fixture);
    await recordActivityInput(
      target,
      { kind: "purpose", purpose: "Ship retries" },
      fixture.paths,
      clock.now(),
    );
    await generateForTarget(
      target,
      engine(fixture, fakeGenerator(), clock),
      "refresh",
    );
    expect(
      (await readActivityView(target, fixture.paths, clock.now())).freshness,
    ).toBe("current");

    const cleared = await recordActivityInput(
      target,
      { kind: "purpose", purpose: null },
      fixture.paths,
      clock.now(),
    );
    expect(cleared.freshness).toBe("outdated");
    expect(cleared.purposeSource).not.toBe("user");
  });

  it("makes detection due at once for inactive checkouts after new inputs", async () => {
    const fixture = await createFixture({
      commitDate: "2020-01-01T00:00:00Z",
    });
    const clock = fakeClock();
    const target = await targetFor(fixture, "widget/retry-logic");
    const targets = [target];
    await runSweep(targets, engine(fixture, fakeGenerator(), clock));
    clock.advance(MINUTE);
    expect(
      (await runSweep(targets, engine(fixture, fakeGenerator(), clock)))
        .checked,
    ).toBe(0);

    await recordActivityInput(
      target,
      { kind: "purpose", purpose: "Revive retries" },
      fixture.paths,
      clock.now(),
    );
    clock.advance(MINUTE);
    const sweep = await runSweep(
      targets,
      engine(fixture, fakeGenerator(), clock),
    );
    expect(sweep.checked).toBe(1);
  });

  it("survives a cache wipe", async () => {
    const fixture = await createFixture();
    const { target, clock } = await currentDigest(fixture);
    await recordActivityInput(
      target,
      { kind: "purpose", purpose: "Ship retries" },
      fixture.paths,
      clock.now(),
    );
    await recordActivityInput(
      target,
      { kind: "pin", pinned: true },
      fixture.paths,
    );
    await recordActivityInput(
      target,
      { kind: "note", source: "bb:1", summary: null, next: "Wire CLI" },
      fixture.paths,
      clock.now() + 1,
    );

    await rm(fixture.paths.cacheRoot, { recursive: true, force: true });
    const view = await readActivityView(target, fixture.paths, clock.now());

    expect(view).toMatchObject({
      purpose: "Ship retries",
      purposeSource: "user",
      pinned: true,
      likelyNext: "Wire CLI",
      likelyNextBasis: "handoff",
      latest: null,
      freshness: "missing",
    });
  });

  it("feeds explicit inputs to the evidence packet", async () => {
    const fixture = await createFixture();
    const { target, clock } = await currentDigest(fixture);
    await recordActivityInput(
      target,
      { kind: "purpose", purpose: "Ship retries" },
      fixture.paths,
      clock.now(),
    );
    await recordActivityInput(
      target,
      {
        kind: "note",
        source: "bb:1",
        summary: "Added tests",
        next: "Wire CLI",
      },
      fixture.paths,
      clock.now(),
    );
    const seen = fakeGenerator();
    clock.advance(MINUTE);
    await generateForTarget(target, engine(fixture, seen, clock), "refresh");

    expect(seen.calls[0]?.userPurpose).toBe("Ship retries");
    expect(seen.calls[0]?.handoffs[0]?.next).toBe("Wire CLI");
  });
});

describe("activity policy", () => {
  const nowMs = Date.parse("2030-01-01T12:00:00.000Z");
  const identity = {
    key: "k",
    selector: "repo/x",
    type: "worktree" as const,
    path: "/tmp/x",
    createdAt: "2030-01-01T00:00:00.000Z",
  };
  function state(
    overrides: Partial<NonNullable<ActivityRecord["observation"]>> = {},
    digest = false,
  ): ActivityState {
    const iso = new Date(nowMs).toISOString();
    return {
      inputs: emptyInputs(identity),
      record: {
        ...emptyRecord(identity),
        observation: {
          fingerprint: "new",
          captureStartedAt: iso,
          inputsRevision: 0,
          hasEvidence: true,
          checkedAt: iso,
          lastActivityAt: iso,
          pendingSince: iso,
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
              inputsRevision: 0,
              provider: "fake",
              model: null,
              promptVersion: 1,
            }
          : null,
      },
    };
  }

  it("debounces continuous changes but enforces a maximum delay", () => {
    expect(decideGeneration(state(), nowMs)).toMatchObject({
      kind: "skip",
      reason: "debouncing",
    });
    const continuous = state({
      pendingSince: new Date(
        nowMs - DEFAULT_ACTIVITY_POLICY.maxDelayMs,
      ).toISOString(),
    });
    expect(decideGeneration(continuous, nowMs)).toEqual({
      kind: "generate",
      fingerprint: "new",
    });
  });

  it("never summarizes a checkout without checkout-specific evidence", () => {
    const settled = state({
      hasEvidence: false,
      lastActivityAt: new Date(nowMs - 5 * MINUTE).toISOString(),
    });
    expect(decideGeneration(settled, nowMs)).toMatchObject({
      reason: "no-evidence",
    });
  });

  it("spaces generations by the minimum interval", () => {
    const recent = state(
      { lastActivityAt: new Date(nowMs - 5 * MINUTE).toISOString() },
      true,
    );
    const digest = recent.record.digest;
    if (!digest) throw new Error("expected digest");
    const spaced: ActivityState = {
      ...recent,
      record: {
        ...recent.record,
        digest: {
          ...digest,
          generatedAt: new Date(nowMs - MINUTE).toISOString(),
        },
      },
    };
    expect(decideGeneration(recent, nowMs).kind).toBe("generate");
    expect(decideGeneration(spaced, nowMs)).toMatchObject({
      reason: "min-interval",
    });
  });

  it("treats an abandoned running claim as retryable", () => {
    const settled = state({
      lastActivityAt: new Date(nowMs - 5 * MINUTE).toISOString(),
    });
    const running: ActivityState = {
      ...settled,
      record: {
        ...settled.record,
        generation: {
          ...settled.record.generation,
          state: "running",
          pid: 1,
          runId: "r",
          startedAt: new Date(nowMs - MINUTE).toISOString(),
        },
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
    const inactive = state({
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
    const pinned = {
      ...inactive,
      inputs: { ...inactive.inputs, pinned: true },
    };
    expect(isCheckDue(pinned, nowMs)).toBe(true);
  });
});

describe("digest evidence and output bounds", () => {
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

  it("enforces a hard evidence size limit", () => {
    const long = "y".repeat(200);
    const packet: EvidencePacket = {
      selector: "a/b",
      changeName: "b",
      type: "template-workspace",
      description: long,
      userPurpose: long,
      capturedAt: new Date(0).toISOString(),
      checkouts: Array.from({ length: 200 }, () => ({
        label: long,
        state: "present" as const,
        branch: long,
        upstream: long,
        ahead: 0,
        behind: 0,
        baseline: long,
        ownCommits: [long, long],
        ownCommitsTotal: 2,
        changedFiles: [long, long, long],
        changedFilesTotal: 3,
      })),
      tasks: Array.from({ length: 200 }, () => ({ repo: long, slug: long })),
      handoffs: Array.from({ length: 5 }, () => ({
        at: new Date(0).toISOString(),
        source: long,
        summary: long,
        next: long,
      })),
    };
    expect(JSON.stringify(boundPacket(packet)).length).toBeLessThanOrEqual(
      12_000,
    );
  });
});

describe("activity store", () => {
  it("merges concurrent writers without losing fields", async () => {
    const base = await mkdtemp(
      path.join(os.tmpdir(), "workforest-activity-store-"),
    );
    tempDirs.push(base);
    const paths = { cacheRoot: base, inputsRoot: path.join(base, "inputs") };
    const identity = {
      key: "0".repeat(32),
      selector: "repo/x",
      type: "worktree" as const,
      path: "/tmp/x",
      createdAt: "2030-01-01T00:00:00.000Z",
    };
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        mutateRecord(paths, identity, (current) => ({
          ...current,
          generation: {
            ...current.generation,
            attempts: current.generation.attempts + 1,
            lastError: String(index),
          },
        })),
      ),
    );
    expect((await readRecord(paths, identity)).generation.attempts).toBe(10);
  });
});
