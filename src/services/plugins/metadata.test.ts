import { describe, expect, it } from "vitest";
import {
  loadPluginAiProviders,
  validateAndOrderPluginAiProviders,
} from "../ai/providers.ts";
import { validateAndOrderPluginInitializers } from "../initializers/index.ts";
import type { PluginCapabilityEntry, PluginPackage } from "./index.ts";

function pluginPackage({
  name,
  pluginId,
  initializers = [],
  aiProviders = [],
  module = { detect: async () => ({ activate: false as const }) },
}: {
  name: string;
  pluginId?: string;
  initializers?: PluginCapabilityEntry[];
  aiProviders?: PluginCapabilityEntry[];
  module?: Record<string, unknown>;
}): PluginPackage {
  return {
    manifest: {
      name,
      workforest: {
        plugin: {
          ...(pluginId ? { id: pluginId } : {}),
          initializers,
          aiProviders,
        },
      },
    },
    module,
  };
}

describe("plugin capability metadata", () => {
  it("supports manifests that declare initializers and AI providers", () => {
    const packages = [
      pluginPackage({
        name: "@wf-plugin/example",
        initializers: ["setup"],
        aiProviders: [{ id: "example-ai", priority: 10 }],
      }),
    ];

    expect(validateAndOrderPluginInitializers(packages)).toEqual([
      { id: "setup", module: "initializers/setup" },
    ]);
    expect(validateAndOrderPluginAiProviders(packages)).toEqual([
      { id: "example-ai", module: "ai-providers/example-ai", priority: 10 },
    ]);
  });

  it("does not require a detect export for provider-only plugins", () => {
    expect(
      validateAndOrderPluginAiProviders([
        pluginPackage({
          name: "@wf-plugin/example",
          aiProviders: ["example-ai"],
          module: {},
        }),
      ]),
    ).toEqual([{ id: "example-ai", module: "ai-providers/example-ai" }]);
  });

  it("rejects duplicate AI provider ids", () => {
    expect(() =>
      validateAndOrderPluginAiProviders([
        pluginPackage({
          name: "@wf-plugin/one",
          aiProviders: ["example-ai"],
        }),
        pluginPackage({
          name: "@wf-plugin/two",
          aiProviders: ["example-ai"],
        }),
      ]),
    ).toThrow(/Duplicate AI provider id/);
  });

  it("rejects non-relative AI provider modules", () => {
    expect(() =>
      validateAndOrderPluginAiProviders([
        pluginPackage({
          name: "@wf-plugin/example",
          aiProviders: [
            {
              id: "example-ai",
              module: "@wf-plugin/example/ai-providers/example-ai",
            },
          ],
        }),
      ]),
    ).toThrow(/relative to the plugin package root/);
  });

  it("orders AI providers by priority", () => {
    expect(
      validateAndOrderPluginAiProviders([
        pluginPackage({
          name: "@wf-plugin/example",
          aiProviders: [
            { id: "fallback", priority: 10 },
            { id: "preferred", priority: 20 },
          ],
        }),
      ]).map((provider) => provider.id),
    ).toEqual(["preferred", "fallback"]);
  });

  it("reports missing AI provider exports", async () => {
    await expect(
      loadPluginAiProviders([
        pluginPackage({
          name: "@wf-plugin/codex-cli",
          aiProviders: [
            {
              id: "codex-cli",
              module: "./ai-providers/codex-cli",
              export: "missingProvider",
            },
          ],
        }),
      ]),
    ).rejects.toThrow(/references missing export/);
  });
});
