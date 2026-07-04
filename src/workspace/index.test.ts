import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathExists } from "@wf-plugin/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  printRepoSetupFailures,
  stampWorkspace,
  writeInitialWorkspaceMetadata,
} from "./index.ts";
import {
  getInitializationDir,
  initializeWorkspaceInitialization,
  readWorkspaceInitializationState,
} from "./initialization.ts";
import {
  hasWorkspaceMetadata,
  readWorkspaceMetadata,
  updateWorkspaceRepo,
} from "./metadata.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workforest-workspace-"));
  tempDirs.push(dir);
  return dir;
}

describe("workspace stamping output", () => {
  it("emits setup failures without writing to stdout", () => {
    const events: import("../services/events.ts").ServiceEvent[] = [];
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    printRepoSetupFailures(
      [
        {
          repoName: "front",
          step: "initializer:Turbo link",
          message:
            "turbo link --yes failed to start: command not found (turbo)",
          logPath: "/workspace/.workforest/logs/front.log",
          logExcerpt: "[initializer:Turbo link] turbo link --yes",
        },
      ],
      (event) => events.push(event),
    );

    const output = events[0]?.type === "message" ? events[0].message : "";

    expect(output).toContain("Some repositories did not complete setup");
    expect(output).toContain("front");
    expect(output).toContain("Step: initializer:Turbo link");
    expect(output).toContain("command not found");
    expect(output).toContain("/workspace/.workforest/logs/front.log");
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it("updates repo metadata as each worktree is prepared", async () => {
    const workspaceDir = await createTempDir();

    await writeInitialWorkspaceMetadata({
      workspaceDir,
      featureName: "fix-auth",
      branchName: "tomdale/fix-auth",
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
        },
      ],
    });

    await updateWorkspaceRepo(workspaceDir, {
      name: "front",
      remote: "git@github.com:vercel/front.git",
      feature_branch: "tomdale/fix-auth",
      has_lockfile: true,
    });

    await expect(readWorkspaceMetadata(workspaceDir)).resolves.toMatchObject({
      repos: [
        {
          name: "front",
          feature_branch: "tomdale/fix-auth",
          has_lockfile: true,
        },
      ],
    });
  });
});

describe("workspace resume", () => {
  const repo = {
    name: "front",
    remote: "git@github.com:vercel/front.git",
  };

  async function seedExistingWorkspace(workspaceDir: string): Promise<void> {
    await writeInitialWorkspaceMetadata({
      workspaceDir,
      featureName: "fix-auth",
      branchName: "tomdale/fix-auth",
      repos: [repo],
    });
    await initializeWorkspaceInitialization({ workspaceDir, repos: [repo] });
  }

  async function markRepoReady(
    workspaceDir: string,
    repoName: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const statePath = path.join(
      getInitializationDir(workspaceDir),
      "repos",
      `${encodeURIComponent(repoName)}.json`,
    );
    await writeFile(
      statePath,
      `${JSON.stringify({
        version: 1,
        repo: repoName,
        status: "ready",
        has_lockfile: true,
        attempt: 1,
        created_at: now,
        updated_at: now,
        completed_at: now,
      })}\n`,
      "utf8",
    );
  }

  it("rejects a non-empty directory without workspace metadata", async () => {
    const workspaceDir = await createTempDir();
    await writeFile(path.join(workspaceDir, "stray.txt"), "not a workspace");

    await expect(
      stampWorkspace({
        featureName: "fix-auth",
        workspaceDir,
        repos: [repo],
      }),
    ).rejects.toThrow(/already exists and is not empty/);
  });

  it("rejects resuming with a different repository set", async () => {
    const workspaceDir = await createTempDir();
    await seedExistingWorkspace(workspaceDir);

    await expect(
      stampWorkspace({
        featureName: "fix-auth",
        workspaceDir,
        repos: [
          repo,
          { name: "docs", remote: "git@github.com:vercel/docs.git" },
        ],
      }),
    ).rejects.toThrow(/different repository set/);
  });

  it("resumes a workspace whose repositories are already ready", async () => {
    const workspaceDir = await createTempDir();
    await seedExistingWorkspace(workspaceDir);
    await mkdir(path.join(workspaceDir, repo.name), { recursive: true });
    await markRepoReady(workspaceDir, repo.name);

    const result = await stampWorkspace({
      featureName: "fix-auth",
      workspaceDir,
      repos: [repo],
    });

    expect(result.setupFailures).toEqual([]);
    await expect(
      readWorkspaceInitializationState(workspaceDir),
    ).resolves.toMatchObject({ status: "ready" });
    await expect(
      pathExists(
        path.join(
          workspaceDir,
          `${path.basename(workspaceDir)}.code-workspace`,
        ),
      ),
    ).resolves.toBe(true);
  });
});

describe("workspace metadata", () => {
  it("writes initial metadata before setup has completed", async () => {
    const workspaceDir = await createTempDir();

    await writeInitialWorkspaceMetadata({
      workspaceDir,
      featureName: "fix-auth",
      description: "fix auth",
      templateId: "site",
      branchName: "tomdale/fix-auth",
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
        },
      ],
    });

    await expect(hasWorkspaceMetadata(workspaceDir)).resolves.toBe(true);
    await expect(readWorkspaceMetadata(workspaceDir)).resolves.toMatchObject({
      workspace: {
        feature_name: "fix-auth",
        description: "fix auth",
        template_id: "site",
      },
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          feature_branch: "tomdale/fix-auth",
          has_lockfile: false,
        },
      ],
    });
  });
});
