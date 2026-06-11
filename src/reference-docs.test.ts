import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import {
  CONFIGURATION_REFERENCE_PATH,
  ENVIRONMENT_REFERENCE_PATH,
  renderConfigurationReference,
  renderEnvironmentReference,
} from "./reference-docs.ts";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

describe("configuration registry", () => {
  it("defines every supported top-level field once", () => {
    expect(CONFIGURATION_REGISTRY.map((field) => field.key)).toEqual([
      "defaultDir",
      "reviewsDir",
      "dirPrefix",
      "branchPrefix",
      "vercelLink",
    ]);
  });

  it("normalizes values through the field definitions", () => {
    expect(
      normalizeWorkspaceConfig(
        {
          defaultDir: "  ~/Code/workspaces ",
          reviewsDir: "",
          dirPrefix: " wf- ",
          branchPrefix: "tomdale",
          vercelLink: {
            teamByGitHubOwner: { " vercel ": " vercel " },
          },
        },
        "config.json",
      ),
    ).toEqual({
      defaultDir: "~/Code/workspaces",
      dirPrefix: "wf-",
      branchPrefix: "tomdale/",
      vercelLink: {
        teamByGitHubOwner: {
          vercel: "vercel",
        },
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

describe("generated references", () => {
  it.each([
    [CONFIGURATION_REFERENCE_PATH, renderConfigurationReference],
    [ENVIRONMENT_REFERENCE_PATH, renderEnvironmentReference],
  ])("matches %s", async (relativePath, render) => {
    const generated = render();
    const committed = await readFile(
      path.join(PROJECT_ROOT, relativePath),
      "utf8",
    );

    expect(committed).toBe(generated);
    expect(render()).toBe(generated);
  });
});
