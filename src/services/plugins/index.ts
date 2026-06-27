import { createRequire } from "node:module";
import * as claudeCliPlugin from "@wf-plugin/claude-cli";
import * as codexCliPlugin from "@wf-plugin/codex-cli";
import type { PluginDetect } from "@wf-plugin/core";
import * as packageManagersPlugin from "@wf-plugin/package-managers";
import * as turboPlugin from "@wf-plugin/turbo";
import * as vercelPlugin from "@wf-plugin/vercel";

export type PluginCapabilityMetadata = {
  id: string;
  module?: string;
  export?: string;
  before?: string[];
  after?: string[];
  requires?: string[];
  priority?: number;
};

export type PluginCapabilityEntry = string | PluginCapabilityMetadata;

export type WorkforestPluginMetadata = {
  id?: string;
  initializers?: PluginCapabilityEntry[];
  aiProviders?: PluginCapabilityEntry[];
};

export type PluginPackageManifest = {
  name?: string;
  workforest?: {
    plugin?: WorkforestPluginMetadata;
  };
};

export type PluginModule = Record<string, unknown> & {
  detect?: PluginDetect;
};

export type PluginPackage = {
  manifest: PluginPackageManifest;
  module: PluginModule;
};

export type NormalizedPluginCapabilityMetadata = Required<
  Pick<PluginCapabilityMetadata, "id" | "module">
> &
  Omit<PluginCapabilityMetadata, "id" | "module">;

const require = createRequire(import.meta.url);

export const builtInPluginPackages: PluginPackage[] = [
  {
    manifest: loadPluginManifest("@wf-plugin/package-managers"),
    module: packageManagersPlugin,
  },
  {
    manifest: loadPluginManifest("@wf-plugin/vercel"),
    module: vercelPlugin,
  },
  {
    manifest: loadPluginManifest("@wf-plugin/turbo"),
    module: turboPlugin,
  },
  {
    manifest: loadPluginManifest("@wf-plugin/codex-cli"),
    module: codexCliPlugin,
  },
  {
    manifest: loadPluginManifest("@wf-plugin/claude-cli"),
    module: claudeCliPlugin,
  },
];

export function loadPluginManifest(packageName: string): PluginPackageManifest {
  const manifestPath = require.resolve(`${packageName}/package.json`);
  return require(manifestPath) as PluginPackageManifest;
}

export function getPluginPackageName(pluginPackage: PluginPackage): string {
  const packageName = pluginPackage.manifest.name;
  if (!packageName) {
    throw new Error("Plugin package is missing package.json name.");
  }
  return packageName;
}

export function getPluginMetadata(
  pluginPackage: PluginPackage,
): WorkforestPluginMetadata {
  const packageName = getPluginPackageName(pluginPackage);
  const pluginMetadata = pluginPackage.manifest.workforest?.plugin;
  if (!pluginMetadata) {
    throw new Error(
      `Plugin package "${packageName}" is missing workforest.plugin metadata.`,
    );
  }
  return pluginMetadata;
}

export function getPluginId(pluginPackage: PluginPackage): string {
  const packageName = getPluginPackageName(pluginPackage);
  return getPluginMetadata(pluginPackage).id ?? packageName;
}

export function normalizePluginCapabilityMetadata({
  entry,
  capabilityKind,
  defaultModuleDirectory,
}: {
  entry: PluginCapabilityEntry;
  capabilityKind: string;
  defaultModuleDirectory: string;
}): NormalizedPluginCapabilityMetadata {
  let metadata: NormalizedPluginCapabilityMetadata;
  if (typeof entry === "string") {
    metadata = {
      id: entry,
      module: defaultCapabilityModule(defaultModuleDirectory, entry),
    };
  } else {
    metadata = {
      ...entry,
      module:
        entry.module ??
        defaultCapabilityModule(defaultModuleDirectory, entry.id),
    };
  }

  if (metadata.module.startsWith("./")) {
    metadata.module = metadata.module.slice(2);
  }

  if (
    metadata.module.startsWith("@") ||
    metadata.module.startsWith("/") ||
    metadata.module.startsWith("../")
  ) {
    throw new Error(
      `${capabilityKind} "${metadata.id}" module must be relative to the plugin package root.`,
    );
  }

  return metadata;
}

function defaultCapabilityModule(directory: string, id: string): string {
  return `${directory}/${id}`;
}
