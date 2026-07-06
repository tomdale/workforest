import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runGitMock } = vi.hoisted(() => ({ runGitMock: vi.fn() }));

vi.mock("./git.ts", () => ({ runGit: runGitMock }));

import {
  addWorktree,
  branchExists,
  deleteBranchIfPossible,
  detectDefaultBranch,
  getCurrentBranch,
  isGitDirty,
  pruneWorktrees,
  removeWorktree,
  requireCurrentBranch,
  withGitWorktreeLock,
} from "./worktree.ts";

type GitCall = { args: string[]; opts: { cwd?: string; timeout?: number } };

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const states: T[] = [];
  for await (const state of gen) states.push(state);
  return states;
}

/**
 * Route the mocked `runGit` by subcommand. `commonDir` (when set) makes the
 * lock resolve to a real temp directory so lock file I/O exercises real fs.
 */
function mockGit(config: {
  commonDir?: string;
  existingBranches?: string[];
  isAncestor?: boolean;
  symref?: string;
  hasRemoteRef?: boolean;
  currentBranch?: string;
  porcelain?: string;
}): { worktreeCalls: GitCall[] } {
  const worktreeCalls: GitCall[] = [];
  const existing = new Set(config.existingBranches ?? []);

  runGitMock.mockImplementation(
    async (args: string[], opts: GitCall["opts"] = {}) => {
      const [cmd] = args;
      if (cmd === "rev-parse" && args.includes("--git-common-dir")) {
        return { stdout: config.commonDir ?? "", stderr: "" };
      }
      if (cmd === "show-ref") {
        const ref = args[args.length - 1] ?? "";
        const branch = ref.replace("refs/heads/", "");
        if (existing.has(branch)) return { stdout: "", stderr: "" };
        throw new Error("not found");
      }
      if (cmd === "merge-base") {
        if (config.isAncestor) return { stdout: "", stderr: "" };
        throw new Error("not an ancestor");
      }
      if (cmd === "symbolic-ref") {
        if (config.symref === undefined) throw new Error("HEAD unreadable");
        return { stdout: config.symref, stderr: "" };
      }
      if (cmd === "for-each-ref") {
        return {
          stdout: config.hasRemoteRef ? "abc123 commit\trefs/..." : "",
          stderr: "",
        };
      }
      if (cmd === "branch" && args.includes("--show-current")) {
        return { stdout: config.currentBranch ?? "", stderr: "" };
      }
      if (cmd === "status") {
        return { stdout: config.porcelain ?? "", stderr: "" };
      }
      if (cmd === "worktree" || cmd === "branch") {
        worktreeCalls.push({ args, opts });
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  );

  return { worktreeCalls };
}

function worktreeAddArgs(calls: GitCall[]): string[] | undefined {
  return calls.find((c) => c.args[0] === "worktree" && c.args[1] === "add")
    ?.args;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("addWorktree — branch modes", () => {
  it("creates with -b from an explicit ref when the branch is new", async () => {
    const { worktreeCalls } = mockGit({});
    const target = path.join(await createTempDir("wf-add-"), "checkout");

    await collect(
      addWorktree({
        gitDir: "/mirror",
        targetDir: target,
        base: { ref: "origin/main" },
        branch: { kind: "create", name: "feature/x" },
        lock: false,
      }),
    );

    expect(worktreeAddArgs(worktreeCalls)).toEqual([
      "worktree",
      "add",
      "-b",
      "feature/x",
      target,
      "origin/main",
    ]);
  });

  it("refuses create when the branch already exists", async () => {
    mockGit({ existingBranches: ["feature/x"] });
    const target = path.join(await createTempDir("wf-add-"), "checkout");

    await expect(
      collect(
        addWorktree({
          gitDir: "/mirror",
          targetDir: target,
          base: { ref: "origin/main" },
          branch: { kind: "create", name: "feature/x" },
          lock: false,
        }),
      ),
    ).rejects.toThrow(/Branch already exists/);
  });

  it("resets with -B when the branch is fast-forwardable to the base", async () => {
    const { worktreeCalls } = mockGit({
      existingBranches: ["feature/x"],
      isAncestor: true,
    });
    const target = path.join(await createTempDir("wf-add-"), "checkout");

    await collect(
      addWorktree({
        gitDir: "/mirror",
        targetDir: target,
        base: { ref: "origin/main" },
        branch: { kind: "reset", name: "feature/x" },
        lock: false,
      }),
    );

    expect(worktreeAddArgs(worktreeCalls)?.[2]).toBe("-B");
  });

  it("refuses reset that would discard commits not on the base", async () => {
    mockGit({ existingBranches: ["feature/x"], isAncestor: false });
    const target = path.join(await createTempDir("wf-add-"), "checkout");

    await expect(
      collect(
        addWorktree({
          gitDir: "/mirror",
          targetDir: target,
          base: { ref: "origin/main" },
          branch: { kind: "reset", name: "feature/x" },
          lock: false,
        }),
      ),
    ).rejects.toThrow(/Refusing to reset branch "feature\/x"/);
  });

  it("resets a brand-new branch with -B without an ancestry check failure", async () => {
    const { worktreeCalls } = mockGit({});
    const target = path.join(await createTempDir("wf-add-"), "checkout");

    await collect(
      addWorktree({
        gitDir: "/mirror",
        targetDir: target,
        base: { ref: "origin/main" },
        branch: { kind: "reset", name: "feature/new" },
        lock: false,
      }),
    );

    expect(worktreeAddArgs(worktreeCalls)?.[2]).toBe("-B");
  });

  it("creates a detached worktree", async () => {
    const { worktreeCalls } = mockGit({});
    const target = path.join(await createTempDir("wf-add-"), "checkout");

    await collect(
      addWorktree({
        gitDir: "/mirror",
        targetDir: target,
        base: { ref: "origin/main" },
        branch: { kind: "detach" },
        lock: false,
      }),
    );

    expect(worktreeAddArgs(worktreeCalls)).toEqual([
      "worktree",
      "add",
      "--detach",
      target,
      "origin/main",
    ]);
  });
});

describe("addWorktree — base ref resolution", () => {
  it("resolves origin/<detected> and does not warn when the remote ref exists", async () => {
    const { worktreeCalls } = mockGit({
      symref: "refs/heads/canary",
      hasRemoteRef: true,
    });
    const target = path.join(await createTempDir("wf-add-"), "checkout");

    const states = await collect(
      addWorktree({
        gitDir: "/mirror",
        targetDir: target,
        base: { defaultBranchOf: "/mirror", fallback: "main" },
        branch: { kind: "create", name: "feature/x" },
        lock: false,
      }),
    );

    expect(worktreeAddArgs(worktreeCalls)?.at(-1)).toBe("origin/canary");
    expect(states.some((s) => "level" in s && s.level === "warn")).toBe(false);
  });

  it("falls back and warns when HEAD is unreadable", async () => {
    const { worktreeCalls } = mockGit({});
    const target = path.join(await createTempDir("wf-add-"), "checkout");

    const states = await collect(
      addWorktree({
        gitDir: "/mirror",
        targetDir: target,
        base: { defaultBranchOf: "/mirror", fallback: "main" },
        branch: { kind: "create", name: "feature/x" },
        lock: false,
      }),
    );

    expect(worktreeAddArgs(worktreeCalls)?.at(-1)).toBe("origin/main");
    expect(
      states.some(
        (s) =>
          "level" in s && s.level === "warn" && /Falling back/.test(s.message),
      ),
    ).toBe(true);
  });
});

describe("addWorktree — existing directory + options", () => {
  it("reuses an existing directory without invoking git", async () => {
    const { worktreeCalls } = mockGit({});
    const target = await createTempDir("wf-add-reuse-");

    const states = await collect(
      addWorktree({
        gitDir: "/mirror",
        targetDir: target,
        base: { ref: "origin/main" },
        branch: { kind: "reset", name: "feature/x" },
        onExistingDir: "reuse",
        lock: false,
      }),
    );

    expect(worktreeAddArgs(worktreeCalls)).toBeUndefined();
    expect(
      states.some((s) => "message" in s && /Reusing/.test(s.message)),
    ).toBe(true);
  });

  it("errors on an existing directory by default", async () => {
    mockGit({});
    const target = await createTempDir("wf-add-exists-");

    await expect(
      collect(
        addWorktree({
          gitDir: "/mirror",
          targetDir: target,
          base: { ref: "origin/main" },
          branch: { kind: "create", name: "feature/x" },
          lock: false,
        }),
      ),
    ).rejects.toThrow(/Target directory already exists/);
  });

  it("passes a timeout to the underlying git command", async () => {
    const { worktreeCalls } = mockGit({});
    const target = path.join(await createTempDir("wf-add-"), "checkout");

    await collect(
      addWorktree({
        gitDir: "/mirror",
        targetDir: target,
        base: { ref: "origin/main" },
        branch: { kind: "detach" },
        lock: false,
        timeoutMs: 4321,
      }),
    );

    expect(
      worktreeAddArgs(worktreeCalls) && worktreeCalls.at(-1)?.opts.timeout,
    ).toBe(4321);
  });
});

describe("removeWorktree", () => {
  it("removes with --force when requested", async () => {
    const { worktreeCalls } = mockGit({});
    // A real, non-broken worktree dir: has a .git file pointing at an existing dir.
    const wt = await createTempDir("wf-rm-");
    const gitdirTarget = await createTempDir("wf-rm-gitdir-");
    await writeFile(path.join(wt, ".git"), `gitdir: ${gitdirTarget}\n`);

    await collect(
      removeWorktree({
        gitDir: "/mirror",
        worktreePath: wt,
        force: true,
        lock: false,
      }),
    );

    expect(worktreeCalls.at(-1)?.args).toEqual([
      "worktree",
      "remove",
      "--force",
      wt,
    ]);
  });

  it("prunes metadata instead of removing when the gitlink is broken", async () => {
    const { worktreeCalls } = mockGit({});
    // No .git present => broken link.
    const wt = await createTempDir("wf-rm-broken-");

    const states = await collect(
      removeWorktree({
        gitDir: "/mirror",
        worktreePath: wt,
        lock: false,
      }),
    );

    const cmds = worktreeCalls.map((c) => c.args.slice(0, 2).join(" "));
    expect(cmds).toContain("worktree prune");
    expect(cmds).not.toContain("worktree remove");
    expect(
      states.some(
        (s) =>
          "message" in s && /Pruning stale worktree metadata/.test(s.message),
      ),
    ).toBe(true);
  });
});

describe("pruneWorktrees", () => {
  it("yields a log and runs git worktree prune", async () => {
    const { worktreeCalls } = mockGit({});
    const states = await collect(pruneWorktrees("/mirror", { lock: false }));
    expect(worktreeCalls.at(-1)?.args).toEqual(["worktree", "prune"]);
    expect(states.length).toBeGreaterThan(0);
  });
});

describe("small helpers", () => {
  it("branchExists reflects show-ref success", async () => {
    mockGit({ existingBranches: ["main"] });
    expect(await branchExists("/mirror", "main")).toBe(true);
    expect(await branchExists("/mirror", "nope")).toBe(false);
  });

  it("isGitDirty reflects porcelain output", async () => {
    mockGit({ porcelain: " M file.ts" });
    expect(await isGitDirty("/repo")).toBe(true);
    mockGit({ porcelain: "" });
    expect(await isGitDirty("/repo")).toBe(false);
  });

  it("getCurrentBranch returns undefined on detached HEAD; requireCurrentBranch throws", async () => {
    mockGit({ currentBranch: "" });
    expect(await getCurrentBranch("/repo")).toBeUndefined();
    await expect(requireCurrentBranch("/repo")).rejects.toThrow(
      /detached HEAD/,
    );

    mockGit({ currentBranch: "feature/x" });
    expect(await getCurrentBranch("/repo")).toBe("feature/x");
    expect(await requireCurrentBranch("/repo")).toBe("feature/x");
  });

  it("deleteBranchIfPossible swallows failures", async () => {
    mockGit({});
    runGitMock.mockRejectedValueOnce(new Error("branch not fully merged"));
    await expect(
      deleteBranchIfPossible("/repo", "feature/x", false),
    ).resolves.toBeUndefined();
  });

  it("detectDefaultBranch returns the detected branch when its remote ref exists", async () => {
    mockGit({ symref: "refs/heads/master", hasRemoteRef: true });
    expect(await detectDefaultBranch("/mirror", "main")).toBe("master");
  });

  it("detectDefaultBranch falls back when the detected branch has no remote ref", async () => {
    mockGit({ symref: "refs/heads/master", hasRemoteRef: false });
    expect(await detectDefaultBranch("/mirror", "main")).toBe("main");
  });
});

describe("withGitWorktreeLock", () => {
  it("serializes concurrent operations on the same repo", async () => {
    const commonDir = await createTempDir("wf-lock-");
    mockGit({ commonDir });

    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const p1 = withGitWorktreeLock("/repo", async () => {
      order.push("1-start");
      await firstHeld;
      order.push("1-end");
    });

    await delay(30);
    const p2 = withGitWorktreeLock("/repo", async () => {
      order.push("2-start");
    });

    await delay(30);
    expect(order).toEqual(["1-start"]); // second op is blocked
    releaseFirst?.();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["1-start", "1-end", "2-start"]);
  });

  it("removes its lock file on release", async () => {
    const commonDir = await createTempDir("wf-lock-");
    mockGit({ commonDir });
    const lockPath = path.join(commonDir, "workforest-worktree.lock");

    await withGitWorktreeLock("/repo", async () => {
      await expect(stat(lockPath)).resolves.toBeDefined();
    });

    await expect(stat(lockPath)).rejects.toThrow();
  });

  it("does not delete a lock file that was reclaimed by another holder", async () => {
    const commonDir = await createTempDir("wf-lock-");
    mockGit({ commonDir });
    const lockPath = path.join(commonDir, "workforest-worktree.lock");

    await withGitWorktreeLock("/repo", async () => {
      // Simulate a stale reclaim: another holder overwrote the lock with its token.
      await writeFile(lockPath, "9999:other-holder-token");
    });

    // Our release must leave the other holder's lock intact.
    await expect(stat(lockPath)).resolves.toBeDefined();
  });

  it("reclaims a stale lock left by a crashed holder", async () => {
    const commonDir = await createTempDir("wf-lock-");
    mockGit({ commonDir });
    const lockPath = path.join(commonDir, "workforest-worktree.lock");

    await writeFile(lockPath, "1:crashed");
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);

    let ran = false;
    await withGitWorktreeLock("/repo", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
