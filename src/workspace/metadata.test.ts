import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendWorkspaceRepos,
  readWorkspaceMetadata,
  writeWorkspaceMetadata,
} from "./metadata.ts";

const tempDirs: string[] = [];

async function createWorkspaceDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workforest-workspace-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("workspace metadata", () => {
  it("appends repos without overwriting workspace fields", async () => {
    const workspaceDir = await createWorkspaceDir();

    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "fix-auth-bug",
      description: "Fix authentication edge case",
      templateId: "full-stack",
      branchName: "feature/fix-auth-bug",
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
          hasLockfile: true,
        },
      ],
    });

    const original = await readWorkspaceMetadata(workspaceDir);
    expect(original).not.toBeNull();

    await appendWorkspaceRepos(workspaceDir, [
      {
        name: "docs",
        remote: "git@github.com:vercel/docs.git",
        default_branch: "main",
        has_lockfile: false,
        feature_branch: "feature/fix-auth-bug",
      },
    ]);

    const updated = await readWorkspaceMetadata(workspaceDir);
    expect(updated).toEqual({
      workspace: original?.workspace,
      repos: [
        ...(original?.repos ?? []),
        {
          name: "docs",
          remote: "git@github.com:vercel/docs.git",
          default_branch: "main",
          has_lockfile: false,
          feature_branch: "feature/fix-auth-bug",
        },
      ],
    });
  });

  it("fails when appending to a workspace without metadata", async () => {
    const workspaceDir = await createWorkspaceDir();

    await expect(
      appendWorkspaceRepos(workspaceDir, [
        {
          name: "docs",
          remote: "git@github.com:vercel/docs.git",
          default_branch: "main",
          has_lockfile: false,
        },
      ]),
    ).rejects.toThrow("Workspace metadata not found");
  });
});
