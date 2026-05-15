import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  printRepoSetupFailures,
  writeInitialWorkspaceMetadata,
} from "./index.ts";
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
  it("prints setup failures to stdout", () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    printRepoSetupFailures([
      {
        repoName: "front",
        step: "initializer:Turbo link",
        message: "turbo link --yes failed to start: command not found (turbo)",
        logPath: "/workspace/.workforest/logs/front.log",
        logExcerpt: "[initializer:Turbo link] turbo link --yes",
      },
    ]);

    const output = writes.join("");

    expect(output).toContain("Some repositories did not complete setup");
    expect(output).toContain("front");
    expect(output).toContain("Step: initializer:Turbo link");
    expect(output).toContain("command not found");
    expect(output).toContain("/workspace/.workforest/logs/front.log");
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
          defaultBranch: "main",
        },
      ],
    });

    await updateWorkspaceRepo(workspaceDir, {
      name: "front",
      remote: "git@github.com:vercel/front.git",
      default_branch: "main",
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
          defaultBranch: "main",
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
          default_branch: "main",
          feature_branch: "tomdale/fix-auth",
          has_lockfile: false,
        },
      ],
    });
  });
});
