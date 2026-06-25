import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TaskState } from "@wf-plugin/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runCommandGeneratorMock } = vi.hoisted(() => ({
  runCommandGeneratorMock: vi.fn(),
}));

vi.mock("@wf-plugin/core", async () => {
  const actual =
    await vi.importActual<typeof import("@wf-plugin/core")>("@wf-plugin/core");

  return {
    ...actual,
    runCommandGenerator: runCommandGeneratorMock,
  };
});

import {
  activePluginPackageNames,
  builtInInitializerIds,
  runSingleRepoInitializersGenerator,
} from "./index.ts";

const tempDirs: string[] = [];

async function createRepoDir(files: Record<string, string>): Promise<string> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "workforest-runner-"));
  tempDirs.push(repoDir);

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(repoDir, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }

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
  runCommandGeneratorMock.mockImplementation(
    (command: string, _args: string[], options: { cwd?: string }) =>
      (async function* () {
        if (command === "vercel" && options.cwd) {
          await mkdir(path.join(options.cwd, ".vercel"), { recursive: true });
          await writeFile(
            path.join(options.cwd, ".vercel", "repo.json"),
            "{}\n",
            "utf8",
          );
        }
        yield { status: "completed" as const };
      })(),
  );
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("initializer runner", () => {
  it("uses the hardcoded active plugins by default", () => {
    expect(activePluginPackageNames).toEqual([
      "@wf-plugin/package-managers",
      "@wf-plugin/vercel",
      "@wf-plugin/turbo",
      "@wf-plugin/codex-cli",
      "@wf-plugin/claude-cli",
    ]);
    expect(builtInInitializerIds).toEqual([
      "pnpm-install",
      "yarn-install",
      "npm-install",
      "vercel-link",
      "turbo-link",
    ]);
  });

  it("supports disabling all initializers", async () => {
    const repoDir = await createRepoDir({ "vercel.json": "{}\n" });

    await expect(
      collectStates(
        runSingleRepoInitializersGenerator({
          context: {
            repoDir,
            workspaceDir: path.dirname(repoDir),
            workspaceConfig: {},
            repo: {
              name: "front",
              remote: "git@github.com:vercel/front.git",
              defaultBranch: "main",
            },
          },
          disabledInitializers: true,
        }),
      ),
    ).resolves.toEqual([{ phase: "complete" }]);
  });

  it("supports disabling specific initializer ids", async () => {
    const repoDir = await createRepoDir({ "vercel.json": "{}\n" });
    const states = await collectStates(
      runSingleRepoInitializersGenerator({
        context: {
          repoDir,
          workspaceDir: path.dirname(repoDir),
          workspaceConfig: {},
          repo: {
            name: "front",
            remote: "git@github.com:vercel/front.git",
            defaultBranch: "main",
          },
        },
        disabledInitializers: ["vercel-link"],
      }),
    );

    expect(states).toEqual([{ phase: "detecting" }, { phase: "complete" }]);
    expect(runCommandGeneratorMock).not.toHaveBeenCalled();
  });

  it("keeps package-manager detection mutually exclusive", async () => {
    const repoDir = await createRepoDir({
      "pnpm-lock.yaml": "lockfileVersion: 9\n",
      "yarn.lock": "",
      "package-lock.json": "{}\n",
    });
    runCommandGeneratorMock.mockImplementation(() =>
      taskStates([{ status: "completed" }]),
    );

    const states = await collectStates(
      runSingleRepoInitializersGenerator({
        context: {
          repoDir,
          workspaceDir: path.dirname(repoDir),
          workspaceConfig: {},
          repo: {
            name: "front",
            remote: "git@github.com:vercel/front.git",
            defaultBranch: "main",
          },
        },
      }),
    );

    const initializerIds = states
      .filter((state) => state.phase === "running")
      .map((state) => state.initializerId);
    expect(new Set(initializerIds)).toEqual(new Set(["pnpm-install"]));
  });

  it("runs Vercel and Turbo after the package-managers plugin", async () => {
    const repoDir = await createRepoDir({
      "pnpm-lock.yaml": "lockfileVersion: 9\n",
      "vercel.json": "{}\n",
      "turbo.json": "{}\n",
    });

    const states = await collectStates(
      runSingleRepoInitializersGenerator({
        context: {
          repoDir,
          workspaceDir: path.dirname(repoDir),
          workspaceConfig: {},
          repo: {
            name: "front",
            remote: "git@github.com:vercel/front.git",
            defaultBranch: "main",
          },
        },
      }),
    );

    const firstRunningIndex = new Map<string, number>();
    states.forEach((state, index) => {
      if (
        state.phase === "running" &&
        !firstRunningIndex.has(state.initializerId)
      ) {
        firstRunningIndex.set(state.initializerId, index);
      }
    });

    expect(firstRunningIndex.get("pnpm-install")).toBeLessThan(
      firstRunningIndex.get("vercel-link") ?? Number.POSITIVE_INFINITY,
    );
    expect(firstRunningIndex.get("pnpm-install")).toBeLessThan(
      firstRunningIndex.get("turbo-link") ?? Number.POSITIVE_INFINITY,
    );
  });
});
