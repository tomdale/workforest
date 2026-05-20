import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  MAX_CONCURRENT_ENV_PULLS,
  resolveVercelRepoLinkTarget,
  default as vercelLinkInitializer,
} from "./initializers/vercel-link.ts";

const tempDirs: string[] = [];

async function createRepoDir(files: Record<string, string>): Promise<string> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "workforest-vercel-"));
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("resolveVercelRepoLinkTarget", () => {
  it("uses built-in GitHub owner defaults", () => {
    expect(
      resolveVercelRepoLinkTarget("git@github.com:vercel/omniagent.git", {}),
    ).toEqual({
      kind: "link",
      githubOwner: "vercel",
      githubSlug: "vercel/omniagent",
      team: "vercel",
    });
  });

  it("prefers repo overrides over owner mappings", () => {
    expect(
      resolveVercelRepoLinkTarget("git@github.com:vercel/omniagent.git", {
        vercelLink: {
          teamByGitHubOwner: {
            vercel: "vercel",
          },
          repoOverrides: {
            "vercel/omniagent": {
              team: "custom-team",
            },
          },
        },
      }),
    ).toEqual({
      kind: "link",
      githubOwner: "vercel",
      githubSlug: "vercel/omniagent",
      team: "custom-team",
    });
  });

  it("skips non-GitHub remotes", () => {
    expect(
      resolveVercelRepoLinkTarget("git@gitlab.com:vercel/omniagent.git", {}),
    ).toEqual({
      kind: "skip",
      reason: "Vercel auto-link only supports GitHub repositories.",
    });
  });
});

describe("vercelLinkInitializer.execute", () => {
  it("skips when no team mapping is available", async () => {
    const repoDir = await createRepoDir({
      "vercel.json": "{}\n",
    });

    const states = await collectStates(
      vercelLinkInitializer.execute(
        {
          repoDir,
          workspaceDir: path.dirname(repoDir),
          workspaceConfig: {},
          repo: {
            name: "some-repo",
            remote: "git@github.com:some-owner/some-repo.git",
            defaultBranch: "main",
          },
        },
        {},
      ),
    );

    expect(states).toEqual([
      {
        status: "skipped",
        reason:
          'No Vercel team mapping configured for GitHub owner "some-owner".',
      },
    ]);
    expect(runCommandGeneratorMock).not.toHaveBeenCalled();
  });

  it("runs repo-link with an inferred team and pulls env for linked repo projects", async () => {
    const repoDir = await createRepoDir({
      "vercel.json": "{}\n",
    });

    runCommandGeneratorMock.mockImplementation(
      (_command: string, args: string[], options: { cwd?: string }) =>
        (async function* () {
          if (!options.cwd) {
            throw new Error("Expected cwd.");
          }
          if (args[0] === "link") {
            await mkdir(path.join(options.cwd, ".vercel"), { recursive: true });
            await writeFile(
              path.join(options.cwd, ".vercel", "repo.json"),
              JSON.stringify({
                projects: [
                  { directory: "apps/web" },
                  { directory: "apps/docs" },
                ],
              }),
              "utf8",
            );
            yield { status: "running" as const, message: "vercel link" };
          } else {
            yield { status: "running" as const, message: "vercel env pull" };
          }
          yield { status: "completed" as const };
        })(),
    );

    const states = await collectStates(
      vercelLinkInitializer.execute(
        {
          repoDir,
          workspaceDir: path.dirname(repoDir),
          workspaceConfig: {},
          repo: {
            name: "omniagent",
            remote: "git@github.com:vercel/omniagent.git",
            defaultBranch: "main",
          },
        },
        {},
      ),
    );

    expect(runCommandGeneratorMock).toHaveBeenCalledWith(
      "vercel",
      ["link", "--yes", "--repo", "--scope", "vercel"],
      { cwd: repoDir },
    );
    expect(runCommandGeneratorMock).toHaveBeenCalledWith(
      "vercel",
      ["env", "pull", "--environment", "development", "--yes"],
      { cwd: path.join(repoDir, "apps/web") },
    );
    expect(runCommandGeneratorMock).toHaveBeenCalledWith(
      "vercel",
      ["env", "pull", "--environment", "development", "--yes"],
      { cwd: path.join(repoDir, "apps/docs") },
    );
    expect(states).toEqual([
      { status: "running", message: "vercel link" },
      { status: "running", message: "vercel env pull" },
      { status: "running", message: "vercel env pull" },
      { status: "completed" },
    ]);
  });

  it("pulls linked project env files in parallel with a max concurrency cap", async () => {
    const repoDir = await createRepoDir({
      "vercel.json": "{}\n",
    });
    let activeEnvPulls = 0;
    let maxActiveEnvPulls = 0;

    runCommandGeneratorMock.mockImplementation(
      (_command: string, args: string[], options: { cwd?: string }) =>
        (async function* () {
          if (!options.cwd) {
            throw new Error("Expected cwd.");
          }
          if (args[0] === "link") {
            await mkdir(path.join(options.cwd, ".vercel"), { recursive: true });
            await writeFile(
              path.join(options.cwd, ".vercel", "repo.json"),
              JSON.stringify({
                projects: Array.from(
                  { length: MAX_CONCURRENT_ENV_PULLS + 2 },
                  (_, index) => ({
                    directory: `apps/project-${index}`,
                  }),
                ),
              }),
              "utf8",
            );
            yield { status: "running" as const, message: "vercel link" };
          } else {
            activeEnvPulls += 1;
            maxActiveEnvPulls = Math.max(maxActiveEnvPulls, activeEnvPulls);
            yield { status: "running" as const, message: "vercel env pull" };
            await sleep(5);
            activeEnvPulls -= 1;
          }
          yield { status: "completed" as const };
        })(),
    );

    const states = await collectStates(
      vercelLinkInitializer.execute(
        {
          repoDir,
          workspaceDir: path.dirname(repoDir),
          workspaceConfig: {},
          repo: {
            name: "omniagent",
            remote: "git@github.com:vercel/omniagent.git",
            defaultBranch: "main",
          },
        },
        {},
      ),
    );

    expect(
      states.filter(
        (state) =>
          state.status === "running" && state.message === "vercel env pull",
      ),
    ).toHaveLength(MAX_CONCURRENT_ENV_PULLS + 2);
    expect(maxActiveEnvPulls).toBe(MAX_CONCURRENT_ENV_PULLS);
    expect(states.at(-1)).toEqual({ status: "completed" });
  });

  it("pulls env at the repo root when project.json exists", async () => {
    const repoDir = await createRepoDir({
      ".vercel/project.json": "{}\n",
      "vercel.json": "{}\n",
    });

    runCommandGeneratorMock.mockImplementation(
      (_command: string, args: string[]) =>
        (async function* () {
          yield {
            status: "running" as const,
            message: args[0] === "link" ? "vercel link" : "vercel env pull",
          };
          yield { status: "completed" as const };
        })(),
    );

    const states = await collectStates(
      vercelLinkInitializer.execute(
        {
          repoDir,
          workspaceDir: path.dirname(repoDir),
          workspaceConfig: {},
          repo: {
            name: "omniagent",
            remote: "git@github.com:vercel/omniagent.git",
            defaultBranch: "main",
          },
        },
        {},
      ),
    );

    expect(runCommandGeneratorMock).toHaveBeenCalledWith(
      "vercel",
      ["env", "pull", "--environment", "development", "--yes"],
      { cwd: repoDir },
    );
    expect(states).toEqual([
      { status: "running", message: "vercel link" },
      { status: "running", message: "vercel env pull" },
      { status: "completed" },
    ]);
  });

  it("warns and pulls env at the repo root when link config files are missing", async () => {
    const repoDir = await createRepoDir({
      "vercel.json": "{}\n",
    });

    runCommandGeneratorMock.mockImplementation(
      (_command: string, args: string[]) =>
        (async function* () {
          yield {
            status: "running" as const,
            message: args[0] === "link" ? "vercel link" : "vercel env pull",
          };
          yield { status: "completed" as const };
        })(),
    );

    const states = await collectStates(
      vercelLinkInitializer.execute(
        {
          repoDir,
          workspaceDir: path.dirname(repoDir),
          workspaceConfig: {
            vercelLink: {
              repoOverrides: {
                "vercel/omniagent": {
                  team: "vercel",
                },
              },
            },
          },
          repo: {
            name: "omniagent",
            remote: "git@github.com:vercel/omniagent.git",
            defaultBranch: "main",
          },
        },
        {},
      ),
    );

    expect(states).toEqual([
      { status: "running", message: "vercel link" },
      {
        status: "log",
        level: "warn",
        message:
          "Neither .vercel/repo.json nor .vercel/project.json was found after vercel link; pulling development env at the repo root.",
      },
      { status: "running", message: "vercel env pull" },
      { status: "completed" },
    ]);
    expect(runCommandGeneratorMock).toHaveBeenCalledWith(
      "vercel",
      ["env", "pull", "--environment", "development", "--yes"],
      { cwd: repoDir },
    );
  });
});
