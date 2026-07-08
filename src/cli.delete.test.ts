import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DeleteProgressState, runDeleteCommand } from "./cli/delete.ts";
import { OperationalError } from "./cli/errors.ts";
import type { ParsedInvocation } from "./cli/types.ts";
import { saveWorkspaceConfig } from "./config.ts";
import type { CleanupExecutionOptions } from "./workspace/cleanup.ts";
import type {
  DeleteRepositorySafety,
  DeleteTaskSafety,
} from "./workspace/delete-safety.ts";
import {
  writeWorkspaceMetadata,
  writeWorktreeMetadata,
} from "./workspace/metadata.ts";

const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const ORIGINAL_TIMING_FILE = process.env["WORKFOREST_TIMING_FILE"];
const ORIGINAL_CWD = process.cwd();
const tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(ORIGINAL_CWD);
  restoreEnv("WORKFOREST_CONFIG_DIR", ORIGINAL_CONFIG_DIR);
  restoreEnv("WORKFOREST_TIMING_FILE", ORIGINAL_TIMING_FILE);
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("wf delete", () => {
  it("refuses dirty and unintegrated worktrees", async () => {
    const fixture = await createCleanupFixture();
    const cleanupWorktree = vi.fn();
    const buildDeleteRepositorySafety = vi.fn(async () => [
      repositorySafety({
        path: fixture.repoChange,
        state: "dirty",
        integrated: false,
      }),
    ]);
    const buildDeleteTaskSafety = vi.fn(async () => []);

    const error = await runDeleteCommand(
      invocation(["workforest/cli-redesign"]),
      {
        interactive: false,
        writeShellCdPath: async () => {},
        buildDeleteRepositorySafety,
        buildDeleteTaskSafety,
        cleanupWorktree,
        resolveRepositorySpecifiers: async () => [],
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OperationalError);
    expect(error).toMatchObject({
      message: expect.stringContaining(
        "Cannot delete workforest/cli-redesign.",
      ),
    });
    expect(error).toMatchObject({
      message: expect.stringContaining(
        `Run: git -C ${fixture.repoChange} status`,
      ),
    });
    expect(error).toMatchObject({
      message: expect.stringContaining(
        "Merge the branch first, or pass --force if it was integrated another way.",
      ),
    });
    expect(cleanupWorktree).not.toHaveBeenCalled();
  });

  it("previews dirty and unintegrated worktrees without deleting", async () => {
    const fixture = await createCleanupFixture();
    const cleanupWorktree = vi.fn();
    const buildDeleteRepositorySafety = vi.fn(async () => [
      repositorySafety({
        path: fixture.repoChange,
        state: "dirty",
        integrated: false,
      }),
    ]);
    const buildDeleteTaskSafety = vi.fn(async () => []);

    const result = await runDeleteCommand(
      invocation(["workforest/cli-redesign"], { dryRun: true }),
      {
        interactive: false,
        writeShellCdPath: async () => {},
        buildDeleteRepositorySafety,
        buildDeleteTaskSafety,
        cleanupWorktree,
        resolveRepositorySpecifiers: async () => [],
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.render.kind).toBe("text");
    if (result.render.kind !== "text") {
      throw new Error("Expected text report");
    }
    expect(result.render.value).toContain("Delete preview");
    expect(result.render.value).toContain("Blocked; real delete would stop");
    expect(result.render.value).toContain("worktree has uncommitted changes");
    expect(result.render.value).toContain("Cached mirrors");
    expect(result.render.value).toContain("node_modules");
    expect(result.render.value).toContain("No files, worktrees, metadata");
    expect(cleanupWorktree).not.toHaveBeenCalled();
  });

  it("emits the dry-run delete plan as JSON", async () => {
    const fixture = await createCleanupFixture();
    const cleanupWorktree = vi.fn();
    const buildDeleteRepositorySafety = vi.fn(async () => [
      repositorySafety({
        path: fixture.repoChange,
        state: "dirty",
        integrated: false,
      }),
    ]);
    const buildDeleteTaskSafety = vi.fn(async () => []);

    const result = await runDeleteCommand(
      invocation(["workforest/cli-redesign"], {
        dryRun: true,
        json: true,
      }),
      {
        interactive: false,
        writeShellCdPath: async () => {},
        buildDeleteRepositorySafety,
        buildDeleteTaskSafety,
        cleanupWorktree,
        resolveRepositorySpecifiers: async () => [],
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.render.kind).toBe("json");
    if (result.render.kind !== "json") {
      throw new Error("Expected JSON render");
    }
    expect(result.render.value).toEqual(
      expect.objectContaining({
        dryRun: true,
        selector: "workforest/cli-redesign",
        blocked: true,
        blockers: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("uncommitted changes"),
          }),
        ]),
        wouldRemove: expect.objectContaining({
          directories: [fixture.repoChange],
          metadata: [
            path.join(
              path.dirname(fixture.repoChange),
              ".workforest",
              "changes",
              "cli-redesign.json",
            ),
          ],
          branches: [],
        }),
        preservation: expect.objectContaining({
          cachedMirrors: expect.objectContaining({ action: "preserve" }),
          nodeModules: expect.objectContaining({
            action: "preserve-before-delete",
          }),
        }),
      }),
    );
    expect(cleanupWorktree).not.toHaveBeenCalled();
  });

  it("uses --force to delete a worktree when Workforest cannot prove integration", async () => {
    const fixture = await createCleanupFixture();
    const invocationCwd = path.join(fixture.repoChange, "src");
    await mkdir(invocationCwd);
    const cdTargets: string[] = [];
    const cleanupWorktree = vi.fn(async () => ({
      dryRun: false,
      removedRepos: ["workforest"],
      deletedBranches: [],
    }));
    const buildDeleteRepositorySafety = vi.fn();
    const buildDeleteTaskSafety = vi.fn();

    await runDeleteCommand(
      invocation(["workforest/cli-redesign"], { force: true }),
      {
        interactive: false,
        writeShellCdPath: async (targetDir: string) => {
          cdTargets.push(targetDir);
        },
        buildDeleteRepositorySafety,
        buildDeleteTaskSafety,
        cleanupWorktree,
        resolveRepositorySpecifiers: async () => [],
        cwd: invocationCwd,
      },
    );

    expect(buildDeleteRepositorySafety).not.toHaveBeenCalled();
    expect(buildDeleteTaskSafety).not.toHaveBeenCalled();
    expect(cleanupWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        repoName: "workforest",
        targetPath: fixture.repoChange,
      }),
    );
    expect(cdTargets).toEqual([path.dirname(fixture.repoChange)]);
  });

  it("refuses unmerged nested tasks", async () => {
    const fixture = await createCleanupFixture();
    const cleanupWorkspace = vi.fn();
    const buildDeleteRepositorySafety = vi.fn(async () => [
      repositorySafety({
        name: "api",
        path: path.join(fixture.workspace, "api"),
        integrated: true,
      }),
    ]);
    const buildDeleteTaskSafety = vi.fn(async () => [
      taskSafety({ merged: false }),
    ]);

    await expect(
      runDeleteCommand(invocation(["_adhoc/experiment"]), {
        interactive: false,
        writeShellCdPath: async () => {},
        buildDeleteRepositorySafety,
        buildDeleteTaskSafety,
        cleanupWorkspace,
      }),
    ).rejects.toThrow("wf task delete fix-tests --repo api --force");
    expect(cleanupWorkspace).not.toHaveBeenCalled();
  });

  it("deletes a verified-clean workspace without --force", async () => {
    const fixture = await createCleanupFixture();
    const cleanupWorkspace = vi.fn(async () => ({
      dryRun: false,
      removedRepos: ["api", "front"],
      deletedBranches: [],
    }));
    const buildDeleteRepositorySafety = vi.fn(async () => [
      repositorySafety({
        name: "api",
        path: path.join(fixture.workspace, "api"),
        integrated: true,
      }),
    ]);
    const buildDeleteTaskSafety = vi.fn(async () => []);

    await runDeleteCommand(invocation(["_adhoc/experiment"]), {
      interactive: false,
      writeShellCdPath: async () => {},
      buildDeleteRepositorySafety,
      buildDeleteTaskSafety,
      cleanupWorkspace,
    });

    expect(cleanupWorkspace).toHaveBeenCalledWith(
      fixture.workspace,
      expect.objectContaining({ keepMirrors: true }),
    );
  });

  it("emits progress for selector resolution, safety checks, and cleanup", async () => {
    const fixture = await createCleanupFixture();
    const progress: DeleteProgressState[] = [];
    const cleanupWorkspace = vi.fn(async () => ({
      dryRun: false,
      removedRepos: ["api", "front"],
      deletedBranches: [],
    }));

    await runDeleteCommand(invocation(["_adhoc/experiment"]), {
      interactive: false,
      writeShellCdPath: async () => {},
      buildDeleteRepositorySafety: async () => [
        repositorySafety({
          name: "api",
          path: path.join(fixture.workspace, "api"),
          integrated: true,
        }),
      ],
      buildDeleteTaskSafety: async () => [],
      cleanupWorkspace,
      onDeleteProgress: (state) => {
        progress.push(state);
      },
    });

    expect(progress.map((state) => `${state.phase}:${state.status}`)).toEqual([
      "selector-resolution:started",
      "selector-resolution:completed",
      "repository-safety:started",
      "repository-safety:completed",
      "task-checks:started",
      "task-checks:completed",
      "cleanup-dispatch:started",
      "cleanup-dispatch:completed",
    ]);
    expect(progress.map((state) => state.message)).toEqual(
      expect.arrayContaining([
        "Resolving delete target",
        "Checking repository safety",
        "Checking nested tasks",
        "Deleting workspace _adhoc/experiment",
      ]),
    );
  });

  it("keeps emitting progress while a delete operation waits", async () => {
    vi.useFakeTimers();
    await createCleanupFixture();
    const progress: DeleteProgressState[] = [];
    let finishCleanup: (() => void) | undefined;
    const cleanupWorkspace = vi.fn(
      () =>
        new Promise<{
          dryRun: false;
          removedRepos: string[];
          deletedBranches: string[];
        }>((resolve) => {
          finishCleanup = () =>
            resolve({
              dryRun: false,
              removedRepos: ["api", "front"],
              deletedBranches: [],
            });
        }),
    );

    try {
      const pending = runDeleteCommand(
        invocation(["_adhoc/experiment"], { force: true }),
        {
          interactive: false,
          writeShellCdPath: async () => {},
          cleanupWorkspace,
          onDeleteProgress: (state) => {
            progress.push(state);
          },
        },
      );

      await vi.waitFor(() => {
        expect(cleanupWorkspace).toHaveBeenCalled();
      });
      await vi.advanceTimersByTimeAsync(21_000);
      finishCleanup?.();
      await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(
      progress.filter(
        (state) =>
          state.phase === "cleanup-dispatch" && state.status === "waiting",
      ),
    ).toEqual([
      expect.objectContaining({ elapsedMs: 10_000 }),
      expect.objectContaining({ elapsedMs: 20_000 }),
    ]);
  });

  it("errors when run with no selector outside a worktree or workspace", async () => {
    await createCleanupFixture();

    await expect(
      runDeleteCommand(invocation([]), {
        interactive: false,
        writeShellCdPath: async () => {},
      }),
    ).rejects.toThrow("Not in a Workforest worktree or workspace.");
  });

  it("deletes a workspace without integration proof when forced", async () => {
    const fixture = await createCleanupFixture();
    const cleanupWorkspace = vi.fn(async () => ({
      dryRun: false,
      removedRepos: ["api", "front"],
      deletedBranches: [],
    }));
    const buildDeleteRepositorySafety = vi.fn();
    const buildDeleteTaskSafety = vi.fn();

    await runDeleteCommand(invocation(["_adhoc/experiment"], { force: true }), {
      interactive: false,
      writeShellCdPath: async () => {},
      buildDeleteRepositorySafety,
      buildDeleteTaskSafety,
      cleanupWorkspace,
    });

    expect(buildDeleteRepositorySafety).not.toHaveBeenCalled();
    expect(buildDeleteTaskSafety).not.toHaveBeenCalled();
    expect(cleanupWorkspace).toHaveBeenCalledWith(
      fixture.workspace,
      expect.objectContaining({ keepMirrors: true }),
    );
  });

  it("writes a parent cd target when deleting from an equivalent symlinked cwd", async () => {
    const fixture = await createCleanupFixture();
    const aliasRoot = await createTempDir("workforest-finish-alias-");
    const aliasBase = path.join(aliasRoot, "base");
    await symlink(fixture.baseDir, aliasBase);
    const cdTargets: string[] = [];
    const cleanupWorkspace = vi.fn(async () => ({
      dryRun: false,
      removedRepos: ["api", "front"],
      deletedBranches: [],
    }));

    await runDeleteCommand(invocation(["_adhoc/experiment"], { force: true }), {
      interactive: false,
      writeShellCdPath: async (targetDir: string) => {
        cdTargets.push(targetDir);
      },
      cleanupWorkspace,
      cwd: path.join(aliasBase, "Workspaces", "_adhoc", "experiment"),
    });

    expect(cdTargets).toEqual([path.dirname(fixture.workspace)]);
  });

  it("writes internal timing when WORKFOREST_TIMING_FILE is set", async () => {
    const fixture = await createCleanupFixture();
    const timingDir = await createTempDir("workforest-delete-timing-");
    const timingFile = path.join(timingDir, "delete.json");
    process.env["WORKFOREST_TIMING_FILE"] = timingFile;
    const cleanupWorkspace = vi.fn(
      async (_workspaceDir: string, options: CleanupExecutionOptions = {}) => {
        await options.onState?.({ phase: "init", message: "Validating" });
        await options.onState?.({
          phase: "complete",
          removedRepos: ["api", "front"],
        });
        return {
          dryRun: false,
          removedRepos: ["api", "front"],
          deletedBranches: [],
        };
      },
    );

    await runDeleteCommand(invocation(["_adhoc/experiment"]), {
      interactive: false,
      writeShellCdPath: async () => {},
      buildDeleteRepositorySafety: async () => [
        repositorySafety({
          name: "api",
          path: path.join(fixture.workspace, "api"),
          integrated: true,
        }),
      ],
      buildDeleteTaskSafety: async () => [],
      cleanupWorkspace,
    });

    const timing = JSON.parse(await readFile(timingFile, "utf8")) as {
      kind: string;
      phases: Array<{ name: string; status: string }>;
      cleanupStates: Array<{ state: { phase: string } }>;
    };

    expect(timing.kind).toBe("workforest.delete.timing");
    expect(timing.phases.map((phase) => phase.name)).toEqual([
      "selector-resolution",
      "repository-safety",
      "task-checks",
      "cleanup-dispatch",
    ]);
    expect(timing.phases.every((phase) => phase.status === "ok")).toBe(true);
    expect(timing.cleanupStates.map((entry) => entry.state.phase)).toEqual([
      "init",
      "complete",
    ]);
  });
});

async function createCleanupFixture(): Promise<{
  baseDir: string;
  repoChange: string;
  workspace: string;
}> {
  const configDir = await createTempDir("workforest-finish-config-");
  const baseDir = await createTempDir("workforest-finish-base-");
  process.env["WORKFOREST_CONFIG_DIR"] = configDir;
  await saveWorkspaceConfig(path.join(configDir, "config.json"), {
    directory: { base: baseDir },
  });

  const repoChange = path.join(baseDir, "Repos", "workforest", "cli-redesign");
  const workspace = path.join(baseDir, "Workspaces", "_adhoc", "experiment");
  await Promise.all([
    mkdir(repoChange, { recursive: true }),
    mkdir(path.join(workspace, "api"), { recursive: true }),
    mkdir(path.join(workspace, "front"), { recursive: true }),
  ]);
  await writeWorktreeMetadata(path.dirname(repoChange), {
    featureName: "cli-redesign",
    branchName: "tomdale/cli-redesign",
    repos: [
      {
        name: "workforest",
        remote: "git@github.com:tomdale/workforest.git",
        hasLockfile: true,
      },
    ],
  });
  await writeWorkspaceMetadata(workspace, {
    featureName: "experiment",
    branchName: "tomdale/experiment",
    repos: [
      {
        name: "api",
        remote: "git@github.com:vercel/api.git",
        hasLockfile: true,
      },
      {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        hasLockfile: true,
      },
    ],
  });

  return { baseDir, repoChange, workspace };
}

function invocation(
  beforeDoubleDash: readonly string[],
  flags: Readonly<Record<string, boolean | string | undefined>> = {},
): ParsedInvocation {
  return { beforeDoubleDash, flags } as ParsedInvocation;
}

function repositorySafety(
  overrides: Partial<DeleteRepositorySafety> = {},
): DeleteRepositorySafety {
  const name = overrides.name ?? "workforest";
  const repoPath = overrides.path ?? `/tmp/${name}`;

  return {
    name,
    path: repoPath,
    branch: overrides.branch ?? "tomdale/cli-redesign",
    state: overrides.state ?? "clean",
    base: overrides.base ?? "origin/main",
    integrated: overrides.integrated ?? true,
  };
}

function taskSafety(
  overrides: Partial<DeleteTaskSafety> = {},
): DeleteTaskSafety {
  return {
    selector: overrides.selector ?? "api/fix-tests",
    parentRepo: overrides.parentRepo ?? "api",
    slug: overrides.slug ?? "fix-tests",
    branch: overrides.branch ?? "tomdale/experiment/fix-tests",
    state: overrides.state ?? "ready",
    merged: overrides.merged ?? true,
  };
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
