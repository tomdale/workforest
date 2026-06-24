import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationalError, UsageError } from "./cli/errors.ts";
import { runChangeDeleteCommand, runFinishCommand } from "./cli/finish.ts";
import type { ParsedInvocation } from "./cli/types.ts";
import { saveWorkspaceConfig } from "./config.ts";
import type { ChangeInventoryEntry } from "./workspace/change-inventory.ts";
import { writeWorkspaceMetadata } from "./workspace/metadata.ts";
import type {
  ChangeRepositoryStatus,
  ChangeStatus,
  ChangeTaskStatus,
  DirtySummary,
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

describe("wf finish", () => {
  it("refuses dirty and unintegrated repository changes", async () => {
    const fixture = await createCleanupFixture();
    const cleanupRepositoryChange = vi.fn();
    const buildChangeStatus = vi.fn(async (entry: ChangeInventoryEntry) =>
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

    const error = await runFinishCommand(
      invocation(["workforest/cli-redesign"]),
      {
        interactive: false,
        writeShellCdPath: async () => {},
        buildChangeStatus,
        cleanupRepositoryChange,
        resolveRepositorySpecifiers: async () => [],
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OperationalError);
    expect(error).toMatchObject({
      message: expect.stringContaining(
        "Cannot finish workforest/cli-redesign.",
      ),
    });
    expect(error).toMatchObject({
      message: expect.stringContaining(
        `Run: git -C ${fixture.repoChange} status`,
      ),
    });
    expect(error).toMatchObject({
      message: expect.stringContaining(
        "Merge the change branch first, or pass --force if it was integrated another way.",
      ),
    });
    expect(cleanupRepositoryChange).not.toHaveBeenCalled();
  });

  it("uses --force to clean a repository change when Workforest cannot prove integration", async () => {
    const fixture = await createCleanupFixture();
    const cdTargets: string[] = [];
    const cleanupRepositoryChange = vi.fn(async () => ({
      dryRun: false,
      removedRepos: ["workforest"],
      deletedBranches: [],
    }));
    const buildChangeStatus = vi.fn(async (entry: ChangeInventoryEntry) =>
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

    await runFinishCommand(
      invocation(["workforest/cli-redesign"], { force: true }),
      {
        interactive: false,
        writeShellCdPath: async (targetDir) => {
          cdTargets.push(targetDir);
        },
        buildChangeStatus,
        cleanupRepositoryChange,
        resolveRepositorySpecifiers: async () => [],
        cwd: path.join(fixture.repoChange, "src"),
      },
    );

    expect(cleanupRepositoryChange).toHaveBeenCalledWith(
      expect.objectContaining({
        repoName: "workforest",
        changePath: fixture.repoChange,
      }),
    );
    expect(cdTargets).toEqual([path.dirname(fixture.repoChange)]);
  });

  it("refuses unmerged nested tasks", async () => {
    const fixture = await createCleanupFixture();
    const cleanupWorkspace = vi.fn();
    const buildChangeStatus = vi.fn(async (entry: ChangeInventoryEntry) =>
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
      runFinishCommand(invocation(["_adhoc/experiment"]), {
        interactive: false,
        writeShellCdPath: async () => {},
        buildChangeStatus,
        cleanupWorkspace,
      }),
    ).rejects.toThrow("wf task delete fix-tests --repo api --force");
    expect(cleanupWorkspace).not.toHaveBeenCalled();
  });
});

describe("wf delete", () => {
  it("requires an explicit selector", async () => {
    await createCleanupFixture();

    await expect(
      runChangeDeleteCommand(invocation([]), {
        interactive: false,
        writeShellCdPath: async () => {},
      }),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("requires --force without an interactive terminal", async () => {
    await createCleanupFixture();

    await expect(
      runChangeDeleteCommand(invocation(["_adhoc/experiment"]), {
        interactive: false,
        writeShellCdPath: async () => {},
      }),
    ).rejects.toThrow(
      "Deleting a change requires --force without an interactive terminal.",
    );
  });

  it("does not delete when interactive confirmation is rejected", async () => {
    await createCleanupFixture();
    const cleanupWorkspace = vi.fn();

    await runChangeDeleteCommand(invocation(["_adhoc/experiment"]), {
      interactive: true,
      writeShellCdPath: async () => {},
      confirm: async () => false,
      cleanupWorkspace,
    });

    expect(cleanupWorkspace).not.toHaveBeenCalled();
  });

  it("deletes a workspace change without integration proof when forced", async () => {
    const fixture = await createCleanupFixture();
    const cleanupWorkspace = vi.fn(async () => ({
      dryRun: false,
      removedRepos: ["api", "front"],
      deletedBranches: [],
    }));
    const buildChangeStatus = vi.fn();

    await runChangeDeleteCommand(
      invocation(["_adhoc/experiment"], { force: true }),
      {
        interactive: false,
        writeShellCdPath: async () => {},
        buildChangeStatus,
        cleanupWorkspace,
      },
    );

    expect(buildChangeStatus).not.toHaveBeenCalled();
    expect(cleanupWorkspace).toHaveBeenCalledWith(
      fixture.workspace,
      expect.objectContaining({ keepMirrors: true }),
    );
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
  await writeWorkspaceMetadata(workspace, {
    featureName: "experiment",
    branchName: "tomdale/experiment",
    repos: [
      {
        name: "api",
        remote: "git@github.com:vercel/api.git",
        defaultBranch: "main",
        hasLockfile: true,
      },
      {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        defaultBranch: "main",
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
  entry: ChangeInventoryEntry,
  overrides: Readonly<{
    repositories?: readonly ChangeRepositoryStatus[];
    tasks?: readonly ChangeTaskStatus[];
  }> = {},
): ChangeStatus {
  return {
    selector: entry.selector,
    type: entry.type,
    typeLabel:
      entry.type === "repository-change" ? "repository change" : "workspace",
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
  overrides: Partial<ChangeRepositoryStatus> = {},
): ChangeRepositoryStatus {
  const name = overrides.name ?? "workforest";
  const repoPath = overrides.path ?? `/tmp/${name}`;

  return {
    name,
    path: repoPath,
    branch: overrides.branch ?? "tomdale/cli-redesign",
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

function taskStatus(
  overrides: Partial<ChangeTaskStatus> = {},
): ChangeTaskStatus {
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
