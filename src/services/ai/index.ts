import {
  type AiAvailability,
  type AiModelCategory,
  type AiProgressEvent,
  type AiProviderContext,
  type AiProviderDefinition,
  createSpawnEnv,
} from "@wf-plugin/core";
import { loadWorkspaceConfig } from "../../config.ts";
import { WORKFOREST_ENVIRONMENT_VARIABLES } from "../../environment.ts";
import { renderReport } from "../../terminal/report.ts";
import type { WorkspaceConfig } from "../../types.ts";
import { type LoadedAiProvider, loadAiProviders } from "./providers.ts";

export const DEFAULT_AI_TIMEOUT_MS = 120_000;

export class AiUnavailableError extends Error {
  override name = "AiUnavailableError";
}

export type GenerateTextOptions = {
  prompt: string;
  cwd?: string;
  provider?: string;
  model?: string;
  category?: AiModelCategory;
  outputSchema?: Record<string, unknown>;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  config?: WorkspaceConfig;
  onEvent?: (event: AiProgressEvent) => void;
};

export type GenerateJsonOptions<T> = GenerateTextOptions & {
  onRawText?: (text: string) => Promise<void> | void;
  validate?: (value: unknown) => T;
};

export type AiProviderStatus = {
  id: string;
  label: string;
  priority: number;
  capabilities: string[];
  available: boolean;
  selected: boolean;
  setupHint?: string;
  reason?: string;
};

export type AiStatus = {
  disabled: boolean;
  selectedProvider: string | null;
  model?: string;
  timeoutMs: number;
  providers: AiProviderStatus[];
  setupHint?: string;
};

type AiRuntimeOptions = {
  cwd?: string;
  provider?: string;
  model?: string;
  category?: AiModelCategory;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  config?: WorkspaceConfig;
  disabled?: boolean;
};

type ResolvedAiOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  disabled: boolean;
  provider?: string;
  model?: string;
  category?: AiModelCategory;
  timeoutMs: number;
};

type ProviderInspection = {
  status: AiProviderStatus;
  loaded: LoadedAiProvider;
  availability: AiAvailability;
};

type AiInspection = {
  options: ResolvedAiOptions;
  providers: ProviderInspection[];
  selected: ProviderInspection | null;
  setupHint?: string;
};

export async function getAiStatus(
  options: AiRuntimeOptions = {},
): Promise<AiStatus> {
  const inspection = await inspectAiProviders(options);
  return toAiStatus(inspection);
}

export async function generateText(
  options: GenerateTextOptions,
): Promise<string> {
  const inspection = await inspectAiProviders(options);
  if (inspection.options.disabled) {
    throw new AiUnavailableError(
      "AI features are disabled. Unset WORKFOREST_AI_DISABLED or set ai.disabled to false.",
    );
  }

  const selected = inspection.selected;
  if (!selected) {
    throw new AiUnavailableError(
      inspection.setupHint ??
        "No usable AI provider is available. Install and authenticate Codex CLI or Claude Code.",
    );
  }

  const context = providerContext(inspection.options);
  const client = await selected.loaded.provider.create(context);
  const model = selectedModel(inspection);
  try {
    const result = await client.generateText({
      prompt: options.prompt,
      ...(model ? { model } : {}),
      ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
      timeoutMs: inspection.options.timeoutMs,
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    });
    return result.text;
  } catch (error) {
    throw new AiUnavailableError(
      formatProviderFailure(selected.loaded.provider, error),
    );
  }
}

export async function generateJson<T = unknown>(
  options: GenerateJsonOptions<T>,
): Promise<T> {
  const text = await generateText(options);
  await options.onRawText?.(text);
  const value = parseJsonText(text);
  return options.validate ? options.validate(value) : (value as T);
}

export function renderAiStatus(status: AiStatus): string {
  const selected = status.selectedProvider ?? "(none)";
  const model = status.model ?? "(provider default)";
  const providerEntries = status.providers.map((provider) => ({
    title: `${provider.label} (${provider.id})`,
    tone: provider.available ? ("success" as const) : ("pending" as const),
    description: provider.available ? "available" : "unavailable",
    details: [
      { label: "Selected", value: provider.selected ? "yes" : "no" },
      { label: "Priority", value: String(provider.priority) },
      {
        label: "Capabilities",
        value:
          provider.capabilities.length > 0
            ? provider.capabilities.join(", ")
            : "(none)",
      },
      ...(provider.setupHint
        ? [{ label: "Setup", value: provider.setupHint }]
        : []),
      ...(provider.reason ? [{ label: "Reason", value: provider.reason }] : []),
    ],
  }));

  return renderReport({
    title: "AI providers",
    sections: [
      {
        fields: [
          { label: "AI", value: status.disabled ? "disabled" : "enabled" },
          { label: "Selected", value: selected },
          { label: "Model", value: model },
          { label: "Timeout", value: `${status.timeoutMs}ms` },
          ...(status.setupHint
            ? [{ label: "Setup", value: status.setupHint }]
            : []),
        ],
      },
      {
        title: "Providers",
        entries:
          providerEntries.length > 0
            ? providerEntries
            : [
                {
                  title: "(none)",
                  description: "no provider plugins are registered",
                },
              ],
      },
    ],
  });
}

async function inspectAiProviders(
  options: AiRuntimeOptions,
): Promise<AiInspection> {
  const resolvedOptions = await resolveAiOptions(options);
  const loadedProviders = await loadAiProviders();
  const context = providerContext(resolvedOptions);
  const providers = await Promise.all(
    loadedProviders.map((loaded) => inspectProvider(loaded, context)),
  );

  let selected: ProviderInspection | null = null;
  let setupHint: string | undefined;

  if (!resolvedOptions.disabled) {
    if (resolvedOptions.provider) {
      const explicitProvider = providers.find(
        (provider) => provider.loaded.provider.id === resolvedOptions.provider,
      );
      if (!explicitProvider) {
        setupHint = `Unknown AI provider "${resolvedOptions.provider}".`;
      } else if (explicitProvider.availability.available) {
        selected = explicitProvider;
      } else {
        setupHint = explicitProvider.availability.setupHint;
      }
    } else {
      selected =
        providers.find((provider) => provider.availability.available) ?? null;
      setupHint = selected
        ? undefined
        : (providers[0]?.availability.setupHint ??
          "No AI providers are registered.");
    }
  }

  const selectedId = selected?.loaded.provider.id;
  return {
    options: resolvedOptions,
    providers: providers.map((provider) => ({
      ...provider,
      status: {
        ...provider.status,
        selected: provider.loaded.provider.id === selectedId,
      },
    })),
    selected,
    ...(setupHint ? { setupHint } : {}),
  };
}

async function inspectProvider(
  loaded: LoadedAiProvider,
  context: AiProviderContext,
): Promise<ProviderInspection> {
  let availability: AiAvailability;
  try {
    availability = await loaded.provider.detect(context);
  } catch (error) {
    availability = {
      available: false,
      setupHint: `${loaded.provider.label} detection failed: ${getErrorMessage(error)}`,
      reason: getErrorMessage(error),
    };
  }

  const status: AiProviderStatus = {
    id: loaded.provider.id,
    label: loaded.provider.label,
    priority: loaded.priority,
    capabilities: loaded.provider.capabilities,
    available: availability.available,
    selected: false,
    ...(availability.setupHint ? { setupHint: availability.setupHint } : {}),
    ...(!availability.available && availability.reason
      ? { reason: availability.reason }
      : {}),
  };

  return { loaded, availability, status };
}

async function resolveAiOptions(
  options: AiRuntimeOptions,
): Promise<ResolvedAiOptions> {
  const config = options.config ?? (await loadWorkspaceConfig()).config;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? aiSpawnEnv(cwd);

  const envProvider = readTrimmedEnv(
    WORKFOREST_ENVIRONMENT_VARIABLES.aiProvider,
    env,
  );
  const envModel = readTrimmedEnv(
    WORKFOREST_ENVIRONMENT_VARIABLES.aiModel,
    env,
  );
  const envTimeoutMs = readPositiveIntegerEnv(
    WORKFOREST_ENVIRONMENT_VARIABLES.aiTimeoutMs,
    env,
  );
  const envDisabled = readBooleanEnv(
    WORKFOREST_ENVIRONMENT_VARIABLES.aiDisabled,
    env,
  );

  const provider = options.provider ?? envProvider ?? config.ai?.provider;
  const model = options.model ?? envModel ?? config.ai?.model;
  const timeoutMs =
    options.timeoutMs ??
    envTimeoutMs ??
    config.ai?.timeoutMs ??
    DEFAULT_AI_TIMEOUT_MS;
  const disabled =
    options.disabled ?? envDisabled ?? config.ai?.disabled ?? false;

  return {
    cwd,
    env,
    disabled,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(options.category ? { category: options.category } : {}),
    timeoutMs,
  };
}

function providerContext(options: ResolvedAiOptions): AiProviderContext {
  return {
    cwd: options.cwd,
    env: options.env,
    ...(options.model ? { model: options.model } : {}),
    timeoutMs: options.timeoutMs,
  };
}

function aiSpawnEnv(cwd: string): NodeJS.ProcessEnv {
  const env = createSpawnEnv(cwd) ?? { ...process.env, PWD: cwd };
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key in env) {
      continue;
    }
    if (isAiEnvironmentVariable(key)) {
      env[key] = value;
    }
  }
  return env;
}

function isAiEnvironmentVariable(key: string): boolean {
  return (
    key.startsWith("WORKFOREST_AI_") ||
    key.startsWith("ANTHROPIC_") ||
    key.startsWith("CLAUDE_") ||
    key.startsWith("CODEX_") ||
    key.startsWith("OPENAI_")
  );
}

function readTrimmedEnv(
  name: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const value = env[name];
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPositiveIntegerEnv(
  name: string,
  env: NodeJS.ProcessEnv,
): number | undefined {
  const value = readTrimmedEnv(name, env);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function readBooleanEnv(
  name: string,
  env: NodeJS.ProcessEnv,
): boolean | undefined {
  const value = readTrimmedEnv(name, env);
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`${name} must be true or false.`);
}

function toAiStatus(inspection: AiInspection): AiStatus {
  const model = selectedModel(inspection);
  return {
    disabled: inspection.options.disabled,
    selectedProvider: inspection.selected?.loaded.provider.id ?? null,
    ...(model ? { model } : {}),
    timeoutMs: inspection.options.timeoutMs,
    providers: inspection.providers.map((provider) => provider.status),
    ...(inspection.setupHint ? { setupHint: inspection.setupHint } : {}),
  };
}

function selectedModel(inspection: AiInspection): string | undefined {
  if (inspection.options.model) return inspection.options.model;
  const category = inspection.options.category;
  if (category && inspection.selected) {
    return inspection.selected.loaded.provider.modelCategories[category];
  }
  return undefined;
}

function formatProviderFailure(
  provider: AiProviderDefinition,
  error: unknown,
): string {
  return `${provider.label} failed: ${getErrorMessage(error)}`;
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new Error(
      `AI provider returned invalid JSON: ${getErrorMessage(error)}`,
    );
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
