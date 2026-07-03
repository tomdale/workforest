import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import turboLinkInitializer from "./initializers/turbo-link.ts";

async function collectStates<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const states: T[] = [];
  for await (const state of gen) {
    states.push(state);
  }
  return states;
}

const context = {
  repoDir: path.join(process.cwd(), "repo"),
  workspaceDir: process.cwd(),
  workspaceConfig: {},
  repo: {
    name: "repo",
    remote: "git@github.com:vercel/repo.git",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  canRunForegroundTaskMock.mockReturnValue(true);
  runForegroundTaskMock.mockImplementation(() =>
    (async function* () {
      yield { status: "running" as const, message: "turbo login" };
      yield { status: "completed" as const };
    })(),
  );
});

describe("turboLinkInitializer.execute", () => {
  it("runs turbo link with an inferred Vercel scope", async () => {
    spawnCommandMock.mockImplementation(() =>
      (async function* () {
        yield {
          status: "running" as const,
          message: "turbo link --yes --scope vercel",
        };
        yield { status: "completed" as const };
      })(),
    );

    const states = await collectStates(turboLinkInitializer.execute(context, {}));

    expect(spawnCommandMock).toHaveBeenCalledWith(
      "turbo",
      ["link", "--yes", "--scope", "vercel"],
      { cwd: context.repoDir },
    );
    expect(states.at(-1)).toEqual({ status: "completed" });
  });

  it("skips when the GitHub owner is not a valid Vercel scope", async () => {
    const states = await collectStates(
      turboLinkInitializer.execute(
        {
          ...context,
          repo: {
            ...context.repo,
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

  it("infers the Vercel scope from a valid GitHub owner", async () => {
    spawnCommandMock.mockImplementation(() =>
      (async function* () {
        yield { status: "completed" as const };
      })(),
    );

    await collectStates(
      turboLinkInitializer.execute(
        {
          ...context,
          repo: {
            ...context.repo,
            remote: "git@github.com:some-owner/some-repo.git",
          },
        },
        {},
      ),
    );

    expect(spawnCommandMock).toHaveBeenCalledWith(
      "turbo",
      ["link", "--yes", "--scope", "some-owner"],
      { cwd: context.repoDir },
    );
  });

  it("uses repo-specific team overrides", async () => {
    spawnCommandMock.mockImplementation(() =>
      (async function* () {
        yield { status: "completed" as const };
      })(),
    );

    await collectStates(
      turboLinkInitializer.execute(
        {
          ...context,
          workspaceConfig: {
            vercelLink: {
              repoOverrides: {
                "some-owner/some-repo": { team: "custom-team" },
              },
            },
          },
          repo: {
            ...context.repo,
            remote: "https://github.com/some-owner/some-repo.git",
          },
        },
        {},
      ),
    );

    expect(spawnCommandMock).toHaveBeenCalledWith(
      "turbo",
      ["link", "--yes", "--scope", "custom-team"],
      { cwd: context.repoDir },
    );
  });

  it("launches turbo login and retries when turbo link reports no user", async () => {
    let linkAttempts = 0;
    spawnCommandMock.mockImplementation(() =>
      (async function* () {
        linkAttempts += 1;
        yield {
          status: "running" as const,
          message: "turbo link --yes --scope vercel",
        };
        if (linkAttempts === 1) {
          yield {
            status: "failed" as const,
            error: new Error(
              "turbo link --yes --scope vercel exited with code 1. x User not found. Please login to Turborepo first by running `npx turbo login`.",
            ),
          };
          return;
        }
        yield { status: "completed" as const };
      })(),
    );

    const states = await collectStates(turboLinkInitializer.execute(context, {}));

    expect(runForegroundTaskMock).toHaveBeenCalledWith("turbo", ["login"], {
      cwd: context.repoDir,
    });
    expect(spawnCommandMock).toHaveBeenCalledTimes(2);
    expect(states).toContainEqual({
      status: "retrying",
      reason: "Turbo link after Turborepo login",
      attempt: 1,
    });
    expect(states.at(-1)).toEqual({ status: "completed" });
  });

  it("launches turbo login and retries when turbo link reports invalid auth", async () => {
    let linkAttempts = 0;
    spawnCommandMock.mockImplementation(() =>
      (async function* () {
        linkAttempts += 1;
        if (linkAttempts === 1) {
          yield {
            status: "failed" as const,
            error: new Error(
              "turbo link --yes --scope vercel exited with code 1. x Could not get user information: Error making HTTP request: HTTP status client error (403 Forbidden) for url (https://vercel.com/api/v2/user)",
            ),
          };
          return;
        }
        yield { status: "completed" as const };
      })(),
    );

    const states = await collectStates(turboLinkInitializer.execute(context, {}));

    expect(runForegroundTaskMock).toHaveBeenCalledWith("turbo", ["login"], {
      cwd: context.repoDir,
    });
    expect(states.at(-1)).toEqual({ status: "completed" });
  });

  it("skips auth-dependent link when running in the background", async () => {
    canRunForegroundTaskMock.mockReturnValue(false);
    spawnCommandMock.mockImplementation(() =>
      (async function* () {
        yield {
          status: "failed" as const,
          error: new Error(
            "turbo link --yes --scope vercel exited with code 1. x User not found. Please login to Turborepo first by running `npx turbo login`.",
          ),
        };
      })(),
    );

    const states = await collectStates(turboLinkInitializer.execute(context, {}));

    expect(states).toEqual([
      {
        status: "skipped",
        reason:
          "Turborepo authentication required. Run `turbo login`, then rerun setup to link the repository.",
      },
    ]);
    expect(runForegroundTaskMock).not.toHaveBeenCalled();
  });

  it("preserves non-auth link failures", async () => {
    spawnCommandMock.mockImplementation(() =>
      (async function* () {
        yield {
          status: "failed" as const,
          error: new Error(
            "turbo link --yes --scope vercel exited with code 1. bad team slug",
          ),
        };
      })(),
    );

    const states = await collectStates(turboLinkInitializer.execute(context, {}));

    expect(states.at(-1)).toMatchObject({
      status: "failed",
      error: expect.objectContaining({
        message:
          "turbo link --yes --scope vercel exited with code 1. bad team slug",
      }),
    });
    expect(runForegroundTaskMock).not.toHaveBeenCalled();
  });
});
