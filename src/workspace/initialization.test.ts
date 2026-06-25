import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepoConfig } from "../types.ts";
import {
  buildRepoInitializerWorkerEnvironment,
  cancelRepoInitializations,
  getInitializationDir,
  initializeRepositoryChangeSetup,
  initializeWorkspaceInitialization,
  REPO_INITIALIZER_WORKER,
  readRepoInitializationState,
  readWorkspaceInitializationState,
  repositoryChangeInitializationScope,
  retryRepoInitializations,
  runRepoInitializationWorker,
  startRepoInitialization,
} from "./initialization.ts";
import { writeWorkspaceMetadata } from "./metadata.ts";

const tempDirs: string[] = [];
const repo: RepoConfig = {
  name: "front",
  remote: "git@github.com:vercel/front.git",
  defaultBranch: "main",
};

afterEach(async () => {
  vi.restoreAllMocks();
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
    const firstScope = repositoryChangeInitializationScope({
      repoRootDir,
      changeName: "first-change",
    });
    const secondScope = repositoryChangeInitializationScope({
      repoRootDir,
      changeName: "second-change",
    });

    await initializeRepositoryChangeSetup({
      repoRootDir,
      changeName: "first-change",
      repo,
    });
    await initializeRepositoryChangeSetup({
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
