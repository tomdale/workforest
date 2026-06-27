import type { AiProviderDefinition } from "@wf-plugin/core";
import {
  builtInPluginPackages,
  getPluginId,
  getPluginMetadata,
  getPluginPackageName,
  type NormalizedPluginCapabilityMetadata,
  normalizePluginCapabilityMetadata,
  type PluginPackage,
} from "../plugins/index.ts";

type AiProviderModule = Record<string, unknown> & { default?: unknown };

type RegisteredAiProvider = {
  packageName: string;
  pluginId: string;
  metadata: NormalizedPluginCapabilityMetadata;
  order: number;
};

export type LoadedAiProvider = {
  registryEntry: RegisteredAiProvider;
  provider: AiProviderDefinition;
  priority: number;
};

export function validateAndOrderPluginAiProviders(
  packages: PluginPackage[],
): NormalizedPluginCapabilityMetadata[] {
  return orderRegisteredAiProviders(buildAiProviderRegistry(packages)).map(
    (entry) => entry.metadata,
  );
}

export async function loadAiProviders(): Promise<LoadedAiProvider[]> {
  return loadPluginAiProviders(builtInPluginPackages);
}

export async function loadPluginAiProviders(
  packages: PluginPackage[],
): Promise<LoadedAiProvider[]> {
  const registry = buildAiProviderRegistry(packages);
  const loaded = await Promise.all(registry.map(loadAiProvider));
  return loaded.sort(compareLoadedProviders);
}

function buildAiProviderRegistry(
  packages: PluginPackage[],
): RegisteredAiProvider[] {
  const entries: RegisteredAiProvider[] = [];
  const seenIds = new Map<string, string>();
  let order = 0;

  for (const pluginPackage of packages) {
    const packageName = getPluginPackageName(pluginPackage);
    const pluginMetadata = getPluginMetadata(pluginPackage);
    const pluginId = getPluginId(pluginPackage);
    const providerMetadata = pluginMetadata.aiProviders ?? [];

    for (const entry of providerMetadata) {
      const metadata = normalizePluginCapabilityMetadata({
        entry,
        capabilityKind: "AI provider",
        defaultModuleDirectory: "ai-providers",
      });

      const existingPlugin = seenIds.get(metadata.id);
      if (existingPlugin) {
        throw new Error(
          `Duplicate AI provider id "${metadata.id}" in "${existingPlugin}" and "${pluginId}".`,
        );
      }

      entries.push({ packageName, pluginId, metadata, order });
      seenIds.set(metadata.id, pluginId);
      order += 1;
    }
  }

  return orderRegisteredAiProviders(entries);
}

function orderRegisteredAiProviders(
  entries: RegisteredAiProvider[],
): RegisteredAiProvider[] {
  return [...entries].sort(compareRegisteredProviders);
}

function compareRegisteredProviders(
  left: RegisteredAiProvider,
  right: RegisteredAiProvider,
): number {
  const priorityDelta =
    (right.metadata.priority ?? 0) - (left.metadata.priority ?? 0);
  return priorityDelta || left.order - right.order;
}

async function loadAiProvider(
  entry: RegisteredAiProvider,
): Promise<LoadedAiProvider> {
  const module = (await import(
    `${entry.packageName}/${entry.metadata.module}`
  )) as AiProviderModule;
  const exported = entry.metadata.export
    ? module[entry.metadata.export]
    : module.default;

  if (exported === undefined) {
    throw new Error(
      `Plugin package "${entry.pluginId}" AI provider "${entry.metadata.id}" references missing export "${entry.metadata.export ?? "default"}".`,
    );
  }

  if (!isAiProviderDefinition(exported)) {
    throw new Error(
      `Plugin package "${entry.pluginId}" AI provider "${entry.metadata.id}" export is not a valid AI provider.`,
    );
  }

  if (exported.id !== entry.metadata.id) {
    throw new Error(
      `Plugin package "${entry.pluginId}" metadata id "${entry.metadata.id}" does not match exported AI provider id "${exported.id}".`,
    );
  }

  return {
    registryEntry: entry,
    provider: exported,
    priority: entry.metadata.priority ?? exported.priority,
  };
}

function isAiProviderDefinition(value: unknown): value is AiProviderDefinition {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<AiProviderDefinition>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.label === "string" &&
    typeof candidate.priority === "number" &&
    Array.isArray(candidate.capabilities) &&
    candidate.capabilities.every(
      (capability) => typeof capability === "string",
    ) &&
    candidate.modelCategories !== null &&
    typeof candidate.modelCategories === "object" &&
    typeof candidate.modelCategories.mini === "string" &&
    typeof candidate.detect === "function" &&
    typeof candidate.create === "function"
  );
}

function compareLoadedProviders(
  left: LoadedAiProvider,
  right: LoadedAiProvider,
): number {
  const priorityDelta = right.priority - left.priority;
  return priorityDelta || left.registryEntry.order - right.registryEntry.order;
}
