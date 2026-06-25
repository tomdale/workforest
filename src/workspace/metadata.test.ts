import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendTasks,
  appendWorkspaceRepos,
  getMetadataPath,
  getRepositoryChangeMetadataPath,
  listRepositoryChangeMetadata,
  readRepositoryChangeMetadata,
  readWorkspaceMetadata,
  removeRepositoryChangeMetadata,
  removeTasks,
  writeRepositoryChangeMetadata,
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

  it("tracks tasks separately from workspace repos", async () => {
    const workspaceDir = await createWorkspaceDir();

    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "fix-auth-bug",
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
          hasLockfile: true,
        },
      ],
    });

    await appendTasks(workspaceDir, [
      {
        slug: "fix-tests",
        parent_repo: "front",
        path: "_tasks/front/fix-tests",
        branch: "tomdale/fix-tests",
        base_branch: "tomdale/fix-auth-bug",
        base_sha: "abc123",
        created_at: "2026-05-15T00:00:00.000Z",
        setup_status: "ready",
      },
    ]);

    await expect(readWorkspaceMetadata(workspaceDir)).resolves.toMatchObject({
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          default_branch: "main",
          has_lockfile: true,
        },
      ],
      tasks: [
        {
          slug: "fix-tests",
          parent_repo: "front",
          path: "_tasks/front/fix-tests",
        },
      ],
    });
  });

  it("preserves simultaneous task metadata updates", async () => {
    const workspaceDir = await createWorkspaceDir();

    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "fix-auth-bug",
      repos: [],
    });

    const worktree = (slug: string) => ({
      slug,
      parent_repo: "front",
      path: `_tasks/front/${slug}`,
      branch: `tomdale/${slug}`,
      base_branch: "main",
      base_sha: "abc123",
      created_at: "2026-05-15T00:00:00.000Z",
      setup_status: "ready" as const,
    });

    await Promise.all([
      appendTasks(workspaceDir, [worktree("alpha")]),
      appendTasks(workspaceDir, [worktree("beta")]),
      appendTasks(workspaceDir, [worktree("gamma")]),
    ]);

    const metadata = await readWorkspaceMetadata(workspaceDir);
    expect(metadata?.tasks?.map((entry) => entry.slug).sort()).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(
      JSON.parse(await readFile(getMetadataPath(workspaceDir), "utf8")),
    ).toEqual(metadata);
  });

  it("removes tasks without changing repos", async () => {
    const workspaceDir = await createWorkspaceDir();

    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "fix-auth-bug",
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
          hasLockfile: true,
        },
      ],
    });
    await appendTasks(workspaceDir, [
      {
        slug: "fix-tests",
        parent_repo: "front",
        path: "_tasks/front/fix-tests",
        branch: "tomdale/fix-tests",
        base_branch: "tomdale/fix-auth-bug",
        base_sha: "abc123",
        created_at: "2026-05-15T00:00:00.000Z",
        setup_status: "ready",
      },
    ]);

    await removeTasks(workspaceDir, [
      { parent_repo: "front", slug: "fix-tests" },
    ]);

    await expect(readWorkspaceMetadata(workspaceDir)).resolves.toEqual({
      workspace: expect.any(Object),
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

  it.each([
    [
      "repository name",
      (metadata: UnsafeMetadata) => {
        firstRepo(metadata).name = "..";
      },
    ],
    [
      "task path",
      (metadata: UnsafeMetadata) => {
        firstTask(metadata).path = "../outside";
      },
    ],
    [
      "task path at the wrong contained location",
      (metadata: UnsafeMetadata) => {
        firstTask(metadata).path = "_tasks/front/another-task";
      },
    ],
    [
      "task parent repository",
      (metadata: UnsafeMetadata) => {
        firstTask(metadata).parent_repo = "..";
      },
    ],
    [
      "task setup log",
      (metadata: UnsafeMetadata) => {
        firstTask(metadata).setup_log = "..\\sentinel.txt";
      },
    ],
    [
      "task setup log at the wrong contained location",
      (metadata: UnsafeMetadata) => {
        firstTask(metadata).setup_log = ".workforest/logs/another-task.log";
      },
    ],
    [
      "review worktree path",
      (metadata: UnsafeMetadata) => {
        firstReviewWorktree(metadata).path = "/tmp/outside";
      },
    ],
    [
      "review worktree path at the wrong contained location",
      (metadata: UnsafeMetadata) => {
        firstReviewWorktree(metadata).path = "pr-456";
      },
    ],
  ])("rejects an unsafe persisted %s", async (_label, mutate) => {
    const workspaceDir = await createWorkspaceDir();
    const metadata = createUnsafeMetadataFixture();
    mutate(metadata);
    await mkdir(path.join(workspaceDir, ".workforest"));
    await writeFile(
      path.join(workspaceDir, ".workforest", "workspace.json"),
      JSON.stringify(metadata),
      "utf8",
    );

    await expect(readWorkspaceMetadata(workspaceDir)).rejects.toThrow();
  });

  it("rejects a persisted task path through a symlink", async () => {
    const workspaceDir = await createWorkspaceDir();
    const outsideDir = await createWorkspaceDir();
    await mkdir(path.join(workspaceDir, "_tasks"), { recursive: true });
    await symlink(outsideDir, path.join(workspaceDir, "_tasks", "front"));
    await writeRawMetadata(workspaceDir, createUnsafeMetadataFixture());

    await expect(readWorkspaceMetadata(workspaceDir)).rejects.toThrow(
      "symbolic link",
    );
  });

  it("rejects a persisted setup log path through a symlink", async () => {
    const workspaceDir = await createWorkspaceDir();
    const outsideDir = await createWorkspaceDir();
    await mkdir(path.join(workspaceDir, ".workforest"), { recursive: true });
    await symlink(outsideDir, path.join(workspaceDir, ".workforest", "logs"));
    await writeRawMetadata(workspaceDir, createUnsafeMetadataFixture());

    await expect(readWorkspaceMetadata(workspaceDir)).rejects.toThrow(
      "symbolic link",
    );
  });

  it("rejects reads through a symlinked metadata directory", async () => {
    const workspaceDir = await createWorkspaceDir();
    const outsideDir = await createWorkspaceDir();
    const outsideMetadataPath = path.join(outsideDir, "workspace.json");
    await writeFile(
      outsideMetadataPath,
      JSON.stringify(createUnsafeMetadataFixture()),
      "utf8",
    );
    await symlink(outsideDir, path.join(workspaceDir, ".workforest"));

    await expect(readWorkspaceMetadata(workspaceDir)).rejects.toThrow(
      "must not be a symbolic link",
    );
    expect(() => getMetadataPath(workspaceDir)).toThrow(
      "must not be a symbolic link",
    );
    await expect(readFile(outsideMetadataPath, "utf8")).resolves.toContain(
      '"feature_name":"safe"',
    );
  });

  it("rejects writes through a symlinked metadata directory", async () => {
    const workspaceDir = await createWorkspaceDir();
    const outsideDir = await createWorkspaceDir();
    const sentinel = path.join(outsideDir, "sentinel.txt");
    await writeFile(sentinel, "keep\n", "utf8");
    await symlink(outsideDir, path.join(workspaceDir, ".workforest"));

    await expect(
      writeWorkspaceMetadata(workspaceDir, {
        featureName: "safe",
        repos: [],
      }),
    ).rejects.toThrow("must not be a symbolic link");

    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep\n");
    await expect(
      stat(path.join(outsideDir, "workspace.json")),
    ).rejects.toThrow();
  });

  it("rejects unsafe values through metadata write APIs", async () => {
    const workspaceDir = await createWorkspaceDir();

    await expect(
      writeWorkspaceMetadata(workspaceDir, {
        featureName: "../outside",
        repos: [],
      }),
    ).rejects.toThrow("Workspace feature name");

    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "safe",
      repos: [],
    });
    await expect(
      appendWorkspaceRepos(workspaceDir, [
        {
          name: "..",
          remote: "git@github.com:vercel/front.git",
          default_branch: "main",
          has_lockfile: false,
        },
      ]),
    ).rejects.toThrow("Repository name");
  });
});

describe("repository change metadata", () => {
  it("writes repository change metadata under the repo root", async () => {
    const repoRootDir = await createWorkspaceDir();

    await writeRepositoryChangeMetadata(repoRootDir, {
      featureName: "fix-auth-bug",
      branchName: "tomdale/fix-auth-bug",
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
          hasLockfile: true,
        },
      ],
    });

    const metadataPath = getRepositoryChangeMetadataPath(
      repoRootDir,
      "fix-auth-bug",
    );
    await expect(
      readRepositoryChangeMetadata(repoRootDir, "fix-auth-bug"),
    ).resolves.toMatchObject({
      workspace: { feature_name: "fix-auth-bug" },
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          feature_branch: "tomdale/fix-auth-bug",
          has_lockfile: true,
        },
      ],
    });
    await expect(readFile(metadataPath, "utf8")).resolves.toContain(
      '"feature_name": "fix-auth-bug"',
    );
  });

  it("lists and removes repository change metadata", async () => {
    const repoRootDir = await createWorkspaceDir();
    await writeRepositoryChangeMetadata(repoRootDir, {
      featureName: "alpha",
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
          hasLockfile: false,
        },
      ],
    });
    await writeRepositoryChangeMetadata(repoRootDir, {
      featureName: "beta",
      repos: [
        {
          name: "front",
          remote: "git@github.com:vercel/front.git",
          defaultBranch: "main",
          hasLockfile: false,
        },
      ],
    });

    await expect(listRepositoryChangeMetadata(repoRootDir)).resolves.toEqual([
      expect.objectContaining({ changeName: "alpha" }),
      expect.objectContaining({ changeName: "beta" }),
    ]);

    await removeRepositoryChangeMetadata(repoRootDir, "alpha");

    await expect(
      readRepositoryChangeMetadata(repoRootDir, "alpha"),
    ).resolves.toBeNull();
    await expect(listRepositoryChangeMetadata(repoRootDir)).resolves.toEqual([
      expect.objectContaining({ changeName: "beta" }),
    ]);
  });
});

type UnsafeMetadata = {
  workspace: {
    version: string;
    created_at: string;
    feature_name: string;
  };
  repos: Array<{
    name: string;
    remote: string;
    default_branch: string;
    has_lockfile: boolean;
  }>;
  tasks?: Array<{
    slug: string;
    parent_repo: string;
    path: string;
    branch: string;
    base_branch: string;
    base_sha: string;
    created_at: string;
    setup_status: "ready";
    setup_log?: string;
  }>;
  review_worktrees?: Array<{
    pr_number: number;
    path: string;
    created_at: string;
  }>;
};

function createUnsafeMetadataFixture(): UnsafeMetadata {
  return {
    workspace: {
      version: "1",
      created_at: "2026-05-15T00:00:00.000Z",
      feature_name: "safe",
    },
    repos: [
      {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        default_branch: "main",
        has_lockfile: true,
      },
    ],
    tasks: [
      {
        slug: "fix-tests",
        parent_repo: "front",
        path: "_tasks/front/fix-tests",
        branch: "tomdale/fix-tests",
        base_branch: "main",
        base_sha: "abc123",
        created_at: "2026-05-15T00:00:00.000Z",
        setup_status: "ready",
        setup_log: ".workforest/logs/front-fix-tests.log",
      },
    ],
    review_worktrees: [
      {
        pr_number: 123,
        path: "pr-123",
        created_at: "2026-05-15T00:00:00.000Z",
      },
    ],
  };
}

async function writeRawMetadata(
  workspaceDir: string,
  metadata: UnsafeMetadata,
): Promise<void> {
  await mkdir(path.join(workspaceDir, ".workforest"), { recursive: true });
  await writeFile(
    path.join(workspaceDir, ".workforest", "workspace.json"),
    JSON.stringify(metadata),
    "utf8",
  );
}

function firstRepo(metadata: UnsafeMetadata): UnsafeMetadata["repos"][number] {
  const repo = metadata.repos[0];
  if (!repo) throw new Error("Missing repository fixture.");
  return repo;
}

function firstTask(
  metadata: UnsafeMetadata,
): NonNullable<UnsafeMetadata["tasks"]>[number] {
  const worktree = metadata.tasks?.[0];
  if (!worktree) throw new Error("Missing task fixture.");
  return worktree;
}

function firstReviewWorktree(
  metadata: UnsafeMetadata,
): NonNullable<UnsafeMetadata["review_worktrees"]>[number] {
  const worktree = metadata.review_worktrees?.[0];
  if (!worktree) throw new Error("Missing review worktree fixture.");
  return worktree;
}
