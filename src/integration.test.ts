import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
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

  it("skips a dirty source worktree", async () => {
    const { repoDir, featureDir, featureSha } =
      await createQueuedCherryPickFixture();
    await writeFile(path.join(featureDir, "scratch.txt"), "local\n");

    const output = run(
      process.execPath,
      [queueScript, "sync-worktree", "tomdale/feature"],
      repoDir,
    );
    const result = JSON.parse(output) as { status: string; reason: string };

    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("uncommitted changes");
    expect(git(featureDir, ["rev-parse", "HEAD"])).toBe(featureSha);
  });
});
