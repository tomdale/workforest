import { describe, expect, it } from "vitest";
import {
  CONFIGURATION_REGISTRY,
  normalizeWorkspaceConfig,
} from "./configuration-registry.ts";
import {
  ENVIRONMENT_VARIABLE_REGISTRY,
  isEnvironmentVariableSet,
  readEnvironmentVariable,
  WORKFOREST_ENVIRONMENT_VARIABLES,
} from "./environment.ts";

describe("configuration registry", () => {
  it("defines every supported top-level field once", () => {
    expect(CONFIGURATION_REGISTRY.map((field) => field.key)).toEqual([
      "directory",
      "branchPrefix",
      "vercelLink",
      "cache",
      "ai",
      "cloud",
    ]);
  });

  it("normalizes values through the field definitions", () => {
    expect(
      normalizeWorkspaceConfig(
        {
          directory: {
            base: "  ~/Developer ",
            repos: " Checkouts ",
            workspaces: "",
            reviews: "/tmp/reviews",
          },
          branchPrefix: "tomdale",
          vercelLink: {
            teamByGitHubOwner: { " vercel ": " vercel " },
          },
          ai: {
            provider: " codex-cli ",
            model: " gpt-5 ",
            timeoutMs: 90000,
            disabled: false,
          },
        },
        "config.json",
      ),
    ).toEqual({
      directory: {
        base: "~/Developer",
        repos: "Checkouts",
        workspaces: "Workspaces",
        reviews: "/tmp/reviews",
      },
      branchPrefix: "tomdale",
      vercelLink: {
        teamByGitHubOwner: {
          vercel: "vercel",
        },
      },
      cache: {
        nodeModules: {
          enabled: true,
          maxRetainedPerRepo: 3,
        },
      },
      ai: {
        provider: "codex-cli",
        model: "gpt-5",
        timeoutMs: 90000,
        disabled: false,
      },
    });
  });
});

describe("environment variable registry", () => {
  it("defines unique names", () => {
    const names = ENVIRONMENT_VARIABLE_REGISTRY.map(
      (definition) => definition.name,
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("reads registered variables from an injected environment", () => {
    const environment = {
      [WORKFOREST_ENVIRONMENT_VARIABLES.cacheDir]: "/tmp/cache",
      [WORKFOREST_ENVIRONMENT_VARIABLES.noTui]: "",
    };

    expect(
      readEnvironmentVariable(
        WORKFOREST_ENVIRONMENT_VARIABLES.cacheDir,
        environment,
      ),
    ).toBe("/tmp/cache");
    expect(
      isEnvironmentVariableSet(
        WORKFOREST_ENVIRONMENT_VARIABLES.noTui,
        environment,
      ),
    ).toBe(false);
  });
});
