import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RepoPipelineState } from "./pipeline.ts";
import { getRepoSetupLogPath, withRepoSetupLog } from "./setup-logs.ts";

const tempDirs: string[] = [];

async function createWorkspaceDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workforest-logs-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function collect(
  pipeline: AsyncGenerator<RepoPipelineState>,
): Promise<RepoPipelineState[]> {
  const states: RepoPipelineState[] = [];
  for await (const state of pipeline) {
    states.push(state);
  }
  return states;
}

describe("repo setup logs", () => {
  it("keeps a per-repo log when setup fails", async () => {
    const workspaceDir = await createWorkspaceDir();
    const error = new Error("pnpm install exited with code 1");

    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield {
        phase: "initializer",
        name: "pnpm install",
        status: "running",
        message: "pnpm install --frozen-lockfile --prefer-offline",
      };
      yield {
        phase: "initializer",
        name: "pnpm install",
        status: "output",
        output: "ERR_PNPM_FETCH_404 package not found\n",
      };
      yield {
        phase: "initializer",
        name: "pnpm install",
        status: "failed",
      };
      yield { phase: "failed", error };
    };

    await collect(
      withRepoSetupLog(pipeline(), {
        workspaceDir,
        repoName: "front",
        repoDir: path.join(workspaceDir, "front"),
      }),
    );

    const logPath = await getRepoSetupLogPath({
      workspaceDir,
      repoName: "front",
    });
    const log = await readFile(logPath, "utf8");

    expect(log).toContain("repo: front");
    expect(log).toContain("pnpm install --frozen-lockfile --prefer-offline");
    expect(log).toContain("ERR_PNPM_FETCH_404 package not found");
    expect(log).toContain("pnpm install exited with code 1");
  });

  it("writes high-volume setup output and retains failure logs", async () => {
    const workspaceDir = await createWorkspaceDir();
    const output = "installing package\n".repeat(10_000);

    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield {
        phase: "initializer",
        name: "pnpm install",
        status: "output",
        output,
      };
      yield { phase: "failed", error: new Error("setup failed") };
    };

    await collect(
      withRepoSetupLog(pipeline(), {
        workspaceDir,
        repoName: "front",
        repoDir: path.join(workspaceDir, "front"),
      }),
    );

    const logPath = await getRepoSetupLogPath({
      workspaceDir,
      repoName: "front",
    });
    const log = await readFile(logPath, "utf8");

    expect(log).toContain(output);
    expect(log).toContain("setup failed");
  });

  it("removes the per-repo log when setup succeeds", async () => {
    const workspaceDir = await createWorkspaceDir();

    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield {
        phase: "git",
        step: "worktree",
        status: "running",
        message: "Creating worktree",
      };
      yield { phase: "complete", hasLockfile: true };
    };

    await collect(
      withRepoSetupLog(pipeline(), {
        workspaceDir,
        repoName: "front",
        repoDir: path.join(workspaceDir, "front"),
      }),
    );

    const logPath = await getRepoSetupLogPath({
      workspaceDir,
      repoName: "front",
    });

    await expect(readFile(logPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("converts thrown setup errors into failed states and keeps the log", async () => {
    const workspaceDir = await createWorkspaceDir();

    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield {
        phase: "git",
        step: "worktree",
        status: "running",
        message: "Creating worktree",
      };
      throw new Error("spawn turbo ENOENT");
    };

    const states = await collect(
      withRepoSetupLog(pipeline(), {
        workspaceDir,
        repoName: "front",
        repoDir: path.join(workspaceDir, "front"),
      }),
    );

    const failedState = states.find((state) => state.phase === "failed");
    expect(failedState).toMatchObject({
      phase: "failed",
      step: "repo pipeline",
    });

    const logPath = await getRepoSetupLogPath({
      workspaceDir,
      repoName: "front",
    });
    const log = await readFile(logPath, "utf8");

    expect(log).toContain("Creating worktree");
    expect(log).toContain("[thrown] spawn turbo ENOENT");
  });

  it("sanitizes repo names before using them as log filenames", async () => {
    const workspaceDir = await createWorkspaceDir();

    const logPath = await getRepoSetupLogPath({
      workspaceDir,
      repoName: "vercel/front",
    });

    expect(logPath).toBe(
      path.join(workspaceDir, ".workforest", "logs", "vercel_front.log"),
    );
  });

  it("does not write setup logs through a workspace symlink", async () => {
    const workspaceDir = await createWorkspaceDir();
    const outsideDir = await createWorkspaceDir();
    await mkdir(path.join(workspaceDir, ".workforest"));
    await symlink(outsideDir, path.join(workspaceDir, ".workforest", "logs"));

    const pipeline = async function* (): AsyncGenerator<RepoPipelineState> {
      yield { phase: "failed", error: new Error("setup failed") };
    };

    await expect(
      collect(
        withRepoSetupLog(pipeline(), {
          workspaceDir,
          repoName: "front",
          repoDir: path.join(workspaceDir, "front"),
        }),
      ),
    ).rejects.toThrow("symbolic link");
    await expect(
      readFile(path.join(outsideDir, "front.log"), "utf8"),
    ).rejects.toThrow();
  });
});
