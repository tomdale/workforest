import { execFile, execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const queueScript = path.resolve(".agents/plugins/wf/scripts/integration.mjs");
const reaperScript = path.resolve(
  ".agents/plugins/wf/scripts/integration-reaper.mjs",
);
const execFileAsync = promisify(execFile);

function run(
  command: string,
  args: string[],
  cwd: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HERDR_ENV: "0", ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function git(cwd: string, args: string[]): string {
  return run("git", args, cwd);
}

async function createFakeTmux(root: string) {
  const binDir = path.join(root, "bin");
  const tmuxPath = path.join(binDir, "tmux");
  const piPath = path.join(binDir, "pi");
  const statePath = path.join(root, "tmux-session");
  const logPath = path.join(root, "tmux.log");
  run("mkdir", ["-p", binDir], root);
  await writeFile(
    tmuxPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "-V") process.exit(0);
if (args[0] === "has-session") process.exit(fs.existsSync(${JSON.stringify(statePath)}) ? 0 : 1);
if (args[0] === "new-session") {
  try { fs.writeFileSync(${JSON.stringify(statePath)}, "running\\n", { flag: "wx" }); process.exit(0); }
  catch (error) { if (error.code === "EEXIST") process.exit(1); throw error; }
}
if (args[0] === "rename-session") { fs.rmSync(${JSON.stringify(statePath)}, { force: true }); process.exit(0); }
process.exit(2);
`,
  );
  await writeFile(piPath, "#!/bin/sh\nexit 0\n");
  await chmod(tmuxPath, 0o755);
  await chmod(piPath, 0o755);
  return {
    env: { PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
    logPath,
    statePath,
  };
}

async function createFakeHerdr(root: string) {
  const binDir = path.join(root, "herdr-bin");
  const herdrPath = path.join(binDir, "herdr");
  const statePath = path.join(root, "herdr-agent");
  const logPath = path.join(root, "herdr.log");
  run("mkdir", ["-p", binDir], root);
  await writeFile(
    herdrPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "agent" && args[1] === "get") process.exit(fs.existsSync(${JSON.stringify(statePath)}) ? 0 : 1);
if (args[0] === "tab" && args[1] === "create") {
  console.log(JSON.stringify({ result: { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } } }));
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "start") { fs.writeFileSync(${JSON.stringify(statePath)}, "running\\n"); process.exit(0); }
if (args[0] === "agent" && args[1] === "prompt") process.exit(0);
if (args[0] === "tab" && args[1] === "close") process.exit(0);
process.exit(2);
`,
  );
  await chmod(herdrPath, 0o755);
  return {
    env: {
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: path.join(root, "herdr.sock"),
      HERDR_WORKSPACE_ID: "w1",
      PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
    },
    logPath,
  };
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

describe("integration session", () => {
  it("starts and prompts an interactive Pi agent in a new Herdr tab", async () => {
    const { root, repoDir } = await createRepositoryFixture();
    const fakeHerdr = await createFakeHerdr(root);
    const fakeTmux = await createFakeTmux(root);
    run(process.execPath, [queueScript, "start-pi"], repoDir, {
      env: fakeTmux.env,
    });
    const herdrEnv = {
      ...fakeHerdr.env,
      PATH: `${fakeHerdr.env.PATH.split(":")[0]}:${fakeTmux.env.PATH}`,
    };

    const started = JSON.parse(
      run(process.execPath, [queueScript, "start-pi"], repoDir, {
        env: herdrEnv,
      }),
    ) as { status: string; mode: string; tab: string; worktree: string };
    const reused = JSON.parse(
      run(process.execPath, [queueScript, "start-pi"], repoDir, {
        env: herdrEnv,
      }),
    ) as { status: string; mode: string };

    expect(started).toMatchObject({
      status: "started",
      mode: "herdr",
      tab: "w1:t2",
      worktree: await realpath(repoDir),
    });
    expect(reused).toMatchObject({
      status: "already-running",
      mode: "herdr",
    });

    const calls = (await readFile(fakeHerdr.logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls).toContainEqual([
      "tab",
      "create",
      "--workspace",
      "w1",
      "--cwd",
      await realpath(repoDir),
      "--label",
      "Integration",
      "--no-focus",
    ]);
    const start = calls.find(
      (args) => args[0] === "agent" && args[1] === "start",
    );
    expect(start).toEqual(
      expect.arrayContaining([
        "workforest-integration",
        "--kind",
        "pi",
        "--pane",
        "w1:p2",
        "--",
        "--name",
        "Workforest integration",
        "--approve",
      ]),
    );
    expect(start).not.toContain("--print");
    expect(
      calls.filter((args) => args[0] === "agent" && args[1] === "prompt"),
    ).toHaveLength(2);
  });

  it("starts one pi session in the main worktree and reuses it", async () => {
    const { root, repoDir } = await createRepositoryFixture();
    const fakeTmux = await createFakeTmux(root);

    const started = JSON.parse(
      run(process.execPath, [queueScript, "start-pi"], repoDir, {
        env: fakeTmux.env,
      }),
    ) as { status: string; session: string; worktree: string; attach: string };
    const reused = JSON.parse(
      run(process.execPath, [queueScript, "start-pi"], repoDir, {
        env: fakeTmux.env,
      }),
    ) as { status: string; session: string; worktree: string };

    const canonicalRepoDir = await realpath(repoDir);
    expect(started).toMatchObject({
      status: "started",
      session: "workforest-integration",
      worktree: canonicalRepoDir,
      attach: "tmux attach -t workforest-integration",
    });
    expect(reused).toMatchObject({
      status: "already-running",
      session: "workforest-integration",
      worktree: canonicalRepoDir,
    });
    const calls = (await readFile(fakeTmux.logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const launch = calls.find((args) => args[0] === "new-session");
    expect(launch).toEqual(
      expect.arrayContaining([
        "-s",
        "workforest-integration",
        "-c",
        canonicalRepoDir,
      ]),
    );
  });

  it("serializes concurrent starts through tmux session creation", async () => {
    const { root, repoDir } = await createRepositoryFixture();
    const fakeTmux = await createFakeTmux(root);
    const options = {
      cwd: repoDir,
      encoding: "utf8" as const,
      env: { ...process.env, HERDR_ENV: "0", ...fakeTmux.env },
    };

    const results = await Promise.all([
      execFileAsync(process.execPath, [queueScript, "start-pi"], options),
      execFileAsync(process.execPath, [queueScript, "start-pi"], options),
    ]);
    const statuses = results
      .map(({ stdout }) => (JSON.parse(stdout) as { status: string }).status)
      .sort();

    expect(statuses).toEqual(["already-running", "started"]);
  });

  it("does not retry unchanged work after a failed integration turn", async () => {
    const { root, repoDir } = await createRepositoryFixture();
    const fakeTmux = await createFakeTmux(root);
    const head = git(repoDir, ["rev-parse", "HEAD"]);
    git(repoDir, [
      "update-ref",
      "refs/workforest/integration-ready/20260820T120000000Z/tomdale/feature",
      head,
    ]);
    const baseline = run(
      process.execPath,
      [queueScript, "list", "--json"],
      repoDir,
    );

    run(process.execPath, [reaperScript, baseline], repoDir, {
      env: fakeTmux.env,
    });

    const calls = (await readFile(fakeTmux.logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.some((args) => args[0] === "new-session")).toBe(false);
  });

  it("restarts integration when queued work remains after session exit", async () => {
    const { root, repoDir } = await createRepositoryFixture();
    const fakeTmux = await createFakeTmux(root);
    const head = git(repoDir, ["rev-parse", "HEAD"]);
    git(repoDir, [
      "update-ref",
      "refs/workforest/integration-ready/20260820T120000000Z/tomdale/feature",
      head,
    ]);

    run(process.execPath, [reaperScript], repoDir, { env: fakeTmux.env });

    const calls = (await readFile(fakeTmux.logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.some((args) => args[0] === "new-session")).toBe(true);
  });

  it("rechecks the queue before allowing the integration session to exit", async () => {
    const { root, repoDir } = await createRepositoryFixture();
    const fakeTmux = await createFakeTmux(root);
    run(process.execPath, [queueScript, "start-pi"], repoDir, {
      env: fakeTmux.env,
    });

    const empty = JSON.parse(
      run(process.execPath, [queueScript, "finish-pi"], repoDir, {
        env: fakeTmux.env,
      }),
    ) as { status: string; queued: number };
    expect(empty).toEqual({ status: "finished", queued: 0 });

    const head = git(repoDir, ["rev-parse", "HEAD"]);
    git(repoDir, [
      "update-ref",
      "refs/workforest/integration-ready/20260820T120000000Z/tomdale/feature",
      head,
    ]);
    const queued = JSON.parse(
      run(process.execPath, [queueScript, "finish-pi"], repoDir, {
        env: fakeTmux.env,
      }),
    ) as { status: string; queued: number };
    expect(queued).toEqual({ status: "continue", queued: 1 });
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
