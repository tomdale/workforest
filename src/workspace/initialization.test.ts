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
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGit } from "../services/git.ts";
import { createTemplate } from "../templates/index.ts";
import type { RepositorySource } from "../types.ts";
import {
  buildRepoInitializerWorkerEnvironment,
  cancelRepoInitializations,
  getInitializationDir,
  initializeWorkspaceInitialization,
  initializeWorktreeSetup,
  REPO_INITIALIZER_WORKER,
  readRepoInitializationState,
  readWorkspaceInitializationState,
  retryRepoInitializations,
  runRepoInitializationWorker,
  startRepoInitialization,
  worktreeInitializationScope,
} from "./initialization.ts";
import { writeWorkspaceMetadata } from "./metadata.ts";

const tempDirs: string[] = [];
const originalXdgConfigHome = process.env["XDG_CONFIG_HOME"];
const originalCacheDir = process.env["WORKFOREST_CACHE_DIR"];
const originalAiProvider = process.env["WORKFOREST_AI_PROVIDER"];
const originalAiDisabled = process.env["WORKFOREST_AI_DISABLED"];
const originalPath = process.env["PATH"];
const originalPromptLog = process.env["WORKFOREST_PROMPT_LOG"];
const originalShell = process.env["SHELL"];
const repo: RepositorySource = {
  name: "front",
  remote: "git@github.com:vercel/front.git",
};

afterEach(async () => {
  vi.restoreAllMocks();
  restoreEnvironment("XDG_CONFIG_HOME", originalXdgConfigHome);
  restoreEnvironment("WORKFOREST_CACHE_DIR", originalCacheDir);
  restoreEnvironment("WORKFOREST_AI_PROVIDER", originalAiProvider);
  restoreEnvironment("WORKFOREST_AI_DISABLED", originalAiDisabled);
  restoreEnvironment("PATH", originalPath);
  restoreEnvironment("WORKFOREST_PROMPT_LOG", originalPromptLog);
  restoreEnvironment("SHELL", originalShell);
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const workspaceDir = await mkdtemp(
    path.join(os.tmpdir(), "workforest-initialization-"),
  );
  tempDirs.push(workspaceDir);
  await mkdir(path.join(workspaceDir, repo.name));
  await writeWorkspaceMetadata(workspaceDir, {
    featureName: "background-init",
    branchName: "tomdale/background-init",
    repos: [{ ...repo, hasLockfile: false }],
  });
  await initializeWorkspaceInitialization({
    workspaceDir,
    repos: [repo],
  });
  return workspaceDir;
}

describe("background repository initialization", () => {
  it("builds the private worker environment for detached initializers", () => {
    expect(
      buildRepoInitializerWorkerEnvironment({
        workspaceDir: "/tmp/workspace",
        repoName: "front",
        runId: "run-1",
        environment: { EXISTING: "value" },
      }),
    ).toEqual({
      EXISTING: "value",
      WORKFOREST_BACKGROUND_WORKER: "1",
      WORKFOREST_WORKER: REPO_INITIALIZER_WORKER,
      WORKFOREST_WORKER_SCOPE: "workspace",
      WORKFOREST_WORKER_WORKSPACE: "/tmp/workspace",
      WORKFOREST_WORKER_REPO: "front",
      WORKFOREST_WORKER_RUN_ID: "run-1",
    });
  });

  it("runs an initializer worker to completion and finalizes the workspace", async () => {
    const workspaceDir = await createWorkspace();
    const queued = await startRepoInitialization(
      { workspaceDir, repo },
      async () => process.pid,
    );

    expect(queued.status).toBe("queued");
    expect(queued.attempt).toBe(1);
    expect(queued.run_id).toBeDefined();

    await runRepoInitializationWorker({
      workspaceDir,
      repoName: repo.name,
      runId: queued.run_id ?? "",
    });

    await expect(
      readRepoInitializationState(workspaceDir, repo.name),
    ).resolves.toMatchObject({
      status: "ready",
      attempt: 1,
    });
    await expect(
      readWorkspaceInitializationState(workspaceDir),
    ).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("refreshes template AGENTS.md guidance from the background initializer finalizer", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "workforest-background-guidance-"),
    );
    tempDirs.push(root);
    const source = path.join(root, "source");
    const configHome = path.join(root, "config");
    const cache = path.join(root, "cache");
    const bin = path.join(root, "bin");
    const workspaceDir = path.join(root, "workspace");
    const promptLog = path.join(root, "prompts.log");
    await mkdir(path.join(source, "src"), { recursive: true });
    await mkdir(path.join(workspaceDir, "source"), { recursive: true });
    await mkdir(bin);
    await runGit(["init", "-b", "main"], { cwd: source });
    await runGit(["config", "user.email", "test@example.com"], {
      cwd: source,
    });
    await runGit(["config", "user.name", "Test"], { cwd: source });
    await runGit(["config", "commit.gpgsign", "false"], { cwd: source });
    await writeFile(
      path.join(source, "src", "settings.ts"),
      "export const settings = true;\n",
      "utf8",
    );
    await runGit(["add", "src/settings.ts"], { cwd: source });
    await runGit(["commit", "-m", "add settings"], { cwd: source });
    await writeFile(
      path.join(bin, "codex"),
      fakeCodexScript(
        [
          "<agents_md>",
          "Template: background-guidance.",
          "Scope: Start in source/src/settings.ts.",
          "</agents_md>",
        ].join("\n"),
      ),
      "utf8",
    );
    await chmod(path.join(bin, "codex"), 0o755);

    process.env["XDG_CONFIG_HOME"] = configHome;
    process.env["WORKFOREST_CACHE_DIR"] = cache;
    process.env["WORKFOREST_AI_PROVIDER"] = "codex-cli";
    delete process.env["WORKFOREST_AI_DISABLED"];
    process.env["WORKFOREST_PROMPT_LOG"] = promptLog;
    process.env["PATH"] = `${bin}${path.delimiter}${originalPath ?? ""}`;
    delete process.env["SHELL"];
    await createTemplate("background-guidance", {
      repos: [`file://${source}`],
      "AGENTS.md": {
        focus: "How settings are loaded.",
        paths: { source: ["src"] },
      },
    });
    const sourceRepo: RepositorySource = {
      name: "source",
      remote: `file://${source}`,
    };
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: "background-guidance",
      branchName: "tomdale/background-guidance",
      templateId: "background-guidance",
      repos: [{ ...sourceRepo, hasLockfile: false }],
    });
    await initializeWorkspaceInitialization({
      workspaceDir,
      repos: [sourceRepo],
    });
    const queued = await startRepoInitialization(
      { workspaceDir, repo: sourceRepo },
      async () => process.pid,
    );

    await runRepoInitializationWorker({
      workspaceDir,
      repoName: sourceRepo.name,
      runId: queued.run_id ?? "",
    });

    await expect(
      readWorkspaceInitializationState(workspaceDir),
    ).resolves.toMatchObject({
      status: "ready",
    });
    await expect(
      readFile(path.join(workspaceDir, "AGENTS.md"), "utf8"),
    ).resolves.toContain("Scope: Start in source/src/settings.ts.");
  });

  it("cancels a running worker process group and retries with a new attempt", async () => {
    const workspaceDir = await createWorkspace();
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      expect(pid).toBe(4242);
      expect(signal).toBe(0);
      return true;
    });
    await startRepoInitialization({ workspaceDir, repo }, async () => 4242);

    const [cancelled] = await cancelRepoInitializations(workspaceDir, [
      repo.name,
    ]);
    expect(cancelled).toMatchObject({
      status: "cancelled",
      attempt: 1,
    });
    expect(kill).not.toHaveBeenCalledWith(4242, "SIGTERM");
    await expect(
      readWorkspaceInitializationState(workspaceDir),
    ).resolves.toMatchObject({
      status: "initializing",
    });

    const [retried] = await retryRepoInitializations(
      workspaceDir,
      [repo.name],
      async () => 5252,
    );
    expect(retried).toMatchObject({
      status: "queued",
      attempt: 2,
      pid: 5252,
    });
    await expect(
      readWorkspaceInitializationState(workspaceDir),
    ).resolves.toMatchObject({
      status: "initializing",
    });
  });

  it("stores repository change setup state independently per change", async () => {
    const repoRootDir = await mkdtemp(
      path.join(os.tmpdir(), "workforest-repo-initialization-"),
    );
    tempDirs.push(repoRootDir);
    const firstScope = worktreeInitializationScope({
      repoRootDir,
      changeName: "first-change",
    });
    const secondScope = worktreeInitializationScope({
      repoRootDir,
      changeName: "second-change",
    });

    await initializeWorktreeSetup({
      repoRootDir,
      changeName: "first-change",
      repo,
    });
    await initializeWorktreeSetup({
      repoRootDir,
      changeName: "second-change",
      repo,
    });
    await startRepoInitialization(
      { scope: firstScope, repo },
      async () => 4242,
    );

    expect(getInitializationDir(firstScope)).toBe(
      path.join(repoRootDir, ".workforest", "initialization", "first-change"),
    );
    expect(getInitializationDir(secondScope)).toBe(
      path.join(repoRootDir, ".workforest", "initialization", "second-change"),
    );
    await expect(
      readRepoInitializationState(firstScope, repo.name),
    ).resolves.toMatchObject({
      status: "queued",
      attempt: 1,
      pid: 4242,
    });
    await expect(
      readRepoInitializationState(secondScope, repo.name),
    ).resolves.toMatchObject({
      status: "pending",
      attempt: 0,
    });
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function fakeCodexScript(response: string): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'codex 1.0.0\\n'
  exit 0
fi
output_file=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "--output-last-message" ]; then output_file="$arg"; fi
  if [ "$arg" = "--output-schema" ]; then exit 3; fi
  previous="$arg"
done
input="$(cat)"
printf '%s\\n---PROMPT---\\n' "$input" >> "$WORKFOREST_PROMPT_LOG"
printf '%s' ${JSON.stringify(response)} > "$output_file"
`;
}
