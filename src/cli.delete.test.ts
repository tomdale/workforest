import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDeleteCommand } from "./cli/delete.ts";
import { OperationalError } from "./cli/errors.ts";
import type { ParsedInvocation } from "./cli/types.ts";
import { saveWorkspaceConfig } from "./config.ts";
import type { InventoryEntry } from "./workspace/inventory.ts";
import {
  writeWorkspaceMetadata,
  writeWorktreeMetadata,
} from "./workspace/metadata.ts";
import type {
  DirtySummary,
  RepositoryStatus,
  Status,
  TaskStatus,
} from "./workspace/status.ts";

const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const ORIGINAL_CWD = process.cwd();
const tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(ORIGINAL_CWD);
  restoreEnv("WORKFOREST_CONFIG_DIR", ORIGINAL_CONFIG_DIR);
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("wf delete", () => {
  it("refuses dirty and unintegrated worktrees", async () => {
    const fixture = await createCleanupFixture();
    const cleanupWorktree = vi.fn();
    const buildStatus = vi.fn(async (entry: InventoryEntry) =>
      statusFor(entry, {
        repositories: [
          repositoryStatus({
            path: fixture.repoChange,
            state: "dirty",
            integrated: false,
          }),
        ],
      }),
    );

    const error = await runDeleteCommand(
      invocation(["workforest/cli-redesign"]),
      {
        interactive: false,
        writeShellCdPath: async () => {},
        buildStatus,
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
    const buildStatus = vi.fn();

    await runDeleteCommand(
      invocation(["workforest/cli-redesign"], { force: true }),
      {
        interactive: false,
        writeShellCdPath: async (targetDir: string) => {
          cdTargets.push(targetDir);
        },
        buildStatus,
        cleanupWorktree,
        resolveRepositorySpecifiers: async () => [],
        cwd: invocationCwd,
      },
    );

    expect(buildStatus).not.toHaveBeenCalled();
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
    const buildStatus = vi.fn(async (entry: InventoryEntry) =>
      statusFor(entry, {
        repositories: [
          repositoryStatus({
            name: "api",
            path: path.join(fixture.workspace, "api"),
            integrated: true,
          }),
        ],
        tasks: [taskStatus({ merged: false })],
      }),
    );

    await expect(
      runDeleteCommand(invocation(["_adhoc/experiment"]), {
        interactive: false,
        writeShellCdPath: async () => {},
        buildStatus,
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
    const buildStatus = vi.fn(async (entry: InventoryEntry) =>
      statusFor(entry, {
        repositories: [
          repositoryStatus({
            name: "api",
            path: path.join(fixture.workspace, "api"),
            integrated: true,
          }),
        ],
      }),
    );

    await runDeleteCommand(invocation(["_adhoc/experiment"]), {
      interactive: false,
      writeShellCdPath: async () => {},
      buildStatus,
      cleanupWorkspace,
    });

    expect(cleanupWorkspace).toHaveBeenCalledWith(
      fixture.workspace,
      expect.objectContaining({ keepMirrors: true }),
    );
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
    const buildStatus = vi.fn();

    await runDeleteCommand(invocation(["_adhoc/experiment"], { force: true }), {
      interactive: false,
      writeShellCdPath: async () => {},
      buildStatus,
      cleanupWorkspace,
    });

    expect(buildStatus).not.toHaveBeenCalled();
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

function statusFor(
  entry: InventoryEntry,
  overrides: Readonly<{
    repositories?: readonly RepositoryStatus[];
    tasks?: readonly TaskStatus[];
  }> = {},
): Status {
  return {
    selector: entry.selector,
    type: entry.type,
    typeLabel: entry.type === "worktree" ? "repository change" : "workspace",
    groupName: entry.groupName,
    changeName: entry.changeName,
    path: entry.path,
    modifiedAt: entry.modifiedAt,
    modifiedAtMs: entry.modifiedAtMs,
    summary: {
      change: entry.selector,
      type: entry.type,
      path: entry.path,
      updated: entry.modifiedAt,
    },
    repositories: overrides.repositories ?? [],
    tasks: overrides.tasks ?? [],
    initialization: null,
    nextSteps: [],
  };
}

function repositoryStatus(
  overrides: Partial<RepositoryStatus> = {},
): RepositoryStatus {
  const name = overrides.name ?? "workforest";
  const repoPath = overrides.path ?? `/tmp/${name}`;

  return {
    name,
    path: repoPath,
    branch: overrides.branch ?? "tomdale/cli-redesign",
    defaultBranch: overrides.defaultBranch ?? "main",
    state: overrides.state ?? "clean",
    dirty: overrides.dirty ?? dirtySummary(overrides.state === "dirty" ? 1 : 0),
    base: overrides.base ?? "origin/main",
    ahead: overrides.ahead ?? 0,
    behind: overrides.behind ?? 0,
    integrated: overrides.integrated ?? true,
    setup: overrides.setup ?? { status: "ready" },
    line: overrides.line ?? `${name} - clean`,
    details: overrides.details ?? [],
  };
}

function taskStatus(overrides: Partial<TaskStatus> = {}): TaskStatus {
  return {
    selector: overrides.selector ?? "api/fix-tests",
    parentRepo: overrides.parentRepo ?? "api",
    slug: overrides.slug ?? "fix-tests",
    branch: overrides.branch ?? "tomdale/experiment/fix-tests",
    path: overrides.path ?? "/tmp/api-fix-tests",
    state: overrides.state ?? "ready",
    merged: overrides.merged ?? true,
    line: overrides.line ?? "api/fix-tests - ready",
    details: overrides.details ?? [],
  };
}

function dirtySummary(total: number): DirtySummary {
  return {
    total,
    modified: total,
    added: 0,
    deleted: 0,
    renamed: 0,
    untracked: 0,
    other: 0,
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
