import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendWorkspaceRepos,
  getMetadataPath,
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
  it("writes new metadata to .workforest/workspace.json", async () => {
    const workspaceDir = await createWorkspaceDir();

    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "fix-auth-bug",
      repos: [],
    });

    const metadataPath = getMetadataPath(workspaceDir);
    const metadataStat = await stat(metadataPath);
    expect(metadataStat.isFile()).toBe(true);
    expect(JSON.parse(await readFile(metadataPath, "utf8"))).toMatchObject({
      workspace: {
        feature_name: "fix-auth-bug",
      },
      repos: [],
    });
  });

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

  it("reads legacy .workforest file metadata", async () => {
    const workspaceDir = await createWorkspaceDir();
    const legacyMetadata = {
      workspace: {
        version: "1",
        created_at: "2026-05-10T00:00:00.000Z",
        feature_name: "legacy",
      },
      repos: [],
    };

    await writeFile(
      path.join(workspaceDir, ".workforest"),
      `${JSON.stringify(legacyMetadata, null, 2)}\n`,
      "utf8",
    );

    await expect(readWorkspaceMetadata(workspaceDir)).resolves.toEqual(
      legacyMetadata,
    );
  });

  it("migrates legacy .workforest file metadata when appending repos", async () => {
    const workspaceDir = await createWorkspaceDir();
    const legacyMetadata = {
      workspace: {
        version: "1",
        created_at: "2026-05-10T00:00:00.000Z",
        feature_name: "legacy",
      },
      repos: [],
    };

    await writeFile(
      path.join(workspaceDir, ".workforest"),
      `${JSON.stringify(legacyMetadata, null, 2)}\n`,
      "utf8",
    );

    await appendWorkspaceRepos(workspaceDir, [
      {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        default_branch: "main",
        has_lockfile: true,
      },
    ]);

    const metadataDirStat = await stat(path.join(workspaceDir, ".workforest"));
    expect(metadataDirStat.isDirectory()).toBe(true);
    await expect(readWorkspaceMetadata(workspaceDir)).resolves.toMatchObject({
      workspace: legacyMetadata.workspace,
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          default_branch: "main",
          has_lockfile: true,
        },
      ],
    });
  });

  it("returns null when the metadata directory exists without workspace metadata", async () => {
    const workspaceDir = await createWorkspaceDir();
    await mkdir(path.join(workspaceDir, ".workforest"));

    await expect(readWorkspaceMetadata(workspaceDir)).resolves.toBeNull();
  });
});
