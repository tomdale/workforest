import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadWorkspaceConfigMock, runCommandGeneratorMock } = vi.hoisted(() => ({
  loadWorkspaceConfigMock: vi.fn(),
  runCommandGeneratorMock: vi.fn(),
}));

vi.mock("../../config.ts", async () => {
  const actual =
    await vi.importActual<typeof import("../../config.ts")>("../../config.ts");

  return {
    ...actual,
    loadWorkspaceConfig: loadWorkspaceConfigMock,
  };
});

vi.mock("../../utils/task-generator.ts", () => ({
  runCommandGenerator: runCommandGeneratorMock,
}));

import {
  resolveVercelRepoLinkTarget,
  vercelLinkInitializer,
} from "./vercel-link.ts";

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

    loadWorkspaceConfigMock.mockResolvedValue({
      path: "/tmp/config.json",
      config: {},
    });

    const states = await collectStates(
      vercelLinkInitializer.execute(
        {
          repoDir,
          workspaceDir: path.dirname(repoDir),
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

  it("runs repo-link with an inferred team and succeeds when repo.json is created", async () => {
    const repoDir = await createRepoDir({
      "vercel.json": "{}\n",
    });

    loadWorkspaceConfigMock.mockResolvedValue({
      path: "/tmp/config.json",
      config: {},
    });

    runCommandGeneratorMock.mockImplementation(
      (_command: string, _args: string[], options: { cwd?: string }) =>
        (async function* () {
          if (!options.cwd) {
            throw new Error("Expected cwd.");
          }
          await mkdir(path.join(options.cwd, ".vercel"), { recursive: true });
          await writeFile(
            path.join(options.cwd, ".vercel", "repo.json"),
            "{}\n",
            "utf8",
          );
          yield { status: "running" as const, message: "vercel link" };
          yield { status: "completed" as const };
        })(),
    );

    const states = await collectStates(
      vercelLinkInitializer.execute(
        {
          repoDir,
          workspaceDir: path.dirname(repoDir),
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
    expect(states).toEqual([
      { status: "running", message: "vercel link" },
      { status: "completed" },
    ]);
  });

  it("skips when repo-link completes without creating repo.json", async () => {
    const repoDir = await createRepoDir({
      "vercel.json": "{}\n",
    });

    loadWorkspaceConfigMock.mockResolvedValue({
      path: "/tmp/config.json",
      config: {
        vercelLink: {
          repoOverrides: {
            "vercel/omniagent": {
              team: "vercel",
            },
          },
        },
      },
    });

    runCommandGeneratorMock.mockImplementation(() =>
      (async function* () {
        yield { status: "running" as const, message: "vercel link" };
        yield { status: "completed" as const };
      })(),
    );

    const states = await collectStates(
      vercelLinkInitializer.execute(
        {
          repoDir,
          workspaceDir: path.dirname(repoDir),
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
        status: "skipped",
        reason:
          'No existing Vercel projects linked to GitHub repo "vercel/omniagent" under team "vercel".',
      },
    ]);
  });
});
