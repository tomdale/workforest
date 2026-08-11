import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preserveNodeModules, repoIdentity } from "./node-modules-cache.ts";
import {
  acquireNodeModules,
  GENERATED_SOURCE_ROOTS,
  type LiveNodeModulesInstall,
  listLiveNodeModulesInstalls,
  type ManagedCheckout,
  readSourceTreeActivityMs,
  SOURCE_ACTIVITY_GRACE_MS,
} from "./node-modules-lifecycle.ts";
import type { RepositorySource } from "./types.ts";

const ORIGINAL_CACHE_DIR = process.env["WORKFOREST_CACHE_DIR"];
const tempDirs: string[] = [];

const repo: RepositorySource = {
  name: "app",
  remote: "git@github.com:acme/app.git",
};

const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function createTempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createPnpmRepo(
  root: string,
  name: string,
  options: { withSourceFile?: boolean } = {},
): Promise<string> {
  const repoDir = path.join(root, name);
  await mkdir(path.join(repoDir, "node_modules", ".pnpm"), {
    recursive: true,
  });
  await writeFile(path.join(repoDir, "pnpm-lock.yaml"), "lockfile\n", "utf8");
  await writeFile(
    path.join(repoDir, "node_modules", ".pnpm-lockfile-hash"),
    "hash\n",
    "utf8",
  );
  await writeFile(
    path.join(repoDir, "node_modules", ".pnpm", "package"),
    `${name}-contents\n`,
    "utf8",
  );
  if (options.withSourceFile !== false) {
    await writeFile(path.join(repoDir, "src.ts"), `${name}\n`, "utf8");
  }
  return repoDir;
}

async function ageSourceFile(
  repoDir: string,
  ageMs: number,
  nowMs = Date.now(),
): Promise<void> {
  const when = new Date(nowMs - ageMs);
  await utimes(path.join(repoDir, "src.ts"), when, when);
  // Keep lockfile/package timestamps from looking newer than the source file
  // for tests that only care about src.ts activity.
  await utimes(path.join(repoDir, "pnpm-lock.yaml"), when, when);
}

function donorFrom(
  hostPath: string,
  overrides: Partial<LiveNodeModulesInstall> = {},
): LiveNodeModulesInstall {
  return {
    hostPath,
    nodeModulesPath: path.join(hostPath, "node_modules"),
    selector: path.basename(hostPath),
    sourceActivityMs: Date.now() - EIGHT_DAYS_MS,
    integrated: false,
    ...overrides,
  };
}

afterEach(async () => {
  if (ORIGINAL_CACHE_DIR === undefined) {
    delete process.env["WORKFOREST_CACHE_DIR"];
  } else {
    process.env["WORKFOREST_CACHE_DIR"] = ORIGINAL_CACHE_DIR;
  }

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("readSourceTreeActivityMs", () => {
  it("ignores generated roots including node_modules", async () => {
    const root = await createTempRoot("wf-src-mtime-");
    const repoDir = await createPnpmRepo(root, "repo");
    const now = Date.now();
    const old = new Date(now - EIGHT_DAYS_MS);
    const recent = new Date(now - 1_000);

    await utimes(path.join(repoDir, "src.ts"), old, old);
    await utimes(path.join(repoDir, "pnpm-lock.yaml"), old, old);

    // Fresh activity only under generated roots must not count.
    for (const generated of ["node_modules", "dist", ".next", "target"]) {
      expect(GENERATED_SOURCE_ROOTS.has(generated.split("/")[0] ?? "")).toBe(
        true,
      );
      const generatedPath = path.join(repoDir, generated);
      await mkdir(generatedPath, { recursive: true });
      const hotFile = path.join(generatedPath, "hot.bin");
      await writeFile(hotFile, "hot\n", "utf8");
      await utimes(hotFile, recent, recent);
    }

    const activity = await readSourceTreeActivityMs(repoDir);
    expect(activity).toBeLessThanOrEqual(old.getTime() + 5);
    expect(activity).toBeGreaterThan(0);
  });

  it("walks nested source files", async () => {
    const root = await createTempRoot("wf-src-mtime-nested-");
    const repoDir = path.join(root, "repo");
    await mkdir(path.join(repoDir, "packages", "a"), { recursive: true });
    const nested = path.join(repoDir, "packages", "a", "index.ts");
    await writeFile(nested, "x\n", "utf8");
    const stamp = Date.now() - ONE_DAY_MS;
    await utimes(nested, new Date(stamp), new Date(stamp));

    const activity = await readSourceTreeActivityMs(repoDir);
    expect(Math.abs(activity - stamp)).toBeLessThan(10);
  });
});

describe("listLiveNodeModulesInstalls", () => {
  it("filters dirty, recent, excluded, and ineligible donors", async () => {
    const root = await createTempRoot("wf-live-list-");
    const nowMs = Date.now();

    const cleanOld = await createPnpmRepo(root, "clean-old");
    await ageSourceFile(cleanOld, EIGHT_DAYS_MS, nowMs);

    const dirtyOld = await createPnpmRepo(root, "dirty-old");
    await ageSourceFile(dirtyOld, EIGHT_DAYS_MS, nowMs);

    const cleanRecent = await createPnpmRepo(root, "clean-recent");
    await ageSourceFile(cleanRecent, ONE_DAY_MS, nowMs);

    const ineligible = await createPnpmRepo(root, "ineligible");
    await ageSourceFile(ineligible, EIGHT_DAYS_MS, nowMs);
    await rm(path.join(ineligible, "node_modules", ".pnpm-lockfile-hash"));

    const excluded = await createPnpmRepo(root, "excluded");
    await ageSourceFile(excluded, EIGHT_DAYS_MS, nowMs);

    const otherRemote = await createPnpmRepo(root, "other-remote");
    await ageSourceFile(otherRemote, EIGHT_DAYS_MS, nowMs);

    const checkouts: ManagedCheckout[] = [
      {
        hostPath: cleanOld,
        selector: "app/clean-old",
        remote: repo.remote,
      },
      {
        hostPath: dirtyOld,
        selector: "app/dirty-old",
        remote: repo.remote,
      },
      {
        hostPath: cleanRecent,
        selector: "app/clean-recent",
        remote: repo.remote,
      },
      {
        hostPath: ineligible,
        selector: "app/ineligible",
        remote: repo.remote,
      },
      {
        hostPath: excluded,
        selector: "app/excluded",
        remote: repo.remote,
      },
      {
        hostPath: otherRemote,
        selector: "other/other-remote",
        remote: "git@github.com:acme/other.git",
      },
    ];

    const dirtyPaths = new Set([path.resolve(dirtyOld)]);
    const integratedPaths = new Set([path.resolve(cleanOld)]);

    const listed = await listLiveNodeModulesInstalls({
      identity: repoIdentity(repo),
      excludePaths: [excluded],
      nowMs,
      listCheckouts: async () => checkouts,
      isDirty: async (hostPath) => dirtyPaths.has(path.resolve(hostPath)),
      isIntegrated: async (hostPath) =>
        integratedPaths.has(path.resolve(hostPath)),
    });

    expect(listed.map((entry) => entry.selector)).toEqual(["app/clean-old"]);
    expect(listed[0]?.integrated).toBe(true);
  });

  it("orders integrated donors before unproven, oldest activity first", async () => {
    const root = await createTempRoot("wf-live-order-");
    const nowMs = Date.now();

    const integratedOlder = await createPnpmRepo(root, "int-older");
    await ageSourceFile(integratedOlder, 10 * ONE_DAY_MS, nowMs);
    const integratedNewer = await createPnpmRepo(root, "int-newer");
    await ageSourceFile(integratedNewer, 8 * ONE_DAY_MS, nowMs);
    const unprovenOlder = await createPnpmRepo(root, "unp-older");
    await ageSourceFile(unprovenOlder, 12 * ONE_DAY_MS, nowMs);
    const unprovenNewer = await createPnpmRepo(root, "unp-newer");
    await ageSourceFile(unprovenNewer, 9 * ONE_DAY_MS, nowMs);

    const checkouts: ManagedCheckout[] = [
      unprovenNewer,
      integratedNewer,
      unprovenOlder,
      integratedOlder,
    ].map((hostPath) => ({
      hostPath,
      selector: path.basename(hostPath),
      remote: repo.remote,
    }));

    const integrated = new Set(
      [integratedOlder, integratedNewer].map((p) => path.resolve(p)),
    );

    const listed = await listLiveNodeModulesInstalls({
      identity: repoIdentity(repo),
      nowMs,
      listCheckouts: async () => checkouts,
      isDirty: async () => false,
      isIntegrated: async (hostPath) => integrated.has(path.resolve(hostPath)),
    });

    expect(listed.map((entry) => entry.selector)).toEqual([
      "int-older",
      "int-newer",
      "unp-older",
      "unp-newer",
    ]);
  });
});

describe("acquireNodeModules", () => {
  it("short-circuits when node_modules is already present", async () => {
    const root = await createTempRoot("wf-acquire-present-");
    process.env["WORKFOREST_CACHE_DIR"] = path.join(root, "cache");
    const target = await createPnpmRepo(root, "target");

    const listLiveInstalls = vi.fn(async () => [donorFrom(target)]);
    const restoreFromPool = vi.fn(async () => ({ status: "missing" as const }));

    await expect(
      acquireNodeModules({
        repo,
        repoDir: target,
        listLiveInstalls,
        restoreFromPool,
      }),
    ).resolves.toEqual({ status: "present" });

    expect(listLiveInstalls).not.toHaveBeenCalled();
    expect(restoreFromPool).not.toHaveBeenCalled();
  });

  it("returns disabled / ineligible like restore", async () => {
    const root = await createTempRoot("wf-acquire-disabled-");
    process.env["WORKFOREST_CACHE_DIR"] = path.join(root, "cache");
    const target = path.join(root, "target");
    await mkdir(target);
    await writeFile(path.join(target, "pnpm-lock.yaml"), "lock\n", "utf8");

    await expect(
      acquireNodeModules({
        repo,
        repoDir: target,
        config: { enabled: false },
      }),
    ).resolves.toEqual({ status: "disabled" });

    await expect(
      acquireNodeModules({
        repo,
        repoDir: target,
        disabledInitializers: ["pnpm-install"],
      }),
    ).resolves.toEqual({ status: "disabled" });

    const noLock = path.join(root, "no-lock");
    await mkdir(noLock);
    await expect(
      acquireNodeModules({ repo, repoDir: noLock }),
    ).resolves.toEqual({ status: "ineligible" });
  });

  it("borrows an evictable live donor via rename", async () => {
    const root = await createTempRoot("wf-acquire-borrow-");
    process.env["WORKFOREST_CACHE_DIR"] = path.join(root, "cache");
    const donorDir = await createPnpmRepo(root, "donor");
    await ageSourceFile(donorDir, EIGHT_DAYS_MS);
    const target = path.join(root, "target");
    await mkdir(target);
    await writeFile(path.join(target, "pnpm-lock.yaml"), "lockfile\n", "utf8");

    const result = await acquireNodeModules({
      repo,
      repoDir: target,
      cwd: root,
      listLiveInstalls: async () => [
        donorFrom(donorDir, { selector: "app/donor", integrated: true }),
      ],
      restoreFromPool: async () => ({ status: "missing" }),
    });

    expect(result).toMatchObject({
      status: "borrowed",
      donor: { selector: "app/donor" },
    });
    await expect(
      readFile(path.join(target, "node_modules", ".pnpm", "package"), "utf8"),
    ).resolves.toBe("donor-contents\n");
    await expect(
      readFile(path.join(donorDir, "node_modules", ".pnpm", "package"), "utf8"),
    ).rejects.toThrow();
  });

  it("prefers borrow over pool when both exist", async () => {
    const root = await createTempRoot("wf-acquire-prefer-borrow-");
    process.env["WORKFOREST_CACHE_DIR"] = path.join(root, "cache");

    const pooled = await createPnpmRepo(root, "pooled");
    await preserveNodeModules({ repo, repoDir: pooled });

    const donorDir = await createPnpmRepo(root, "donor");
    const target = path.join(root, "target");
    await mkdir(target);
    await writeFile(path.join(target, "pnpm-lock.yaml"), "lockfile\n", "utf8");

    const restoreFromPool = vi.fn(async () => {
      throw new Error("pool restore must not run when a donor is borrowed");
    });

    const result = await acquireNodeModules({
      repo,
      repoDir: target,
      cwd: root,
      listLiveInstalls: async () => [
        donorFrom(donorDir, { selector: "app/donor" }),
      ],
      restoreFromPool,
    });

    expect(result.status).toBe("borrowed");
    expect(restoreFromPool).not.toHaveBeenCalled();
    await expect(
      readFile(path.join(target, "node_modules", ".pnpm", "package"), "utf8"),
    ).resolves.toBe("donor-contents\n");
  });

  it("falls through to pool when no live donor exists", async () => {
    const root = await createTempRoot("wf-acquire-pool-");
    process.env["WORKFOREST_CACHE_DIR"] = path.join(root, "cache");
    const pooled = await createPnpmRepo(root, "pooled");
    await preserveNodeModules({ repo, repoDir: pooled });

    const target = path.join(root, "target");
    await mkdir(target);
    await writeFile(path.join(target, "pnpm-lock.yaml"), "lockfile\n", "utf8");

    const result = await acquireNodeModules({
      repo,
      repoDir: target,
      cwd: root,
      listLiveInstalls: async () => [],
    });

    expect(result).toMatchObject({ status: "restored" });
    await expect(
      readFile(path.join(target, "node_modules", ".pnpm", "package"), "utf8"),
    ).resolves.toBe("pooled-contents\n");
  });

  it("skips a donor on EXDEV/rename failure and tries the next, then pool", async () => {
    const root = await createTempRoot("wf-acquire-exdev-");
    process.env["WORKFOREST_CACHE_DIR"] = path.join(root, "cache");

    const badDonor = await createPnpmRepo(root, "bad-donor");
    const goodDonor = await createPnpmRepo(root, "good-donor");
    const target = path.join(root, "target");
    await mkdir(target);
    await writeFile(path.join(target, "pnpm-lock.yaml"), "lockfile\n", "utf8");

    const exdev = Object.assign(new Error("cross-device link"), {
      code: "EXDEV",
    });
    let attempts = 0;
    const rename = vi.fn(async (from: string, to: string) => {
      attempts += 1;
      if (attempts === 1) {
        throw exdev;
      }
      const { rename: realRename } = await import("node:fs/promises");
      await realRename(from, to);
    });

    const result = await acquireNodeModules({
      repo,
      repoDir: target,
      cwd: root,
      listLiveInstalls: async () => [
        donorFrom(badDonor, { selector: "bad" }),
        donorFrom(goodDonor, { selector: "good" }),
      ],
      restoreFromPool: async () => ({ status: "missing" }),
      rename,
    });

    expect(result).toMatchObject({
      status: "borrowed",
      donor: { selector: "good" },
    });
    expect(rename).toHaveBeenCalledTimes(2);
    await expect(
      readFile(path.join(target, "node_modules", ".pnpm", "package"), "utf8"),
    ).resolves.toBe("good-donor-contents\n");
  });

  it("falls through to pool when every donor rename fails", async () => {
    const root = await createTempRoot("wf-acquire-all-exdev-");
    process.env["WORKFOREST_CACHE_DIR"] = path.join(root, "cache");
    const pooled = await createPnpmRepo(root, "pooled");
    await preserveNodeModules({ repo, repoDir: pooled });

    const donorDir = await createPnpmRepo(root, "donor");
    const target = path.join(root, "target");
    await mkdir(target);
    await writeFile(path.join(target, "pnpm-lock.yaml"), "lockfile\n", "utf8");

    const exdev = Object.assign(new Error("cross-device link"), {
      code: "EXDEV",
    });

    const result = await acquireNodeModules({
      repo,
      repoDir: target,
      cwd: root,
      listLiveInstalls: async () => [donorFrom(donorDir)],
      rename: async () => {
        throw exdev;
      },
    });

    expect(result).toMatchObject({ status: "restored" });
    await expect(
      readFile(path.join(target, "node_modules", ".pnpm", "package"), "utf8"),
    ).resolves.toBe("pooled-contents\n");
    // Failed borrow must leave the donor install in place.
    await expect(
      readFile(path.join(donorDir, "node_modules", ".pnpm", "package"), "utf8"),
    ).resolves.toBe("donor-contents\n");
  });

  it("returns missing when neither donors nor pool can supply an install", async () => {
    const root = await createTempRoot("wf-acquire-missing-");
    process.env["WORKFOREST_CACHE_DIR"] = path.join(root, "cache");
    const target = path.join(root, "target");
    await mkdir(target);
    await writeFile(path.join(target, "pnpm-lock.yaml"), "lockfile\n", "utf8");

    await expect(
      acquireNodeModules({
        repo,
        repoDir: target,
        cwd: root,
        listLiveInstalls: async () => [],
      }),
    ).resolves.toEqual({ status: "missing" });
  });

  it("does not borrow from cwd even if listed", async () => {
    // cwd protection is applied in acquire via excludePaths; listLiveInstalls
    // is injected here so we assert acquire itself adds cwd to exclusions
    // before listing when using the real lister — with an injected lister we
    // simulate the filtered result (empty) and ensure pool is used.
    const root = await createTempRoot("wf-acquire-cwd-");
    process.env["WORKFOREST_CACHE_DIR"] = path.join(root, "cache");
    const pooled = await createPnpmRepo(root, "pooled");
    await preserveNodeModules({ repo, repoDir: pooled });

    const target = path.join(root, "target");
    await mkdir(target);
    await writeFile(path.join(target, "pnpm-lock.yaml"), "lockfile\n", "utf8");

    const listLiveInstalls = vi.fn(
      async (options: { excludePaths?: readonly string[] }) => {
        // Acquire must pass cwd + target in excludePaths.
        const excluded = (options.excludePaths ?? []).map((p) =>
          path.resolve(p),
        );
        expect(excluded).toContain(path.resolve(root));
        expect(excluded).toContain(path.resolve(target));
        return [];
      },
    );

    const result = await acquireNodeModules({
      repo,
      repoDir: target,
      cwd: root,
      listLiveInstalls,
    });

    expect(result.status).toBe("restored");
    expect(listLiveInstalls).toHaveBeenCalledOnce();
  });
});

describe("SOURCE_ACTIVITY_GRACE_MS", () => {
  it("is seven days", () => {
    expect(SOURCE_ACTIVITY_GRACE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
