import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspaceConfig, saveWorkspaceConfig } from "./config.ts";

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

  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("workspace config", () => {
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

  it("normalizes branch prefixes when loading", async () => {
    const configDir = await createConfigDir();
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        branchPrefix: "tomdale",
      }),
      "utf8",
    );

    const loaded = await loadWorkspaceConfig();

    expect(loaded.config.branchPrefix).toBe("tomdale/");
  });

  it("normalizes branch prefixes when saving", async () => {
    const configDir = await createConfigDir();
    const configPath = path.join(configDir, "config.json");

    await saveWorkspaceConfig(configPath, {
      branchPrefix: "tomdale",
    });

    const saved = JSON.parse(await readFile(configPath, "utf8")) as {
      branchPrefix?: unknown;
    };

    expect(saved.branchPrefix).toBe("tomdale/");
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
