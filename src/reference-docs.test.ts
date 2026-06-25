import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { commandRegistry } from "./cli/commands.ts";
import type { CommandGroup, CommandLeaf, CommandNode } from "./cli/types.ts";
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
  COMMAND_REFERENCE_PATH,
  CONFIGURATION_REFERENCE_PATH,
  ENVIRONMENT_REFERENCE_PATH,
  renderCommandReference,
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
      "directory",
      "branchPrefix",
      "vercelLink",
      "ai",
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

describe("generated references", () => {
  it.each([
    [COMMAND_REFERENCE_PATH, renderCommandReference],
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

  it("documents every visible canonical command and supported shortcut", () => {
    const generated = renderCommandReference();

    for (const leaf of collectVisibleLeaves(commandRegistry.root)) {
      expect(generated).toContain(`\`${formatCommand(leaf.path)}\``);
      for (const flag of leaf.flags) {
        expect(generated).toContain(`\`${flag.long}`);
      }
    }
    for (const shortcut of commandRegistry.shortcuts) {
      expect(generated).toContain(`### \`wf ${shortcut.name}\``);
      expect(generated).toContain(
        `Shortcut for \`${formatCommand(shortcut.target)}\`.`,
      );
    }

    expect(generated).not.toContain(["_initialize", "repo"].join("-"));
    expect(generated).not.toContain("Usage: workforest");
  });
});

function collectVisibleLeaves(root: CommandGroup): CommandLeaf[] {
  const leaves: CommandLeaf[] = [];
  const visit = (node: CommandNode) => {
    if (node.visibility === "hidden") return;
    if (node.kind === "leaf") {
      leaves.push(node);
      return;
    }
    node.children.forEach(visit);
  };
  root.children.forEach(visit);
  return leaves;
}

function formatCommand(path: readonly string[]): string {
  return `wf ${path.join(" ")}`;
}
