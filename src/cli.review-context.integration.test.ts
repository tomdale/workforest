import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { saveWorkspaceConfig } from "./config.ts";
import {
  runSubprocess,
  type SubprocessResult,
} from "./test-utils/subprocess.ts";
import {
  readWorkspaceMetadata,
  upsertReviewWorktree,
  writeWorkspaceMetadata,
} from "./workspace/metadata.ts";

const execFileAsync = promisify(execFile);
const CLI_URL = pathToFileURL(path.resolve("src/cli.ts")).href;
const CLI_RUNNER = `
  process.argv = ["node", "wf", ...JSON.parse(process.env.WORKFOREST_TEST_ARGS)];
  const { cli } = await import(${JSON.stringify(CLI_URL)});
  await cli();
`;
const tempDirs: string[] = [];

type ReviewFixture = {
  rootDir: string;
  configDir: string;
  cacheDir: string;
  reviewsRoot: string;
  workspaceDir: string;
  repoDir: string;
  checkoutDir: string;
  binDir: string;
  realGit: string;
  shellPath: string;
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("review command directory contexts", () => {
  it.each([
    ["review workspace root", (fixture: ReviewFixture) => fixture.workspaceDir],
    ["review repository", (fixture: ReviewFixture) => fixture.repoDir],
    ["PR checkout", (fixture: ReviewFixture) => fixture.checkoutDir],
  ])(
    "infers a numeric checkout target from the %s",
    async (_label, cwdFor) => {
      const fixture = await createReviewFixture();
      const cwd = cwdFor(fixture);
      const prNumber = 456;

      const result = await runCli(fixture, cwd, [
        "review",
        "checkout",
        String(prNumber),
      ]);

      const targetDir = path.join(fixture.workspaceDir, `pr-${prNumber}`);
      expectSuccessfulReviewCheckout(result, targetDir);
      await expect(readFile(cdPath(fixture), "utf8")).resolves.toBe(
        `${targetDir}\n`,
      );
      expect(
        (await readWorkspaceMetadata(fixture.workspaceDir))?.review_worktrees,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pr_number: prNumber,
            path: `pr-${prNumber}`,
          }),
        ]),
      );
    },
    30_000,
  );

  it("does not infer a numeric checkout target from an unrelated directory", async () => {
    const fixture = await createReviewFixture();
    const unrelatedDir = path.join(fixture.rootDir, "unrelated");
    await mkdir(unrelatedDir);

    const result = await runCli(fixture, unrelatedDir, [
      "review",
      "checkout",
      "456",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Expected a GitHub PR URL or <owner>/<repo> <pr-number>.",
    );
    expectStackFree(result);
  });

  it("uses an explicit review target instead of the current review context", async () => {
    const fixture = await createReviewFixture();
    await createMirror(fixture, "tools", "acme");

    const result = await runCli(fixture, fixture.checkoutDir, [
      "review",
      "checkout",
      "acme/tools#789",
    ]);

    const targetDir = path.join(fixture.reviewsRoot, "tools", "pr-789");
    expectSuccessfulReviewCheckout(result, targetDir);
    const metadata = await readWorkspaceMetadata(
      path.join(fixture.reviewsRoot, "tools"),
    );
    expect(metadata?.workspace.review).toEqual({
      owner: "acme",
      repo: "tools",
    });
  }, 30_000);

  it.each([
    ["review workspace root", (fixture: ReviewFixture) => fixture.workspaceDir],
    ["review repository", (fixture: ReviewFixture) => fixture.repoDir],
    ["PR checkout", (fixture: ReviewFixture) => fixture.checkoutDir],
  ])(
    "does not infer destructive command operands from the %s",
    async (_label, cwdFor) => {
      const fixture = await createReviewFixture();
      const cwd = cwdFor(fixture);
      const cases = [
        [["delete"], 1, "Not in a Workforest worktree or workspace."],
        [["task", "delete"], 2, "Expected 1 or more task names"],
        [["cache", "delete"], 2, "Expected 1 or more repositories"],
      ] as const;

      for (const [args, exitCode, message] of cases) {
        const result = await runCli(fixture, cwd, args);

        expect(result.exitCode).toBe(exitCode);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(message);
        expectStackFree(result);
      }
    },
    30_000,
  );
});

async function createReviewFixture(): Promise<ReviewFixture> {
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), "workforest-review-context-"),
  );
  tempDirs.push(rootDir);

  const configDir = path.join(rootDir, "config");
  const cacheDir = path.join(rootDir, "cache");
  const reviewsRoot = path.join(rootDir, "reviews");
  const workspaceDir = path.join(reviewsRoot, "omniagent");
  const repoDir = path.join(workspaceDir, "omniagent");
  const checkoutDir = path.join(workspaceDir, "pr-123");
  const binDir = path.join(rootDir, "bin");
  const shellPath = path.join(rootDir, "test-shell");
  const { stdout: gitPath } = await execFileAsync("which", ["git"]);
  const realGit = gitPath.trim();

  await Promise.all([
    mkdir(configDir, { recursive: true }),
    mkdir(cacheDir, { recursive: true }),
    mkdir(reviewsRoot, { recursive: true }),
    mkdir(binDir, { recursive: true }),
  ]);
  await saveWorkspaceConfig(path.join(configDir, "config.json"), {
    directory: { reviews: reviewsRoot },
  });

  const fixture = {
    rootDir,
    configDir,
    cacheDir,
    reviewsRoot,
    workspaceDir,
    repoDir,
    checkoutDir,
    binDir,
    realGit,
    shellPath,
  };
  const mirrorDir = await createMirror(fixture, "omniagent", "vercel");

  await mkdir(workspaceDir, { recursive: true });
  await runGit(
    ["worktree", "add", "--detach", repoDir, "refs/remotes/origin/main"],
    mirrorDir,
  );
  await runGit(
    [
      "worktree",
      "add",
      "-b",
      "pull/123",
      checkoutDir,
      "refs/remotes/origin/main",
    ],
    mirrorDir,
  );
  await writeWorkspaceMetadata(workspaceDir, {
    featureName: "omniagent",
    type: "review",
    review: { owner: "vercel", repo: "omniagent" },
    repos: [
      {
        name: "omniagent",
        remote: "git@github.com:vercel/omniagent.git",
        hasLockfile: false,
      },
    ],
  });
  await upsertReviewWorktree(workspaceDir, {
    pr_number: 123,
    path: "pr-123",
    branch: "pull/123",
    created_at: "2026-06-11T00:00:00.000Z",
  });
  await installCommandShims(fixture);

  return fixture;
}

async function createMirror(
  fixture: ReviewFixture,
  repo: string,
  owner: string,
): Promise<string> {
  const seedDir = path.join(fixture.rootDir, `seed-${repo}`);
  const mirrorDir = path.join(fixture.cacheDir, `${repo}.git`);
  await mkdir(seedDir);
  await runGit(["init", "-q", "-b", "main"], seedDir);
  await runGit(["config", "user.email", "test@example.com"], seedDir);
  await runGit(["config", "user.name", "Workforest Test"], seedDir);
  await runGit(["config", "commit.gpgsign", "false"], seedDir);
  await writeFile(path.join(seedDir, "README.md"), `${repo}\n`, "utf8");
  await runGit(["add", "README.md"], seedDir);
  await runGit(["commit", "-q", "-m", "Initial commit"], seedDir);
  await execFileAsync(fixture.realGit, [
    "clone",
    "--bare",
    "-q",
    seedDir,
    mirrorDir,
  ]);
  await runGit(
    ["remote", "set-url", "origin", `git@github.com:${owner}/${repo}.git`],
    mirrorDir,
  );
  const { stdout: mainSha } = await execFileAsync(
    fixture.realGit,
    ["rev-parse", "refs/heads/main"],
    { cwd: mirrorDir },
  );
  await runGit(
    ["update-ref", "refs/remotes/origin/main", mainSha.trim()],
    mirrorDir,
  );
  return mirrorDir;
}

async function installCommandShims(fixture: ReviewFixture): Promise<void> {
  const gitShim = path.join(fixture.binDir, "git");
  const ghShim = path.join(fixture.binDir, "gh");
  const realGit = shellQuote(fixture.realGit);
  await writeFile(
    gitShim,
    `#!/bin/sh
if [ "$1" = "fetch" ]; then
  exit 0
fi
exec ${realGit} "$@"
`,
    "utf8",
  );
  await writeFile(
    ghShim,
    `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "checkout" ] && [ -n "$3" ]; then
  exec ${realGit} checkout -q -b "pull/$3"
fi
exit 64
`,
    "utf8",
  );
  await writeFile(
    fixture.shellPath,
    `#!/bin/sh
PATH=${shellQuote(`${fixture.binDir}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}
export PATH
exec /usr/bin/env -0
`,
    "utf8",
  );
  await Promise.all([
    chmod(gitShim, 0o755),
    chmod(ghShim, 0o755),
    chmod(fixture.shellPath, 0o755),
  ]);
}

async function runGit(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd, timeout: 10_000 });
}

function runCli(
  fixture: ReviewFixture,
  cwd: string,
  args: readonly string[],
): Promise<SubprocessResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: "1",
    NO_COLOR: "1",
    PATH: `${fixture.binDir}${path.delimiter}${process.env["PATH"] ?? ""}`,
    SHELL: fixture.shellPath,
    WORKFOREST_CACHE_DIR: fixture.cacheDir,
    WORKFOREST_CD_PATH_FILE: cdPath(fixture),
    WORKFOREST_CONFIG_DIR: fixture.configDir,
    WORKFOREST_NO_TUI: "1",
    WORKFOREST_TEST_ARGS: JSON.stringify(args),
  };

  return runSubprocess(
    process.execPath,
    ["--input-type=module", "--eval", CLI_RUNNER],
    { cwd, env, timeout: 20_000 },
  );
}

function cdPath(fixture: ReviewFixture): string {
  return path.join(fixture.rootDir, "cd-path");
}

function expectSuccessfulReviewCheckout(
  result: SubprocessResult,
  targetDir: string,
): void {
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(`Review worktree ready: ${targetDir}`);
  expect(result.stderr).toBe("");
  expectStackFree(result);
}

function expectStackFree(result: SubprocessResult): void {
  expect(`${result.stdout}\n${result.stderr}`).not.toContain("\n    at ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
