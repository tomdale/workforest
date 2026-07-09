import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  canRunForegroundTaskMock,
  spawnCommandMock,
  runForegroundTaskMock,
} = vi.hoisted(() => ({
  canRunForegroundTaskMock: vi.fn(() => true),
  spawnCommandMock: vi.fn(),
  runForegroundTaskMock: vi.fn(),
}));

vi.mock("@wf-plugin/core", async () => {
  const actual =
    await vi.importActual<typeof import("@wf-plugin/core")>("@wf-plugin/core");

  return {
    ...actual,
    canRunForegroundTask: canRunForegroundTaskMock,
    spawnCommand: spawnCommandMock,
    runForegroundTask: runForegroundTaskMock,
  };
});

import vercelLinkInitializer from "./initializers/vercel-link.ts";

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
  canRunForegroundTaskMock.mockReturnValue(true);
  runForegroundTaskMock.mockImplementation(() =>
    (async function* () {
      yield { status: "running" as const, message: "foreground login" };
      yield { status: "completed" as const };
    })(),
  );
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("vercelLinkInitializer.execute", () => {
  it("skips non-GitHub remotes", async () => {
    const repoDir = await createRepoDir({ "vercel.json": "{}\n" });

    const states = await collectStates(
      vercelLinkInitializer.execute(
        {
          repoDir,
          workspaceDir: path.dirname(repoDir),
          workspaceConfig: {},
          repo: {
            name: "omniagent",
            remote: "git@gitlab.com:vercel/omniagent.git",
          },
        },
        {},
      ),
    );

    expect(states).toEqual([
      {
        status: "skipped",
        reason: "Vercel auto-link only supports GitHub repositories.",
      },
    ]);
    expect(spawnCommandMock).not.toHaveBeenCalled();
  });

  it("skips when the GitHub owner is not a valid Vercel scope", async () => {
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
            remote: "git@github.com:SomeOwner/some-repo.git",
          },
        },
        {},
      ),
    );

    expect(states).toEqual([
      {
        status: "skipped",
        reason:
          'No Vercel team mapping configured for GitHub owner "SomeOwner".',
      },
    ]);
    expect(spawnCommandMock).not.toHaveBeenCalled();
  });

  it("runs repo-link with an inferred team and pulls env for linked repo projects", async () => {
    const repoDir = await createRepoDir({
      "vercel.json": "{}\n",
    });

    spawnCommandMock.mockImplementation(
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
          },
        },
        {},
      ),
    );

    expect(spawnCommandMock).toHaveBeenCalledWith(
      "vercel",
      ["link", "--yes", "--repo", "--scope", "vercel", "--non-interactive"],
      { cwd: repoDir, pty: true, inactivityTimeoutMs: 120_000 },
    );
    expect(spawnCommandMock).toHaveBeenCalledWith(
      "vercel",
      [
        "env",
        "pull",
        "--environment",
        "development",
        "--yes",
        "--non-interactive",
      ],
      {
        cwd: path.join(repoDir, "apps/web"),
        pty: true,
        inactivityTimeoutMs: 120_000,
      },
    );
    expect(spawnCommandMock).toHaveBeenCalledWith(
      "vercel",
      [
        "env",
        "pull",
        "--environment",
        "development",
        "--yes",
        "--non-interactive",
      ],
      {
        cwd: path.join(repoDir, "apps/docs"),
        pty: true,
        inactivityTimeoutMs: 120_000,
      },
    );
    expect(states.at(-1)).toEqual({ status: "completed" });
  });

  it("infers the Vercel scope from a valid GitHub owner", async () => {
    const repoDir = await createRepoDir({
      "vercel.json": "{}\n",
    });

    spawnCommandMock.mockImplementation(
      (_command: string, args: string[], options: { cwd?: string }) =>
        (async function* () {
          if (!options.cwd) {
            throw new Error("Expected cwd.");
          }
          if (args[0] === "link") {
            await mkdir(path.join(options.cwd, ".vercel"), { recursive: true });
            await writeFile(
              path.join(options.cwd, ".vercel", "project.json"),
              "{}\n",
              "utf8",
            );
          }
          yield { status: "completed" as const };
        })(),
    );

    await collectStates(
      vercelLinkInitializer.execute(
        {
          repoDir,
          workspaceDir: path.dirname(repoDir),
          workspaceConfig: {},
          repo: {
            name: "some-repo",
            remote: "git@github.com:some-owner/some-repo.git",
          },
        },
        {},
      ),
    );

    expect(spawnCommandMock).toHaveBeenCalledWith(
      "vercel",
      [
        "link",
        "--yes",
        "--repo",
        "--scope",
        "some-owner",
        "--non-interactive",
      ],
      { cwd: repoDir, pty: true, inactivityTimeoutMs: 120_000 },
    );
  });

  it("pulls linked project env files in parallel with a max concurrency cap", async () => {
    const repoDir = await createRepoDir({
      "vercel.json": "{}\n",
    });
    let activeEnvPulls = 0;
    let maxActiveEnvPulls = 0;

    spawnCommandMock.mockImplementation(
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
                  { length: 8 },
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
          },
        },
        {},
      ),
    );

    expect(
      states.filter(
        (state) =>
          state.status === "running" &&
          state.message?.startsWith("vercel env pull (cwd: apps/project-"),
      ),
    ).toHaveLength(8);
    expect(maxActiveEnvPulls).toBe(6);
    expect(states.at(-1)).toEqual({ status: "completed" });
  });

  it("pulls env at the repo root when project.json exists", async () => {
    const repoDir = await createRepoDir({
      ".vercel/project.json": "{}\n",
      "vercel.json": "{}\n",
    });

    spawnCommandMock.mockImplementation(
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
          },
        },
        {},
      ),
    );

    expect(spawnCommandMock).toHaveBeenCalledWith(
      "vercel",
      [
        "env",
        "pull",
        "--environment",
        "development",
        "--yes",
        "--non-interactive",
      ],
      { cwd: repoDir, pty: true, inactivityTimeoutMs: 120_000 },
    );
    expect(states.at(-1)).toEqual({ status: "completed" });
  });

  it("warns and pulls env at the repo root when link config files are missing", async () => {
    const repoDir = await createRepoDir({
      "vercel.json": "{}\n",
    });

    spawnCommandMock.mockImplementation(
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
                  team: "custom-team",
                },
              },
            },
          },
          repo: {
            name: "omniagent",
            remote: "git@github.com:vercel/omniagent.git",
          },
        },
        {},
      ),
    );

    expect(states).toContainEqual(
      expect.objectContaining({ status: "log", level: "warn" }),
    );
    expect(states.at(-1)).toEqual({ status: "completed" });
    expect(spawnCommandMock).toHaveBeenCalledWith(
      "vercel",
      [
        "link",
        "--yes",
        "--repo",
        "--scope",
        "custom-team",
        "--non-interactive",
      ],
      { cwd: repoDir, pty: true, inactivityTimeoutMs: 120_000 },
    );
    expect(spawnCommandMock).toHaveBeenCalledWith(
      "vercel",
      [
        "env",
        "pull",
        "--environment",
        "development",
        "--yes",
        "--non-interactive",
      ],
      { cwd: repoDir, pty: true, inactivityTimeoutMs: 120_000 },
    );
  });

  it("launches vercel login and retries when preflight auth is missing", async () => {
    const repoDir = await createRepoDir({
      ".vercel/project.json": "{}\n",
      "vercel.json": "{}\n",
    });
    let whoamiAttempts = 0;

    spawnCommandMock.mockImplementation(
      (_command: string, args: string[]) =>
        (async function* () {
          yield { status: "running" as const, message: `vercel ${args[0]}` };
          if (args[0] === "whoami") {
            whoamiAttempts += 1;
            if (whoamiAttempts === 1) {
              yield {
                status: "failed" as const,
                error: new Error("No existing credentials found. Please login."),
              };
              return;
            }
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
          },
        },
        {},
      ),
    );

    expect(runForegroundTaskMock).toHaveBeenCalledWith("vercel", ["login"], {
      cwd: repoDir,
    });
    expect(spawnCommandMock).toHaveBeenNthCalledWith(
      1,
      "vercel",
      ["whoami", "--format", "json", "--non-interactive"],
      { cwd: repoDir, pty: true, inactivityTimeoutMs: 120_000 },
    );
    expect(spawnCommandMock).toHaveBeenNthCalledWith(
      2,
      "vercel",
      ["whoami", "--format", "json", "--non-interactive"],
      { cwd: repoDir, pty: true, inactivityTimeoutMs: 120_000 },
    );
    expect(states).toContainEqual(
      expect.objectContaining({ status: "retrying", attempt: 1 }),
    );
    expect(states.at(-1)).toEqual({ status: "completed" });
  });

  it("skips auth-dependent work when preflight auth is missing in the background", async () => {
    const repoDir = await createRepoDir({ "vercel.json": "{}\n" });
    canRunForegroundTaskMock.mockReturnValue(false);
    spawnCommandMock.mockImplementation(() =>
      (async function* () {
        yield {
          status: "failed" as const,
          error: new Error("Authentication required. Please login."),
        };
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
          },
        },
        {},
      ),
    );

    expect(states).toEqual([
      {
        status: "skipped",
        reason:
          "Vercel authentication required. Run `vercel login`, then rerun setup to link the project and pull development env.",
      },
    ]);
    expect(runForegroundTaskMock).not.toHaveBeenCalled();
    expect(spawnCommandMock).toHaveBeenCalledTimes(1);
  });

  it("preserves non-auth link failures", async () => {
    const repoDir = await createRepoDir({ "vercel.json": "{}\n" });

    spawnCommandMock.mockImplementation(
      (_command: string, args: string[]) =>
        (async function* () {
          if (args[0] === "link") {
            yield {
              status: "failed" as const,
              error: new Error("Project not found for selected scope."),
            };
            return;
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
          },
        },
        {},
      ),
    );

    expect(states.at(-1)).toMatchObject({
      status: "failed",
      error: expect.objectContaining({
        message: "Project not found for selected scope.",
      }),
    });
    expect(runForegroundTaskMock).not.toHaveBeenCalled();
  });

  it("launches vercel login and retries env pull auth failures", async () => {
    const repoDir = await createRepoDir({
      ".vercel/project.json": "{}\n",
      "vercel.json": "{}\n",
    });
    let envAttempts = 0;

    spawnCommandMock.mockImplementation(
      (_command: string, args: string[]) =>
        (async function* () {
          if (args[0] === "env") {
            envAttempts += 1;
            if (envAttempts === 1) {
              yield {
                status: "failed" as const,
                error: new Error("Token expired. Please login again."),
              };
              return;
            }
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
          },
        },
        {},
      ),
    );

    expect(runForegroundTaskMock).toHaveBeenCalledWith("vercel", ["login"], {
      cwd: repoDir,
    });
    expect(states).toContainEqual(
      expect.objectContaining({
        status: "retrying",
        reason: "Vercel env pull after Vercel login",
      }),
    );
    expect(states.at(-1)).toEqual({ status: "completed" });
  });

  it("skips env pull auth failures in the background", async () => {
    const repoDir = await createRepoDir({
      ".vercel/project.json": "{}\n",
      "vercel.json": "{}\n",
    });
    canRunForegroundTaskMock.mockReturnValue(false);

    spawnCommandMock.mockImplementation(
      (_command: string, args: string[]) =>
        (async function* () {
          if (args[0] === "env") {
            yield {
              status: "failed" as const,
              error: new Error("Authentication required. Please login."),
            };
            return;
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
          },
        },
        {},
      ),
    );

    expect(states).toContainEqual({
      status: "skipped",
      reason:
        "Vercel authentication required for env pull. Run `vercel login`, then rerun setup to link the project and pull development env.",
    });
    expect(states.at(-1)).toEqual({ status: "completed" });
    expect(runForegroundTaskMock).not.toHaveBeenCalled();
  });
});
