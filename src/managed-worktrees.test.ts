import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createManagedWorktree,
  listManagedWorktrees,
  parseGitWorktrees,
  promoteManagedWorktree,
  resolveManagedWorktreeContext,
} from "./managed-worktrees.ts";
import { readWorkspaceMetadata } from "./workspace/metadata.ts";

const execFileAsync = promisify(execFile);
const originalCacheDir = process.env["WORKFOREST_CACHE_DIR"];
const tempDirs: string[] = [];

afterEach(async () => {
  if (originalCacheDir === undefined) {
    delete process.env["WORKFOREST_CACHE_DIR"];
  } else {
    process.env["WORKFOREST_CACHE_DIR"] = originalCacheDir;
  }

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("managed single-repository worktrees", { timeout: 20_000 }, () => {
  it("resolves canonical worktrees from their cache mirror and lists siblings", async () => {
    const fixture = await createManagedFixture();
    const sibling = path.join(fixture.defaultDir, "front", "experiment");
    await git(
      fixture.mirrorDir,
      "worktree",
      "add",
      "-b",
      "tomdale/experiment",
      sibling,
      "main",
    );

    const context = await resolveManagedWorktreeContext({
      cwd: path.join(fixture.checkoutDir, "src"),
      defaultDir: fixture.defaultDir,
    });
    const managedContext = requireManagedContext(context);

    expect(managedContext).toMatchObject({
      checkoutPath: await realpath(fixture.checkoutDir),
      familyDir: await realpath(path.join(fixture.defaultDir, "front")),
      name: "fix-auth",
      branch: "tomdale/fix-auth",
      detached: false,
      locked: false,
      repo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
      },
    });
    expect(
      (await listManagedWorktrees(managedContext)).map((entry) => entry.name),
    ).toEqual(["experiment", "fix-auth"]);

    const unmanagedDir = path.join(fixture.rootDir, "standalone");
    await git(
      fixture.mirrorDir,
      "worktree",
      "add",
      "-b",
      "tomdale/standalone",
      unmanagedDir,
      "main",
    );
    expect(
      await resolveManagedWorktreeContext({
        cwd: unmanagedDir,
        defaultDir: fixture.defaultDir,
      }),
    ).toBeNull();
  });

  it("promotes a dirty checkout without moving sibling worktrees", async () => {
    const fixture = await createManagedFixture();
    const sibling = path.join(fixture.defaultDir, "front", "experiment");
    await git(
      fixture.mirrorDir,
      "worktree",
      "add",
      "-b",
      "tomdale/experiment",
      sibling,
      "main",
    );
    await writeFile(
      path.join(fixture.checkoutDir, "dirty.txt"),
      "uncommitted\n",
      "utf8",
    );

    const context = await resolveManagedWorktreeContext({
      cwd: fixture.checkoutDir,
      defaultDir: fixture.defaultDir,
    });
    const result = await promoteManagedWorktree({
      context: requireManagedContext(context),
      defaultDir: fixture.defaultDir,
    });

    expect(result).toMatchObject({
      workspaceDir: path.join(fixture.defaultDir, "fix-auth"),
      repoDir: path.join(fixture.defaultDir, "fix-auth", "front"),
      failures: [],
      dryRun: false,
    });
    expect(await readFile(path.join(result.repoDir, "dirty.txt"), "utf8")).toBe(
      "uncommitted\n",
    );
    expect(await readFile(path.join(sibling, "README.md"), "utf8")).toBe(
      "fixture\n",
    );

    const metadata = await readWorkspaceMetadata(result.workspaceDir);
    expect(metadata).toMatchObject({
      workspace: { feature_name: "fix-auth" },
      repos: [
        {
          name: "front",
          feature_branch: "tomdale/fix-auth",
        },
      ],
    });
    const workspaceFile = JSON.parse(
      await readFile(
        path.join(result.workspaceDir, "fix-auth.code-workspace"),
        "utf8",
      ),
    ) as { folders: { path: string }[] };
    expect(workspaceFile.folders).toEqual([{ path: "front" }]);

    const { stdout } = await git(
      fixture.mirrorDir,
      "worktree",
      "list",
      "--porcelain",
    );
    expect(stdout).toContain(`worktree ${await realpath(result.repoDir)}`);
    expect(stdout).toContain(`worktree ${await realpath(sibling)}`);
    expect(stdout).not.toContain(
      `worktree ${path.join(await realpath(fixture.defaultDir), "front", "fix-auth")}\n`,
    );
  });

  it("rejects locked and detached promotion sources", async () => {
    const lockedFixture = await createManagedFixture();
    await git(
      lockedFixture.mirrorDir,
      "worktree",
      "lock",
      lockedFixture.checkoutDir,
    );
    const locked = await resolveManagedWorktreeContext({
      cwd: lockedFixture.checkoutDir,
      defaultDir: lockedFixture.defaultDir,
    });
    await expect(
      promoteManagedWorktree({
        context: requireManagedContext(locked),
        defaultDir: lockedFixture.defaultDir,
      }),
    ).rejects.toThrow("locked worktree");

    const detachedFixture = await createManagedFixture();
    await git(detachedFixture.checkoutDir, "checkout", "--detach");
    const detached = await resolveManagedWorktreeContext({
      cwd: detachedFixture.checkoutDir,
      defaultDir: detachedFixture.defaultDir,
    });
    await expect(
      promoteManagedWorktree({
        context: requireManagedContext(detached),
        defaultDir: detachedFixture.defaultDir,
      }),
    ).rejects.toThrow("detached worktree");
  });

  it("previews prefixed promotion with deduplicated repositories", async () => {
    const fixture = await createManagedFixture();
    const context = requireManagedContext(
      await resolveManagedWorktreeContext({
        cwd: fixture.checkoutDir,
        defaultDir: fixture.defaultDir,
      }),
    );
    const result = await promoteManagedWorktree({
      context,
      defaultDir: fixture.defaultDir,
      dirPrefix: "wf-",
      repos: [
        context.repo,
        {
          name: "front",
          remote: "https://github.com/vercel/front.git",
          defaultBranch: "main",
        },
        {
          name: "api",
          remote: "git@github.com:vercel/api.git",
          defaultBranch: "main",
        },
      ],
      dryRun: true,
    });

    expect(result).toMatchObject({
      workspaceDir: path.join(fixture.defaultDir, "wf-fix-auth"),
      repoDir: path.join(fixture.defaultDir, "wf-fix-auth", "front"),
      dryRun: true,
    });
    expect(result.repos.map((repo) => repo.name)).toEqual(["front", "api"]);
    expect(result.addedRepos.map((repo) => repo.name)).toEqual(["api"]);

    await expect(
      promoteManagedWorktree({
        context,
        defaultDir: fixture.defaultDir,
        repos: [
          {
            name: "api",
            remote: "git@github.com:vercel/api.git",
            defaultBranch: "main",
          },
          {
            name: "api",
            remote: "git@github.com:other/api.git",
            defaultBranch: "main",
          },
        ],
        dryRun: true,
      }),
    ).rejects.toThrow('Repository name "api" refers to multiple remotes');
  });

  it("applies template files and hooks after promotion", async () => {
    const fixture = await createManagedFixture();
    const templateDir = path.join(fixture.rootDir, "template");
    await mkdir(path.join(templateDir, "files"), { recursive: true });
    await writeFile(
      path.join(templateDir, "template.jsonc"),
      '{"repos":[]}\n',
      "utf8",
    );
    await writeFile(
      path.join(templateDir, "files", "workspace-note.txt"),
      "promoted\n",
      "utf8",
    );
    const context = requireManagedContext(
      await resolveManagedWorktreeContext({
        cwd: fixture.checkoutDir,
        defaultDir: fixture.defaultDir,
      }),
    );

    const result = await promoteManagedWorktree({
      context,
      defaultDir: fixture.defaultDir,
      template: {
        id: "demo",
        path: path.join(templateDir, "template.jsonc"),
        config: {
          repos: [],
          hooks: [{ name: "Mark promotion", run: "touch hook-ran" }],
        },
      },
    });

    expect(
      await readFile(
        path.join(result.workspaceDir, "workspace-note.txt"),
        "utf8",
      ),
    ).toBe("promoted\n");
    expect(await readFile(path.join(result.repoDir, "hook-ran"), "utf8")).toBe(
      "",
    );
    expect(
      (await readWorkspaceMetadata(result.workspaceDir))?.workspace.template_id,
    ).toBe("demo");
  });

  it("previews configured branch and directory prefixes", async () => {
    const rootDir = await createTempDir();
    const result = await createManagedWorktree({
      repo: {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        defaultBranch: "main",
      },
      name: "fix-auth",
      defaultDir: path.join(rootDir, "workspaces"),
      branchPrefix: "tomdale",
      dryRun: true,
    });

    expect(result).toMatchObject({
      branchName: "tomdale/fix-auth",
      targetDir: path.join(rootDir, "workspaces", "front", "fix-auth"),
      dryRun: true,
    });
  });

  it("parses detached, locked, and bare worktree metadata", () => {
    expect(
      parseGitWorktrees(
        [
          "worktree /cache/front.git",
          "bare",
          "",
          "worktree /work/front/fix-auth",
          "HEAD abc123",
          "detached",
          "locked reason",
          "",
        ].join("\n"),
      ),
    ).toEqual([
      {
        path: "/cache/front.git",
        branch: null,
        detached: false,
        locked: false,
        bare: true,
      },
      {
        path: "/work/front/fix-auth",
        branch: null,
        detached: true,
        locked: true,
        bare: false,
      },
    ]);
  });
});

async function createManagedFixture(): Promise<{
  rootDir: string;
  defaultDir: string;
  mirrorDir: string;
  checkoutDir: string;
}> {
  const rootDir = await createTempDir();
  const sourceDir = path.join(rootDir, "source");
  const cacheDir = path.join(rootDir, "cache");
  const defaultDir = path.join(rootDir, "workspaces");
  const mirrorDir = path.join(cacheDir, "front.git");
  const checkoutDir = path.join(defaultDir, "front", "fix-auth");
  process.env["WORKFOREST_CACHE_DIR"] = cacheDir;

  await mkdir(path.join(sourceDir, "src"), { recursive: true });
  await mkdir(path.dirname(checkoutDir), { recursive: true });
  await git(sourceDir, "init", "--initial-branch=main");
  await git(sourceDir, "config", "user.name", "Workforest Tests");
  await git(sourceDir, "config", "user.email", "tests@workforest.dev");
  await writeFile(path.join(sourceDir, "README.md"), "fixture\n", "utf8");
  await git(sourceDir, "add", "README.md");
  await git(sourceDir, "commit", "-m", "initial");
  await execFileAsync("git", ["clone", "--bare", sourceDir, mirrorDir]);
  await git(
    mirrorDir,
    "remote",
    "set-url",
    "origin",
    "git@github.com:vercel/front.git",
  );
  await git(
    mirrorDir,
    "worktree",
    "add",
    "-b",
    "tomdale/fix-auth",
    checkoutDir,
    "main",
  );
  await mkdir(path.join(checkoutDir, "src"), { recursive: true });

  return { rootDir, defaultDir, mirrorDir, checkoutDir };
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workforest-managed-"));
  tempDirs.push(dir);
  return dir;
}

function git(
  cwd: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd });
}

function requireManagedContext(
  context: Awaited<ReturnType<typeof resolveManagedWorktreeContext>>,
): NonNullable<typeof context> {
  expect(context).not.toBeNull();
  if (!context) {
    throw new Error("Expected a managed worktree context.");
  }
  return context;
}
