import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isRepoSlug,
  loadWorkspaceConfig,
  reposFromSlugs,
  saveWorkspaceConfig,
} from "./config.ts";
import { resolveWorkforestDirectories } from "./workspace/paths.ts";

const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];

const tempDirs: string[] = [];

async function createConfigDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workforest-config-"));
  tempDirs.push(dir);
  process.env["WORKFOREST_CONFIG_DIR"] = dir;
  return dir;
}

afterEach(async () => {
  if (ORIGINAL_CONFIG_DIR === undefined) {
    delete process.env["WORKFOREST_CONFIG_DIR"];
  } else {
    process.env["WORKFOREST_CONFIG_DIR"] = ORIGINAL_CONFIG_DIR;
  }

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("workspace config", () => {
  it("defaults the Workforest directory layout", async () => {
    await createConfigDir();

    const loaded = await loadWorkspaceConfig();

    expect(loaded.config.directory).toEqual({
      base: "~/Code",
      repos: "Repos",
      workspaces: "Workspaces",
      reviews: "Reviews",
    });
    expect(resolveWorkforestDirectories(loaded.config)).toEqual({
      base: path.join(os.homedir(), "Code"),
      repos: path.join(os.homedir(), "Code", "Repos"),
      workspaces: path.join(os.homedir(), "Code", "Workspaces"),
      reviews: path.join(os.homedir(), "Code", "Reviews"),
    });
  });

  it("resolves relative directory children against directory.base", async () => {
    const configDir = await createConfigDir();
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        directory: {
          base: "~/Developer",
          repos: "Checkouts",
          workspaces: "Stacks",
          reviews: "Reviews",
        },
      }),
      "utf8",
    );

    const loaded = await loadWorkspaceConfig();

    expect(resolveWorkforestDirectories(loaded.config)).toEqual({
      base: path.join(os.homedir(), "Developer"),
      repos: path.join(os.homedir(), "Developer", "Checkouts"),
      workspaces: path.join(os.homedir(), "Developer", "Stacks"),
      reviews: path.join(os.homedir(), "Developer", "Reviews"),
    });
  });

  it("uses absolute directory children as provided", async () => {
    const configDir = await createConfigDir();
    const roots = {
      repos: path.join(configDir, "repo-root"),
      workspaces: path.join(configDir, "workspace-root"),
      reviews: path.join(configDir, "review-root"),
    };
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        directory: {
          base: "~/Developer",
          ...roots,
        },
      }),
      "utf8",
    );

    const loaded = await loadWorkspaceConfig();

    expect(resolveWorkforestDirectories(loaded.config)).toEqual({
      base: path.join(os.homedir(), "Developer"),
      repos: roots.repos,
      workspaces: roots.workspaces,
      reviews: roots.reviews,
    });
  });

  it("loads Vercel auto-link config", async () => {
    const configDir = await createConfigDir();
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        defaultDir: "~/Code/workspaces",
        vercelLink: {
          teamByGitHubOwner: {
            vercel: "vercel",
            "vercel-labs": "vercel-labs",
          },
          repoOverrides: {
            "vercel/omniagent": { team: "vercel" },
            "vercel/internal-only": { disabled: true },
          },
        },
      }),
      "utf8",
    );

    const loaded = await loadWorkspaceConfig();

    expect(loaded.config.vercelLink).toEqual({
      teamByGitHubOwner: {
        vercel: "vercel",
        "vercel-labs": "vercel-labs",
      },
      repoOverrides: {
        "vercel/omniagent": { team: "vercel" },
        "vercel/internal-only": { disabled: true },
      },
    });
  });

  it("persists Vercel auto-link config when saving", async () => {
    const configDir = await createConfigDir();
    const configPath = path.join(configDir, "config.json");

    await saveWorkspaceConfig(configPath, {
      defaultDir: "~/Code/workspaces",
      branchPrefix: "feature/",
      vercelLink: {
        teamByGitHubOwner: {
          vercel: "vercel",
        },
        repoOverrides: {
          "vercel/omniagent": { disabled: true },
        },
      },
    });

    const saved = JSON.parse(await readFile(configPath, "utf8")) as {
      vercelLink?: unknown;
    };

    expect(saved.vercelLink).toEqual({
      teamByGitHubOwner: {
        vercel: "vercel",
      },
      repoOverrides: {
        "vercel/omniagent": { disabled: true },
      },
    });
  });

  it("loads and saves reviewsDir", async () => {
    const configDir = await createConfigDir();
    const configPath = path.join(configDir, "config.json");

    await saveWorkspaceConfig(configPath, {
      defaultDir: "~/Code/workspaces",
      reviewsDir: "  ~/Code/reviews  ",
    });

    const loaded = await loadWorkspaceConfig();
    expect(loaded.config.reviewsDir).toBe("~/Code/reviews");

    const saved = JSON.parse(await readFile(configPath, "utf8")) as {
      reviewsDir?: unknown;
    };
    expect(saved.reviewsDir).toBe("~/Code/reviews");
  });

  it("preserves branch prefixes when loading", async () => {
    const configDir = await createConfigDir();
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        branchPrefix: "tomdale",
      }),
      "utf8",
    );

    const loaded = await loadWorkspaceConfig();

    expect(loaded.config.branchPrefix).toBe("tomdale");
  });

  it("preserves branch prefixes when saving", async () => {
    const configDir = await createConfigDir();
    const configPath = path.join(configDir, "config.json");

    await saveWorkspaceConfig(configPath, {
      branchPrefix: "tomdale",
    });

    const saved = JSON.parse(await readFile(configPath, "utf8")) as {
      branchPrefix?: unknown;
    };

    expect(saved.branchPrefix).toBe("tomdale");
  });

  it("rejects invalid Vercel auto-link config", async () => {
    const configDir = await createConfigDir();
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        vercelLink: {
          teamByGitHubOwner: {
            vercel: 123,
          },
        },
      }),
      "utf8",
    );

    await expect(loadWorkspaceConfig()).rejects.toThrow(
      "config.json.vercelLink.teamByGitHubOwner.vercel must be a string.",
    );
  });
});

describe("repository parsing", () => {
  it.each([
    "git@gitlab.com:team/subgroup/lib.git",
    "ssh://git@gitlab.com/team/sub+group/lib.git",
  ])("accepts generic git remote paths %j", (input) => {
    expect(isRepoSlug(input)).toBe(true);
    expect(reposFromSlugs([input])).toEqual([
      {
        name: "lib",
        remote: input,
        defaultBranch: "main",
      },
    ]);
  });

  it.each([
    "owner/.",
    "owner/..",
    "./repo",
    "../repo",
    "owner\\repo",
    "https://github.com/owner/../repo.git",
    "https://github.com/owner/%2e%2e.git",
    "git@github.com:owner/../repo.git",
    "git@github.com:owner/repo\\child.git",
  ])("rejects unsafe repository input %j", (input) => {
    expect(isRepoSlug(input)).toBe(false);
    expect(() => reposFromSlugs([input])).toThrow("Invalid repository");
  });
});
