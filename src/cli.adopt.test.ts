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
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI_MODULE_URL = pathToFileURL(path.resolve("src/cli.ts")).href;
const CLI_SCRIPT = [
  `const { cli } = await import(${JSON.stringify(CLI_MODULE_URL)});`,
  'process.argv = ["node", "wf", ...JSON.parse(process.env.WORKFOREST_TEST_ARGV ?? "[]")];',
  "await cli();",
].join("\n");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("wf adopt", () => {
  it("adopts a clean checkout into a linked worktree and seeds the cache from local refs", async () => {
    const fixture = await createAdoptFixture();
    const result = await runCli(fixture, [
      "adopt",
      fixture.checkoutDir,
      "--json",
    ]);

    const json = expectJsonOk(result);
    expect(json).toEqual({
      ok: true,
      data: {
        selector: "project/adopt-me",
        repository: "project",
        changeName: "adopt-me",
        sourcePath: fixture.checkoutRealPath,
        targetPath: path.join(
          fixture.workforestBase,
          "Repos",
          "project",
          "adopt-me",
        ),
        remote: fixture.originDir,
        branch: "tomdale/adopt-me",
        mirrorPath: path.join(fixture.cacheDir, "project.git"),
      },
    });

    const data = json.data as {
      targetPath: string;
      mirrorPath: string;
    };
    await expectGit(data.targetPath, ["status", "--porcelain"], "");
    await expectGit(
      data.targetPath,
      ["branch", "--show-current"],
      "tomdale/adopt-me\n",
    );
    await expectGit(
      data.targetPath,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      `${await realpath(data.mirrorPath)}\n`,
    );
    await expectGit(
      data.mirrorPath,
      ["rev-parse", "--verify", "refs/heads/side"],
      `${fixture.sideSha}\n`,
    );
    await expectGit(
      data.mirrorPath,
      ["rev-parse", "--verify", "refs/tags/v1"],
      `${fixture.mainSha}\n`,
    );
    await expectGit(data.mirrorPath, ["rev-parse", "--verify", "refs/stash"]);
    await expectGit(
      data.mirrorPath,
      ["symbolic-ref", "HEAD"],
      "refs/heads/main\n",
    );

    await expect(
      readFile(path.join(data.targetPath, "ignored.log"), "utf8"),
    ).resolves.toBe("preserved\n");
    await expect(
      rm(fixture.checkoutDir, { recursive: false }),
    ).rejects.toThrow();

    const metadata = JSON.parse(
      await readFile(
        path.join(
          fixture.workforestBase,
          "Repos",
          "project",
          ".workforest",
          "changes",
          "adopt-me.json",
        ),
        "utf8",
      ),
    );
    expect(metadata).toMatchObject({
      workspace: { feature_name: "adopt-me" },
      repos: [
        {
          name: "project",
          remote: fixture.originDir,
          feature_branch: "tomdale/adopt-me",
        },
      ],
    });

    const list = expectJsonOk(await runCli(fixture, ["list", "--json"]));
    expect(list.data).toEqual(
      expect.objectContaining({
        repositories: [
          expect.objectContaining({
            type: "worktree",
            selector: "project/adopt-me",
            path: data.targetPath,
          }),
        ],
      }),
    );

    const status = expectJsonOk(
      await runCli(fixture, ["status", "--json"], { cwd: data.targetPath }),
    );
    expect(status.data).toEqual(
      expect.objectContaining({
        type: "worktree",
        selector: "project/adopt-me",
        summary: expect.objectContaining({ repository: "project" }),
      }),
    );

    const task = await runCli(
      fixture,
      ["task", "new", "follow-up", "--dry-run", "--json"],
      {
        cwd: data.targetPath,
      },
    );
    expectJson(task, 0);
  }, 60_000);

  it("uses --name and imports into a non-conflicting existing cache", async () => {
    const fixture = await createAdoptFixture();
    const mirrorPath = path.join(fixture.cacheDir, "project.git");
    await mkdir(mirrorPath, { recursive: true });
    await git(mirrorPath, ["init", "--bare", "--quiet"]);
    await git(mirrorPath, ["remote", "add", "origin", fixture.originDir]);

    const result = await runCli(fixture, [
      "adopt",
      fixture.checkoutDir,
      "--name",
      "custom-name",
      "--json",
    ]);

    const json = expectJsonOk(result);
    expect(json).toEqual({
      ok: true,
      data: expect.objectContaining({
        selector: "project/custom-name",
        changeName: "custom-name",
        mirrorPath,
      }),
    });
    await expectGit(mirrorPath, ["rev-parse", "--verify", "refs/heads/side"]);
  }, 60_000);

  it("defaults to the last branch path segment even without a configured branch prefix", async () => {
    const fixture = await createAdoptFixture({ branchPrefix: false });

    const result = await runCli(fixture, [
      "adopt",
      fixture.checkoutDir,
      "--json",
    ]);

    expect(expectJsonOk(result)).toEqual({
      ok: true,
      data: expect.objectContaining({
        selector: "project/adopt-me",
        changeName: "adopt-me",
        branch: "tomdale/adopt-me",
      }),
    });
  }, 60_000);

  it("refuses to overwrite an existing cached branch at another commit", async () => {
    const fixture = await createAdoptFixture();
    const mirrorPath = path.join(fixture.cacheDir, "project.git");
    await mkdir(mirrorPath, { recursive: true });
    await git(mirrorPath, ["init", "--bare", "--quiet"]);
    await git(mirrorPath, ["remote", "add", "origin", fixture.originDir]);
    await git(mirrorPath, [
      "fetch",
      "--quiet",
      fixture.checkoutDir,
      `main:refs/heads/tomdale/adopt-me`,
    ]);

    const result = await runCli(fixture, [
      "adopt",
      fixture.checkoutDir,
      "--json",
    ]);

    expectJson(result, 1, {
      ok: false,
      error: {
        kind: "operational",
        message: expect.stringContaining(
          "Cached branch tomdale/adopt-me already points at a different commit",
        ),
      },
    });
  }, 60_000);

  it("refuses missing origin, detached HEAD, dirty, destination collision, and managed checkouts", async () => {
    const missingOrigin = await createAdoptFixture({ origin: false });
    expectJson(
      await runCli(missingOrigin, [
        "adopt",
        missingOrigin.checkoutDir,
        "--json",
      ]),
      1,
      {
        ok: false,
        error: {
          kind: "operational",
          message: expect.stringContaining("Checkout has no origin remote"),
        },
      },
    );

    const detached = await createAdoptFixture();
    await git(detached.checkoutDir, ["checkout", "--quiet", detached.mainSha]);
    expectJson(
      await runCli(detached, ["adopt", detached.checkoutDir, "--json"]),
      1,
      {
        ok: false,
        error: {
          kind: "operational",
          message: expect.stringContaining("Checkout is in detached HEAD"),
        },
      },
    );

    const dirty = await createAdoptFixture();
    await writeFile(path.join(dirty.checkoutDir, "dirty.txt"), "dirty\n");
    expectJson(await runCli(dirty, ["adopt", dirty.checkoutDir, "--json"]), 1, {
      ok: false,
      error: {
        kind: "operational",
        message: expect.stringContaining(
          "Checkout has tracked or untracked changes",
        ),
      },
    });

    const collision = await createAdoptFixture();
    await mkdir(
      path.join(collision.workforestBase, "Repos", "project", "adopt-me"),
      { recursive: true },
    );
    expectJson(
      await runCli(collision, ["adopt", collision.checkoutDir, "--json"]),
      1,
      {
        ok: false,
        error: {
          kind: "operational",
          message: expect.stringContaining("Destination already exists"),
        },
      },
    );

    const managed = await createAdoptFixture();
    const managedPath = path.join(
      managed.workforestBase,
      "Repos",
      "project",
      "existing",
    );
    await mkdir(path.dirname(managedPath), { recursive: true });
    await git(os.tmpdir(), [
      "clone",
      "--quiet",
      managed.originDir,
      managedPath,
    ]);
    await git(managedPath, ["checkout", "--quiet", "-b", "tomdale/adopt-me"]);
    expectJson(await runCli(managed, ["adopt", managedPath, "--json"]), 1, {
      ok: false,
      error: {
        kind: "operational",
        message: expect.stringContaining(
          "already inside Workforest-managed directories",
        ),
      },
    });
  }, 60_000);
});

async function createAdoptFixture(
  options: {
    origin?: boolean;
    checkoutParent?: string;
    branchPrefix?: string | false;
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workforest-adopt-"));
  tempDirs.push(root);
  const checkoutParent = options.checkoutParent ?? root;
  const checkoutDir = path.join(checkoutParent, "project");
  const originDir = path.join(root, "project.git");
  const configDir = path.join(root, "config");
  const cacheDir = path.join(root, "cache");
  const workforestBase = path.join(root, "wf");

  await mkdir(checkoutParent, { recursive: true });
  await mkdir(originDir, { recursive: true });
  await git(originDir, ["init", "--bare", "--quiet"]);
  await git(originDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(root, ["init", "--quiet", "--initial-branch=main", checkoutDir]);
  await git(checkoutDir, ["config", "user.name", "Workforest Test"]);
  await git(checkoutDir, ["config", "user.email", "test@example.com"]);
  await git(checkoutDir, ["config", "tag.gpgSign", "false"]);
  await writeFile(path.join(checkoutDir, ".gitignore"), "*.log\n");
  await writeFile(path.join(checkoutDir, "README.md"), "# Project\n");
  await git(checkoutDir, ["add", "."]);
  await git(checkoutDir, ["commit", "--quiet", "-m", "initial"]);
  const mainSha = (await git(checkoutDir, ["rev-parse", "HEAD"])).trim();

  if (options.origin !== false) {
    await git(checkoutDir, ["remote", "add", "origin", originDir]);
    await git(checkoutDir, ["push", "--quiet", "-u", "origin", "main"]);
    await git(checkoutDir, ["remote", "set-head", "origin", "main"]);
  }

  await git(checkoutDir, ["tag", "v1"]);
  await git(checkoutDir, ["checkout", "--quiet", "-b", "side"]);
  await writeFile(path.join(checkoutDir, "side.txt"), "side\n");
  await git(checkoutDir, ["add", "."]);
  await git(checkoutDir, ["commit", "--quiet", "-m", "side"]);
  const sideSha = (await git(checkoutDir, ["rev-parse", "HEAD"])).trim();
  await git(checkoutDir, [
    "checkout",
    "--quiet",
    "-b",
    "tomdale/adopt-me",
    "main",
  ]);
  await writeFile(path.join(checkoutDir, "feature.txt"), "feature\n");
  await git(checkoutDir, ["add", "."]);
  await git(checkoutDir, ["commit", "--quiet", "-m", "feature"]);
  await writeFile(path.join(checkoutDir, "ignored.log"), "preserved\n");
  await writeFile(path.join(checkoutDir, "stashed.txt"), "stash\n");
  await git(checkoutDir, [
    "stash",
    "push",
    "--quiet",
    "--include-untracked",
    "-m",
    "keep stash",
  ]);

  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify(
      {
        directory: { base: workforestBase },
        ...(options.branchPrefix === false
          ? {}
          : { branchPrefix: options.branchPrefix ?? "tomdale/" }),
      },
      null,
      2,
    ),
  );

  return {
    root,
    checkoutDir,
    checkoutRealPath: await realpath(checkoutDir),
    originDir,
    configDir,
    cacheDir,
    workforestBase,
    mainSha,
    sideSha,
  };
}

async function runCli(
  fixture: {
    configDir: string;
    cacheDir: string;
    root: string;
  },
  argv: readonly string[],
  options: { cwd?: string } = {},
) {
  const commandOptions = {
    cwd: options.cwd ?? fixture.root,
    env: {
      ...process.env,
      NO_COLOR: "1",
      WORKFOREST_CACHE_DIR: fixture.cacheDir,
      WORKFOREST_CONFIG_DIR: fixture.configDir,
      WORKFOREST_TEST_ARGV: JSON.stringify(argv),
    },
    timeout: 20_000,
  };
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", CLI_SCRIPT],
      commandOptions,
    );
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failed = error as {
      code?: number | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      exitCode: failed.code ?? 1,
      stdout: String(failed.stdout ?? ""),
      stderr: String(failed.stderr ?? ""),
    };
  }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd,
      timeout: 5_000,
    });
    return stdout;
  } catch (error) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function expectGit(
  cwd: string,
  args: readonly string[],
  stdout?: string,
) {
  const actual = await git(cwd, args);
  if (stdout !== undefined) {
    expect(actual).toBe(stdout);
  }
  return actual;
}

type JsonEnvelope =
  | { ok: true; data: unknown }
  | {
      ok: false;
      error: { kind: "usage" | "operational"; message: string };
    };

function expectJson(
  result: Awaited<ReturnType<typeof runCli>>,
  exitCode: 0 | 1 | 2,
  expected?: unknown,
): JsonEnvelope {
  expect(
    result.exitCode,
    `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(exitCode);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(stripAnsi(result.stdout));
  expect(result.stdout.endsWith("\n")).toBe(true);

  const parsed = JSON.parse(result.stdout) as JsonEnvelope;
  if (expected !== undefined) {
    expect(parsed).toEqual(expected);
  }
  return parsed;
}

function expectJsonOk(
  result: Awaited<ReturnType<typeof runCli>>,
): Extract<JsonEnvelope, { ok: true }> {
  const parsed = expectJson(result, 0);
  expect(parsed.ok).toBe(true);
  return parsed as Extract<JsonEnvelope, { ok: true }>;
}
