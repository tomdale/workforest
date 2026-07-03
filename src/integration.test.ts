import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const queueScript = path.resolve(".agents/plugins/wf/scripts/integration.mjs");

function run(
  command: string,
  args: string[],
  cwd: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function git(cwd: string, args: string[]): string {
  return run("git", args, cwd);
}

async function createRepositoryFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "workforest-queue-"));
  const repoDir = path.join(root, "repo");

  run("git", ["init", "-b", "main", repoDir], root);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test User"]);
  git(repoDir, ["config", "commit.gpgsign", "false"]);

  await writeFile(path.join(repoDir, "README.md"), "base\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-m", "base"]);

  return { root, repoDir };
}

async function createQueuedCherryPickFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "workforest-queue-"));
  const repoDir = path.join(root, "repo");
  const featureDir = path.join(root, "feature");

  run("git", ["init", "-b", "main", repoDir], root);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test User"]);
  git(repoDir, ["config", "commit.gpgsign", "false"]);

  await writeFile(path.join(repoDir, "README.md"), "base\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-m", "base"]);
  git(repoDir, ["branch", "tomdale/feature"]);
  git(repoDir, ["worktree", "add", featureDir, "tomdale/feature"]);

  await writeFile(path.join(featureDir, "feature.txt"), "feature\n");
  git(featureDir, ["add", "feature.txt"]);
  git(featureDir, ["commit", "-m", "feature"]);
  const featureSha = git(featureDir, ["rev-parse", "HEAD"]);

  await writeFile(path.join(repoDir, "main.txt"), "main\n");
  git(repoDir, ["add", "main.txt"]);
  git(repoDir, ["commit", "-m", "main"]);
  git(repoDir, ["cherry-pick", featureSha]);
  const integratedSha = git(repoDir, ["rev-parse", "HEAD"]);

  const queueRef =
    "refs/workforest/integration-ready/20260627T170000000Z/tomdale/feature";
  git(repoDir, ["update-ref", queueRef, featureSha]);

  return { repoDir, featureDir, featureSha, integratedSha, queueRef };
}

async function createQueuedMultiCommitCherryPickFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "workforest-queue-"));
  const repoDir = path.join(root, "repo");
  const featureDir = path.join(root, "feature");

  run("git", ["init", "-b", "main", repoDir], root);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test User"]);
  git(repoDir, ["config", "commit.gpgsign", "false"]);

  await writeFile(path.join(repoDir, "README.md"), "base\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-m", "base"]);
  git(repoDir, ["branch", "tomdale/feature"]);
  git(repoDir, ["worktree", "add", featureDir, "tomdale/feature"]);

  await writeFile(path.join(featureDir, "feature-a.txt"), "feature a\n");
  git(featureDir, ["add", "feature-a.txt"]);
  git(featureDir, ["commit", "-m", "feature a"]);
  const firstFeatureSha = git(featureDir, ["rev-parse", "HEAD"]);

  await writeFile(path.join(featureDir, "feature-b.txt"), "feature b\n");
  git(featureDir, ["add", "feature-b.txt"]);
  git(featureDir, ["commit", "-m", "feature b"]);
  const featureSha = git(featureDir, ["rev-parse", "HEAD"]);

  await writeFile(path.join(repoDir, "main.txt"), "main\n");
  git(repoDir, ["add", "main.txt"]);
  git(repoDir, ["commit", "-m", "main"]);
  git(repoDir, ["cherry-pick", firstFeatureSha, featureSha]);
  const integratedSha = git(repoDir, ["rev-parse", "HEAD"]);

  const queueRef =
    "refs/workforest/integration-ready/20260627T170000000Z/tomdale/feature";
  git(repoDir, ["update-ref", queueRef, featureSha]);

  return { repoDir, featureDir, featureSha, integratedSha };
}

async function createQueuedManualIntegrationFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "workforest-queue-"));
  const repoDir = path.join(root, "repo");
  const featureDir = path.join(root, "feature");

  run("git", ["init", "-b", "main", repoDir], root);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test User"]);
  git(repoDir, ["config", "commit.gpgsign", "false"]);

  await writeFile(path.join(repoDir, "README.md"), "base\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-m", "base"]);
  git(repoDir, ["branch", "tomdale/feature"]);
  git(repoDir, ["worktree", "add", featureDir, "tomdale/feature"]);

  await writeFile(path.join(featureDir, "feature.txt"), "feature\n");
  git(featureDir, ["add", "feature.txt"]);
  git(featureDir, ["commit", "-m", "feature"]);
  const featureSha = git(featureDir, ["rev-parse", "HEAD"]);

  await writeFile(path.join(repoDir, "feature.txt"), "feature\nmanual fix\n");
  git(repoDir, ["add", "feature.txt"]);
  git(repoDir, ["commit", "-m", "manual integration"]);
  const integratedSha = git(repoDir, ["rev-parse", "HEAD"]);

  const queueRef =
    "refs/workforest/integration-ready/20260627T170000000Z/tomdale/feature";
  git(repoDir, ["update-ref", queueRef, featureSha]);

  return { repoDir, featureDir, featureSha, integratedSha };
}

describe("integration queue worktree sync", () => {
  it("moves a clean source worktree to the patch-equivalent main commit", async () => {
    const { repoDir, featureDir, integratedSha } =
      await createQueuedCherryPickFixture();

    const output = run(
      process.execPath,
      [queueScript, "sync-worktree", "tomdale/feature"],
      repoDir,
    );
    const result = JSON.parse(output) as {
      status: string;
      target: string;
      worktree: string;
    };

    expect(result).toMatchObject({
      status: "updated",
      target: integratedSha,
      worktree: await realpath(featureDir),
    });
    expect(git(featureDir, ["rev-parse", "HEAD"])).toBe(integratedSha);
    expect(() =>
      git(featureDir, ["merge-base", "--is-ancestor", "HEAD", "main"]),
    ).not.toThrow();
  });

  it("moves a clean source worktree after all queued commits were cherry-picked", async () => {
    const { repoDir, featureDir, integratedSha } =
      await createQueuedMultiCommitCherryPickFixture();

    const output = run(
      process.execPath,
      [queueScript, "sync-worktree", "tomdale/feature"],
      repoDir,
    );
    const result = JSON.parse(output) as {
      status: string;
      target: string;
      worktree: string;
    };

    expect(result).toMatchObject({
      status: "updated",
      target: integratedSha,
      worktree: await realpath(featureDir),
    });
    expect(git(featureDir, ["rev-parse", "HEAD"])).toBe(integratedSha);
  });

  it("moves a clean source worktree to an explicit manual integration target", async () => {
    const { repoDir, featureDir, integratedSha } =
      await createQueuedManualIntegrationFixture();

    const output = run(
      process.execPath,
      [
        queueScript,
        "sync-worktree",
        "tomdale/feature",
        "--target",
        integratedSha,
      ],
      repoDir,
    );
    const result = JSON.parse(output) as {
      status: string;
      target: string;
      worktree: string;
    };

    expect(result).toMatchObject({
      status: "updated",
      target: integratedSha,
      worktree: await realpath(featureDir),
    });
    expect(await readFile(path.join(featureDir, "feature.txt"), "utf8")).toBe(
      "feature\nmanual fix\n",
    );
  });

  it("skips a dirty source worktree even with an explicit target", async () => {
    const { repoDir, featureDir, featureSha, integratedSha } =
      await createQueuedCherryPickFixture();
    await writeFile(path.join(featureDir, "scratch.txt"), "local\n");

    const output = run(
      process.execPath,
      [
        queueScript,
        "sync-worktree",
        "tomdale/feature",
        "--target",
        integratedSha,
      ],
      repoDir,
    );
    const result = JSON.parse(output) as { status: string; reason: string };

    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("uncommitted changes");
    expect(git(featureDir, ["rev-parse", "HEAD"])).toBe(featureSha);
  });

  it("skips a source branch that moved after it was queued even with an explicit target", async () => {
    const { repoDir, featureDir, featureSha, integratedSha } =
      await createQueuedCherryPickFixture();
    await writeFile(path.join(featureDir, "later.txt"), "later\n");
    git(featureDir, ["add", "later.txt"]);
    git(featureDir, ["commit", "-m", "later"]);
    const laterSha = git(featureDir, ["rev-parse", "HEAD"]);

    const output = run(
      process.execPath,
      [
        queueScript,
        "sync-worktree",
        "tomdale/feature",
        "--target",
        integratedSha,
      ],
      repoDir,
    );
    const result = JSON.parse(output) as { status: string; reason: string };

    expect(result.status).toBe("skipped");
    expect(result.reason).toContain(`moved from queued SHA ${featureSha}`);
    expect(git(featureDir, ["rev-parse", "HEAD"])).toBe(laterSha);
  });
});

describe("integration lock", () => {
  it("acquires and releases the main integration lock by token", async () => {
    const { repoDir } = await createRepositoryFixture();
    const gitCommonDir = git(repoDir, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const lockPath = path.join(gitCommonDir, "workforest-main.lock");

    const acquiredOutput = run(
      process.execPath,
      [queueScript, "acquire-lock"],
      repoDir,
    );
    const acquired = JSON.parse(acquiredOutput) as {
      path: string;
      token: string;
    };
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
      token: string;
    };

    expect(acquired.path).toBe(lockPath);
    expect(lock.token).toBe(acquired.token);

    const releasedOutput = run(
      process.execPath,
      [queueScript, "release-lock", "--token", acquired.token],
      repoDir,
    );
    const released = JSON.parse(releasedOutput) as {
      released: boolean;
      token: string;
    };

    expect(released).toMatchObject({ released: true, token: acquired.token });
    await expect(readFile(lockPath, "utf8")).rejects.toThrow();
  });

  it("refuses to release a lock held by a different token", async () => {
    const { repoDir } = await createRepositoryFixture();
    const acquired = JSON.parse(
      run(process.execPath, [queueScript, "acquire-lock"], repoDir),
    ) as { token: string };

    try {
      const released = spawnSync(
        process.execPath,
        [queueScript, "release-lock", "--token", "wrong-token"],
        {
          cwd: repoDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      expect(released.status).toBe(1);
      expect(released.stderr).toContain("held by a different token");
    } finally {
      run(
        process.execPath,
        [queueScript, "release-lock", "--token", acquired.token],
        repoDir,
      );
    }
  });

  it("prevents a second integration from taking the lock unless forced", async () => {
    const { repoDir } = await createRepositoryFixture();
    const first = JSON.parse(
      run(process.execPath, [queueScript, "acquire-lock"], repoDir),
    ) as { token: string };
    const blocked = spawnSync(process.execPath, [queueScript, "acquire-lock"], {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("Integration lock already exists");

    const forced = JSON.parse(
      run(process.execPath, [queueScript, "acquire-lock", "--force"], repoDir),
    ) as { token: string };

    expect(forced.token).not.toBe(first.token);

    run(
      process.execPath,
      [queueScript, "release-lock", "--token", forced.token],
      repoDir,
    );
  });

  it("removes the main integration lock after a wrapped command exits", async () => {
    const { repoDir } = await createRepositoryFixture();
    const gitCommonDir = git(repoDir, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const lockPath = path.join(gitCommonDir, "workforest-main.lock");

    run(
      process.execPath,
      [queueScript, "with-lock", "--", process.execPath, "-e", ""],
      repoDir,
    );

    await expect(readFile(lockPath, "utf8")).rejects.toThrow();
  });
});
