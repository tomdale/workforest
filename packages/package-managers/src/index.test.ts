import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskState } from "@wf-plugin/core";

const { spawnCommandMock } = vi.hoisted(() => ({
  spawnCommandMock: vi.fn(),
}));

vi.mock("@wf-plugin/core", async () => {
  const actual =
    await vi.importActual<typeof import("@wf-plugin/core")>("@wf-plugin/core");

  return {
    ...actual,
    spawnCommand: spawnCommandMock,
  };
});

import pnpmInstallInitializer from "./initializers/pnpm-install.ts";

const tempDirs: string[] = [];

async function createRepoDir(): Promise<string> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "workforest-pnpm-"));
  tempDirs.push(repoDir);
  await writeFile(path.join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  return repoDir;
}

async function collectStates<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const states: T[] = [];
  for await (const state of gen) {
    states.push(state);
  }
  return states;
}

async function* taskStates(states: TaskState[]): AsyncGenerator<TaskState> {
  for (const state of states) {
    yield state;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("pnpmInstallInitializer", () => {
  it("detects frozen-lockfile failures from a bounded output tail", async () => {
    const repoDir = await createRepoDir();
    const verboseOutput = "installing dependency\n".repeat(20_000);

    spawnCommandMock
      .mockImplementationOnce(() =>
        taskStates([
          { status: "running", message: "pnpm install --frozen-lockfile" },
          { status: "output", data: verboseOutput },
          {
            status: "output",
            data: "ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile\n",
          },
          {
            status: "failed",
            error: new Error("pnpm install exited with code 1"),
          },
        ]),
      )
      .mockImplementationOnce(() =>
        taskStates([
          { status: "running", message: "pnpm install" },
          { status: "completed" },
        ]),
      );

    const states = await collectStates(
      pnpmInstallInitializer.execute(
        {
          repoDir,
          workspaceDir: path.dirname(repoDir),
          repo: {
            name: "front",
            remote: "git@github.com:vercel/front.git",
          },
        },
        {},
      ),
    );

    expect(spawnCommandMock).toHaveBeenCalledTimes(2);
    expect(spawnCommandMock.mock.calls[1]).toMatchObject([
      "pnpm",
      ["install"],
      { cwd: repoDir },
    ]);
    expect(states).toContainEqual({
      status: "retrying",
      reason: "Lockfile out of sync",
      attempt: 1,
    });
    expect(states).not.toContainEqual(
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("stores the lockfile hash after a successful fallback install", async () => {
    const repoDir = await createRepoDir();
    await mkdir(path.join(repoDir, "node_modules"));

    spawnCommandMock
      .mockImplementationOnce(() =>
        taskStates([
          {
            status: "output",
            data: "ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile\n",
          },
          { status: "failed", error: new Error("frozen-lockfile") },
        ]),
      )
      .mockImplementationOnce(() => taskStates([{ status: "completed" }]));

    await collectStates(
      pnpmInstallInitializer.execute(
        {
          repoDir,
          workspaceDir: path.dirname(repoDir),
          repo: {
            name: "front",
            remote: "git@github.com:vercel/front.git",
          },
        },
        {},
      ),
    );

    await expect(
      readFile(
        path.join(repoDir, "node_modules", ".pnpm-lockfile-hash"),
        "utf8",
      ),
    ).resolves.toMatch(/^[a-f0-9]{64}$/);
  });
});
