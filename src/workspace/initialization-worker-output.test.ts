import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SingleRepoInitializerState } from "../services/initializers/index.ts";
import type { RepoConfig } from "../types.ts";
import {
  getRepoInitializationLogPath,
  initializeWorkspaceInitialization,
  readRepoInitializationState,
  runRepoInitializationWorker,
  startRepoInitialization,
} from "./initialization.ts";
import { writeWorkspaceMetadata } from "./metadata.ts";

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

const initializerControl = vi.hoisted(() => ({
  runningRecorded: undefined as undefined | (() => void),
  outputRecorded: undefined as undefined | (() => void),
  releaseOutput: undefined as undefined | (() => void),
  releaseCompletion: undefined as undefined | (() => void),
}));

vi.mock("../services/initializers/index.ts", () => ({
  runSingleRepoInitializersGenerator:
    async function* (): AsyncGenerator<SingleRepoInitializerState> {
      yield {
        phase: "running",
        initializerId: "pnpm-install",
        initializerName: "pnpm install",
        state: {
          status: "running",
          message: "pnpm install --frozen-lockfile",
        },
      };
      initializerControl.runningRecorded?.();
      await new Promise<void>((resolve) => {
        initializerControl.releaseOutput = resolve;
      });
      vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
      yield {
        phase: "running",
        initializerId: "pnpm-install",
        initializerName: "pnpm install",
        state: {
          status: "output",
          data: "installing dependencies\n",
        },
      };
      yield {
        phase: "running",
        initializerId: "pnpm-install",
        initializerName: "pnpm install",
        state: {
          status: "output",
          data: "done\n",
        },
      };
      initializerControl.outputRecorded?.();
      await new Promise<void>((resolve) => {
        initializerControl.releaseCompletion = resolve;
      });
      vi.setSystemTime(new Date("2026-01-01T00:00:03.000Z"));
      yield {
        phase: "running",
        initializerId: "pnpm-install",
        initializerName: "pnpm install",
        state: { status: "completed" },
      };
      yield { phase: "complete" };
    },
}));

const tempDirs: string[] = [];
const repo: RepoConfig = {
  name: "front",
  remote: "git@github.com:vercel/front.git",
  defaultBranch: "main",
};

afterEach(async () => {
  vi.useRealTimers();
  initializerControl.runningRecorded = undefined;
  initializerControl.outputRecorded = undefined;
  initializerControl.releaseOutput = undefined;
  initializerControl.releaseCompletion = undefined;
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("background repository initializer output", () => {
  it("streams output to the setup log without bumping persisted status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const runningRecorded = deferred();
    const outputRecorded = deferred();
    initializerControl.runningRecorded = runningRecorded.resolve;
    initializerControl.outputRecorded = outputRecorded.resolve;
    const workspaceDir = await createWorkspace();
    const queued = await startRepoInitialization(
      { workspaceDir, repo },
      async () => process.pid,
    );

    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    const worker = runRepoInitializationWorker({
      workspaceDir,
      repoName: repo.name,
      runId: queued.run_id ?? "",
    });
    await runningRecorded.promise;
    const running = await readRepoInitializationState(workspaceDir, repo.name);
    expect(running).toMatchObject({
      status: "running",
      step: "initializer:pnpm install",
      message: "pnpm install --frozen-lockfile",
    });
    const runningUpdatedAt = running?.updated_at;

    initializerControl.releaseOutput?.();
    await outputRecorded.promise;
    const afterOutput = await readRepoInitializationState(
      workspaceDir,
      repo.name,
    );
    expect(afterOutput?.updated_at).toBe(runningUpdatedAt);
    expect(afterOutput).toMatchObject({
      status: "running",
      step: "initializer:pnpm install",
      message: "pnpm install --frozen-lockfile",
    });
    const log = await readFile(
      await getRepoInitializationLogPath(workspaceDir, repo.name),
      "utf8",
    );
    expect(log).toContain("pnpm install --frozen-lockfile");
    expect(log).toContain("installing dependencies");
    expect(log).toContain("done");

    initializerControl.releaseCompletion?.();
    await worker;
    await expect(
      readRepoInitializationState(workspaceDir, repo.name),
    ).resolves.toMatchObject({
      status: "ready",
      updated_at: "2026-01-01T00:00:03.000Z",
    });
  });
});

async function createWorkspace(): Promise<string> {
  const workspaceDir = await mkdtemp(
    path.join(os.tmpdir(), "workforest-initializer-output-"),
  );
  tempDirs.push(workspaceDir);
  await mkdir(path.join(workspaceDir, repo.name));
  await writeWorkspaceMetadata(workspaceDir, {
    featureName: "initializer-output",
    branchName: "tomdale/initializer-output",
    repos: [{ ...repo, hasLockfile: false }],
  });
  await initializeWorkspaceInitialization({
    workspaceDir,
    repos: [repo],
  });
  return workspaceDir;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
