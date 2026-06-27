import {
  type InitializerContext,
  type InitializerDefinition,
  type InitializerDetection,
  type PluginDetect,
  runParallel,
  type TaskState,
} from "@wf-plugin/core";
import { loadWorkspaceConfig } from "../../config.ts";
import {
  builtInPluginPackages,
  getPluginId,
  getPluginMetadata,
  getPluginPackageName,
  type NormalizedPluginCapabilityMetadata,
  normalizePluginCapabilityMetadata,
  type PluginCapabilityEntry,
  type PluginCapabilityMetadata,
  type PluginPackage,
  type PluginPackageManifest,
  type WorkforestPluginMetadata,
} from "../plugins/index.ts";

export type { InitializerContext, InitializerDefinition, InitializerDetection };

export type InitializerState =
  | { phase: "detecting"; repoName: string }
  | {
      phase: "running";
      repoName: string;
      initializerId: string;
      initializerName: string;
      state: TaskState;
    }
  | {
      phase: "skipped";
      repoName: string;
      initializerId: string;
      reason: string;
    }
  | { phase: "repo-complete"; repoName: string };

export type SingleRepoInitializerState =
  | { phase: "detecting" }
  | {
      phase: "running";
      initializerId: string;
      initializerName: string;
      state: TaskState;
    }
  | {
      phase: "skipped";
      initializerId: string;
      reason: string;
    }
  | { phase: "complete" };

type InitializerModule = Record<string, unknown> & { default?: unknown };

export type {
  PluginCapabilityEntry as PluginInitializerEntry,
  PluginCapabilityMetadata as PluginInitializerMetadata,
  PluginPackage,
  PluginPackageManifest,
  WorkforestPluginMetadata,
};

type RegisteredInitializer = {
  packageName: string;
  pluginId: string;
  metadata: NormalizedPluginCapabilityMetadata;
  key: string;
};

type LoadedInitializer = {
  registryEntry: RegisteredInitializer;
  initializer: InitializerDefinition;
};

const activeInitializerRegistry = buildInitializerRegistry(
  builtInPluginPackages,
);

export const builtInInitializerIds = activeInitializerRegistry.map(
  (entry) => entry.metadata.id,
);

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function initializerKey(pluginId: string, initializerId: string): string {
  return `${pluginId}:${initializerId}`;
}

function isInitializerDefinition(
  value: unknown,
): value is InitializerDefinition {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<InitializerDefinition>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.execute === "function"
  );
}

function isPluginDetect(value: unknown): value is PluginDetect {
  return typeof value === "function";
}

export function validateAndOrderPluginInitializers(
  packages: PluginPackage[],
): RegisteredInitializer["metadata"][] {
  return orderRegisteredInitializers(buildInitializerRegistry(packages)).map(
    (entry) => entry.metadata,
  );
}

function buildInitializerRegistry(
  packages: PluginPackage[],
): RegisteredInitializer[] {
  const entries: RegisteredInitializer[] = [];
  const seenIds = new Map<string, string>();

  for (const pluginPackage of packages) {
    const packageName = getPluginPackageName(pluginPackage);
    const pluginMetadata = getPluginMetadata(pluginPackage);
    const pluginId = pluginMetadata.id ?? packageName;
    const initializerMetadata = pluginMetadata.initializers ?? [];
    if (
      initializerMetadata.length > 0 &&
      !isPluginDetect(pluginPackage.module.detect)
    ) {
      throw new Error(
        `Plugin package "${packageName}" is missing detect export.`,
      );
    }

    for (const entry of initializerMetadata) {
      const metadata = normalizeInitializerMetadata(entry);

      const existingPlugin = seenIds.get(metadata.id);
      if (existingPlugin) {
        throw new Error(
          `Duplicate initializer id "${metadata.id}" in "${existingPlugin}" and "${pluginId}".`,
        );
      }

      entries.push({
        packageName,
        pluginId,
        metadata,
        key: initializerKey(pluginId, metadata.id),
      });
      seenIds.set(metadata.id, pluginId);
    }
  }

  return entries;
}

function normalizeInitializerMetadata(
  entry: PluginCapabilityEntry,
): RegisteredInitializer["metadata"] {
  return normalizePluginCapabilityMetadata({
    entry,
    capabilityKind: "Initializer",
    defaultModuleDirectory: "initializers",
  });
}

function orderRegisteredInitializers(
  entries: RegisteredInitializer[],
): RegisteredInitializer[] {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const byPlugin = new Map<string, RegisteredInitializer[]>();

  for (const entry of entries) {
    const pluginEntries = byPlugin.get(entry.pluginId) ?? [];
    pluginEntries.push(entry);
    byPlugin.set(entry.pluginId, pluginEntries);
  }

  validateRequires(entries, byKey);

  const edges = new Map<string, Set<string>>();
  for (const entry of entries) {
    edges.set(entry.key, new Set());
  }

  for (const entry of entries) {
    for (const beforeRef of entry.metadata.before ?? []) {
      for (const target of resolveOrderingReference(
        beforeRef,
        entry.pluginId,
        byKey,
        byPlugin,
      )) {
        edges.get(entry.key)?.add(target.key);
      }
    }

    for (const afterRef of entry.metadata.after ?? []) {
      for (const target of resolveOrderingReference(
        afterRef,
        entry.pluginId,
        byKey,
        byPlugin,
      )) {
        edges.get(target.key)?.add(entry.key);
      }
    }
  }

  return topologicalSort(entries, edges);
}

function validateRequires(
  entries: RegisteredInitializer[],
  byKey: Map<string, RegisteredInitializer>,
): void {
  for (const entry of entries) {
    for (const requiredRef of entry.metadata.requires ?? []) {
      const required = resolveInitializerReference(
        requiredRef,
        entry.pluginId,
        byKey,
      );
      if (!required) {
        throw new Error(
          `Initializer "${entry.metadata.id}" requires inactive or missing initializer "${requiredRef}".`,
        );
      }
    }
  }
}

function resolveInitializerReference(
  reference: string,
  sourcePluginId: string,
  byKey: Map<string, RegisteredInitializer>,
): RegisteredInitializer | undefined {
  if (reference.includes(":")) {
    const [pluginId, initializerId] = splitCrossPluginReference(reference);
    if (!pluginId || !initializerId) {
      return undefined;
    }
    return byKey.get(initializerKey(pluginId, initializerId));
  }

  return byKey.get(initializerKey(sourcePluginId, reference));
}

function resolveOrderingReference(
  reference: string,
  sourcePluginId: string,
  byKey: Map<string, RegisteredInitializer>,
  byPlugin: Map<string, RegisteredInitializer[]>,
): RegisteredInitializer[] {
  if (reference.startsWith("@") && !reference.includes(":")) {
    return byPlugin.get(reference) ?? [];
  }

  const initializer = resolveInitializerReference(
    reference,
    sourcePluginId,
    byKey,
  );
  return initializer ? [initializer] : [];
}

function splitCrossPluginReference(
  reference: string,
): [pluginId: string | undefined, initializerId: string | undefined] {
  const separatorIndex = reference.lastIndexOf(":");
  if (separatorIndex === -1) {
    return [undefined, undefined];
  }

  return [
    reference.slice(0, separatorIndex),
    reference.slice(separatorIndex + 1),
  ];
}

function topologicalSort(
  entries: RegisteredInitializer[],
  edges: Map<string, Set<string>>,
): RegisteredInitializer[] {
  const inDegree = new Map(entries.map((entry) => [entry.key, 0]));

  for (const targets of edges.values()) {
    for (const target of targets) {
      inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
    }
  }

  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const ready = entries.filter((entry) => inDegree.get(entry.key) === 0);
  const ordered: RegisteredInitializer[] = [];

  while (ready.length > 0) {
    const entry = ready.shift();
    if (!entry) {
      break;
    }

    ordered.push(entry);

    for (const targetKey of edges.get(entry.key) ?? []) {
      const nextDegree = (inDegree.get(targetKey) ?? 0) - 1;
      inDegree.set(targetKey, nextDegree);
      if (nextDegree === 0) {
        const target = byKey.get(targetKey);
        if (target) {
          ready.push(target);
        }
      }
    }
  }

  if (ordered.length !== entries.length) {
    throw new Error("Initializer ordering contains a cycle.");
  }

  return ordered;
}

export type RunInitializersOptions = {
  contexts: InitializerContext[];
  disabledInitializers?: boolean | string[];
};

function getEnabledRegistry(
  disabledInitializers: boolean | string[] | undefined,
): RegisteredInitializer[] {
  if (disabledInitializers === true) {
    return [];
  }

  if (Array.isArray(disabledInitializers)) {
    return activeInitializerRegistry.filter(
      (entry) => !disabledInitializers.includes(entry.metadata.id),
    );
  }

  return activeInitializerRegistry;
}

async function withWorkspaceConfig(
  context: InitializerContext,
): Promise<InitializerContext> {
  if (context.workspaceConfig) {
    return context;
  }

  const { config } = await loadWorkspaceConfig();
  return { ...context, workspaceConfig: config };
}

async function activateInitializersForRepo({
  context,
  disabledInitializers,
}: {
  context: InitializerContext;
  disabledInitializers?: boolean | string[];
}): Promise<RegisteredInitializer[]> {
  const enabledRegistry = getEnabledRegistry(disabledInitializers);
  if (enabledRegistry.length === 0) {
    return [];
  }

  const byLocalKey = new Map(
    activeInitializerRegistry.map((entry) => [
      initializerKey(entry.pluginId, entry.metadata.id),
      entry,
    ]),
  );
  const activeByKey = new Map<string, RegisteredInitializer>();

  for (const pluginPackage of activePluginPackages) {
    const packageName = getPluginPackageName(pluginPackage);
    const pluginMetadata = getPluginMetadata(pluginPackage);
    if ((pluginMetadata.initializers ?? []).length === 0) {
      continue;
    }

    const pluginId = getPluginId(pluginPackage);
    const detect = pluginPackage.module.detect;
    if (!isPluginDetect(detect)) {
      throw new Error(
        `Plugin package "${packageName}" is missing detect export.`,
      );
    }

    const detection = await detect(context);
    if (!isPluginDetection(detection)) {
      throw new Error(
        `Plugin package "${pluginId}" returned invalid detection.`,
      );
    }

    if (!detection.activate) {
      continue;
    }

    for (const initializerId of detection.initializers) {
      const entry = byLocalKey.get(initializerKey(pluginId, initializerId));
      if (!entry) {
        throw new Error(
          `Plugin package "${pluginId}" activated unknown initializer "${initializerId}".`,
        );
      }

      if (!enabledRegistry.includes(entry)) {
        continue;
      }

      activeByKey.set(entry.key, entry);
    }
  }

  return orderRegisteredInitializers([...activeByKey.values()]);
}

function isPluginDetection(
  value: unknown,
): value is Awaited<ReturnType<PluginDetect>> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const detection = value as { activate?: unknown; initializers?: unknown };
  if (detection.activate === false) {
    return true;
  }

  return (
    detection.activate === true &&
    Array.isArray(detection.initializers) &&
    detection.initializers.every(
      (initializer) => typeof initializer === "string",
    )
  );
}

async function loadInitializer(
  entry: RegisteredInitializer,
): Promise<LoadedInitializer> {
  const module = (await import(
    `${entry.packageName}/${entry.metadata.module}`
  )) as InitializerModule;
  const exported = entry.metadata.export
    ? module[entry.metadata.export]
    : module.default;

  if (exported === undefined) {
    throw new Error(
      `Plugin package "${entry.pluginId}" initializer "${entry.metadata.id}" references missing export "${entry.metadata.export ?? "default"}".`,
    );
  }

  if (!isInitializerDefinition(exported)) {
    throw new Error(
      `Plugin package "${entry.pluginId}" initializer "${entry.metadata.id}" export is not a valid initializer.`,
    );
  }

  if (exported.id !== entry.metadata.id) {
    throw new Error(
      `Plugin package "${entry.pluginId}" metadata id "${entry.metadata.id}" does not match exported initializer id "${exported.id}".`,
    );
  }

  return { registryEntry: entry, initializer: exported };
}

export async function* runInitializersGenerator({
  contexts,
  disabledInitializers,
}: RunInitializersOptions): AsyncGenerator<InitializerState> {
  if (disabledInitializers === true) {
    return;
  }

  const tasks = new Map<string, AsyncGenerator<SingleRepoInitializerState>>();
  for (const context of contexts) {
    tasks.set(
      context.repo.name,
      runSingleRepoInitializersGenerator({
        context,
        ...(disabledInitializers !== undefined ? { disabledInitializers } : {}),
      }),
    );
  }

  for await (const { id: repoName, state } of runParallel(tasks)) {
    switch (state.phase) {
      case "detecting":
        yield { phase: "detecting", repoName };
        break;
      case "running":
        yield { ...state, phase: "running", repoName };
        break;
      case "skipped":
        yield { ...state, phase: "skipped", repoName };
        break;
      case "complete":
        yield { phase: "repo-complete", repoName };
        break;
    }
  }
}

export type RunSingleRepoInitializersOptions = {
  context: InitializerContext;
  disabledInitializers?: boolean | string[];
};

export async function* runSingleRepoInitializersGenerator({
  context,
  disabledInitializers,
}: RunSingleRepoInitializersOptions): AsyncGenerator<SingleRepoInitializerState> {
  if (disabledInitializers === true) {
    yield { phase: "complete" };
    return;
  }

  let contextWithConfig: InitializerContext;
  try {
    contextWithConfig = await withWorkspaceConfig(context);
  } catch (error) {
    yield {
      phase: "running",
      initializerId: "detection",
      initializerName: "Initializer detection",
      state: { status: "failed", error: toError(error) },
    };
    return;
  }

  yield { phase: "detecting" };

  let activeEntries: RegisteredInitializer[];
  try {
    activeEntries = await activateInitializersForRepo({
      context: contextWithConfig,
      ...(disabledInitializers !== undefined ? { disabledInitializers } : {}),
    });
  } catch (error) {
    yield {
      phase: "running",
      initializerId: "detection",
      initializerName: "Initializer detection",
      state: { status: "failed", error: toError(error) },
    };
    return;
  }

  if (activeEntries.length === 0) {
    yield { phase: "complete" };
    return;
  }

  let initializers: LoadedInitializer[];
  try {
    initializers = await Promise.all(activeEntries.map(loadInitializer));
  } catch (error) {
    yield {
      phase: "running",
      initializerId: "detection",
      initializerName: "Initializer loading",
      state: { status: "failed", error: toError(error) },
    };
    return;
  }

  for (const { initializer } of initializers) {
    try {
      for await (const state of initializer.execute(contextWithConfig, {})) {
        yield {
          phase: "running",
          initializerId: initializer.id,
          initializerName: initializer.name,
          state,
        };
      }
    } catch (error) {
      yield {
        phase: "running",
        initializerId: initializer.id,
        initializerName: initializer.name,
        state: { status: "failed", error: toError(error) },
      };
      return;
    }
  }

  yield { phase: "complete" };
}

const activePluginPackages = builtInPluginPackages;
