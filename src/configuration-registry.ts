import type {
  AiConfig,
  CacheConfig,
  CloudConfig,
  NodeModulesCacheConfig,
  VercelCloudConfig,
  VercelLinkConfig,
  VercelRepoOverride,
  WorkforestDirectoryConfig,
  WorkspaceConfig,
} from "./types.ts";

export type ConfigurationFieldDefinition = Readonly<{
  key: keyof WorkspaceConfig;
  type: string;
  description: string;
  defaultBehavior: string;
  example: unknown;
  children?: readonly ConfigurationChildFieldDefinition[];
  normalize: (
    value: unknown,
    pathLabel: string,
  ) => Readonly<Partial<WorkspaceConfig>>;
}>;

export type ConfigurationChildFieldDefinition = Readonly<{
  key: string;
  type: string;
  description: string;
  defaultBehavior: string;
}>;

export const DEFAULT_WORKSPACE_CONFIG: {
  directory: Required<WorkforestDirectoryConfig>;
  branchPrefix: string;
  cache: { nodeModules: Required<NodeModulesCacheConfig> };
} = {
  directory: {
    base: "~/Code",
    repos: "Repos",
    workspaces: "Workspaces",
    reviews: "Reviews",
  },
  branchPrefix: "",
  cache: {
    nodeModules: {
      enabled: true,
      maxRetainedPerRepo: 3,
    },
  },
};

/*
 * The global config schema owns both normalization and reference metadata.
 * Keeping those together prevents accepted values and generated documentation
 * from drifting as fields are added or renamed.
 */
export const CONFIGURATION_REGISTRY: readonly ConfigurationFieldDefinition[] = [
  {
    key: "directory",
    type: "object",
    description:
      "Human-facing Workforest directory layout. Relative child values resolve against directory.base.",
    defaultBehavior:
      "Uses ~/Code as the base, with Repos, Workspaces, and Reviews child directories.",
    example: {
      base: "~/Code",
      repos: "Repos",
      workspaces: "Workspaces",
      reviews: "Reviews",
    },
    children: [
      {
        key: "base",
        type: "string (path)",
        description: "Base directory for Workforest-managed checkouts.",
        defaultBehavior: "~/Code.",
      },
      {
        key: "repos",
        type: "string (path)",
        description: "Directory for single-repository worktrees.",
        defaultBehavior:
          "Repos. Relative values resolve against directory.base.",
      },
      {
        key: "workspaces",
        type: "string (path)",
        description: "Directory for template and _adhoc workspaces.",
        defaultBehavior:
          "Workspaces. Relative values resolve against directory.base.",
      },
      {
        key: "reviews",
        type: "string (path)",
        description: "Directory for pull request review worktrees.",
        defaultBehavior:
          "Reviews. Relative values resolve against directory.base.",
      },
    ],
    normalize: (value, pathLabel) => ({
      directory: normalizeDirectoryConfig(value, pathLabel),
    }),
  },
  {
    key: "branchPrefix",
    type: "string",
    description:
      "Global prefix added to generated feature branches. Values with or without a trailing slash are accepted.",
    defaultBehavior: 'The empty string ("").',
    example: "feature",
    normalize: (value) => ({
      branchPrefix:
        normalizeString(value) ?? DEFAULT_WORKSPACE_CONFIG.branchPrefix,
    }),
  },
  {
    key: "vercelLink",
    type: "object",
    description: "Controls automatic Vercel project linking by repository.",
    defaultBehavior:
      "Unset. GitHub owners that are valid Vercel scopes are used directly.",
    example: {
      teamByGitHubOwner: {
        vercel: "vercel",
        "vercel-labs": "vercel-labs",
      },
      repoOverrides: {
        "vercel/omniagent": {
          team: "vercel",
        },
        "vercel/internal-only": {
          disabled: true,
        },
      },
    },
    children: [
      {
        key: "teamByGitHubOwner",
        type: "object<string, string>",
        description:
          "Maps a GitHub owner to the Vercel team used for repositories from that owner.",
        defaultBehavior:
          "No custom mappings. GitHub owners that are valid Vercel scopes are used directly.",
      },
      {
        key: "repoOverrides",
        type: "object<string, { team?: string; disabled?: boolean }>",
        description:
          "Overrides the Vercel team or disables automatic linking for an owner/repository slug.",
        defaultBehavior: "No per-repository overrides.",
      },
      {
        key: "repoOverrides.<owner/repository>.team",
        type: "string",
        description: "Selects a Vercel team for one repository.",
        defaultBehavior: "Uses the owner mapping when one exists.",
      },
      {
        key: "repoOverrides.<owner/repository>.disabled",
        type: "boolean",
        description: "Disables automatic Vercel linking for one repository.",
        defaultBehavior: "false.",
      },
    ],
    normalize: (value, pathLabel) => {
      const vercelLink = normalizeVercelLinkConfig(value, pathLabel);
      return vercelLink === undefined ? {} : { vercelLink };
    },
  },
  {
    key: "cache",
    type: "object",
    description:
      "Controls Workforest-owned caches beyond bare repository mirrors.",
    defaultBehavior:
      "nodeModules pooling is enabled and retains the 3 newest installs per repository.",
    example: {
      nodeModules: {
        enabled: true,
        maxRetainedPerRepo: 3,
      },
    },
    children: [
      {
        key: "nodeModules",
        type: "object",
        description:
          "Controls the pnpm node_modules pool under the Workforest cache root.",
        defaultBehavior: "Enabled with maxRetainedPerRepo set to 3.",
      },
      {
        key: "nodeModules.enabled",
        type: "boolean",
        description:
          "Whether eligible pnpm node_modules directories are restored from and preserved into the pool.",
        defaultBehavior: "true.",
      },
      {
        key: "nodeModules.maxRetainedPerRepo",
        type: "positive integer",
        description:
          "Maximum number of pooled node_modules installs retained per repository.",
        defaultBehavior: "3.",
      },
    ],
    normalize: (value, pathLabel) => ({
      cache: normalizeCacheConfig(value, pathLabel),
    }),
  },
  {
    key: "ai",
    type: "object",
    description:
      "Controls Workforest-owned AI provider selection and generation defaults.",
    defaultBehavior:
      "Unset. Workforest auto-detects built-in providers in priority order when an AI feature requires one.",
    example: {
      provider: "codex-cli",
      model: "gpt-5",
      timeoutMs: 120000,
      disabled: false,
    },
    children: [
      {
        key: "provider",
        type: "string",
        description:
          "Selects a provider by plugin provider ID, for example codex-cli or claude-cli.",
        defaultBehavior:
          "Auto-detects available providers, preferring codex-cli then claude-cli.",
      },
      {
        key: "model",
        type: "string",
        description:
          "Passes a model name through to the selected provider when a provider supports model selection.",
        defaultBehavior: "Uses the selected provider's CLI default.",
      },
      {
        key: "timeoutMs",
        type: "positive integer",
        description: "Maximum time to wait for a single AI generation.",
        defaultBehavior: "120000.",
      },
      {
        key: "disabled",
        type: "boolean",
        description: "Disables AI-backed Workforest features.",
        defaultBehavior: "false.",
      },
    ],
    normalize: (value, pathLabel) => {
      const ai = normalizeAiConfig(value, pathLabel);
      return ai === undefined ? {} : { ai };
    },
  },
  {
    key: "cloud",
    type: "object",
    description:
      "Defaults for cloud workspaces provisioned on Vercel Sandbox (wf new --cloud).",
    defaultBehavior:
      "Unset. cloud.vercel.team and cloud.vercel.project (slugs) are required before any cloud command runs; the rest use provider defaults.",
    example: {
      vercel: {
        team: "vercel",
        project: "my-app",
        vcpus: 4,
        timeoutMs: 14400000,
        snapshotTtlMs: 86400000,
        ports: [3000],
        runtime: "node24",
      },
    },
    children: [
      {
        key: "vercel",
        type: "object",
        description: "Vercel Sandbox provider settings.",
        defaultBehavior: "Required for cloud commands (team + project).",
      },
      {
        key: "vercel.team",
        type: "string (slug)",
        description:
          "Vercel team slug that owns the sandboxes. Required for cloud commands.",
        defaultBehavior: "Unset; cloud commands error until configured.",
      },
      {
        key: "vercel.project",
        type: "string (slug)",
        description:
          "Vercel project slug to associate sandbox operations with. Required for cloud commands.",
        defaultBehavior: "Unset; cloud commands error until configured.",
      },
      {
        key: "vercel.vcpus",
        type: "positive integer",
        description: "vCPUs per sandbox (2048 MB memory per vCPU).",
        defaultBehavior: "Provider default.",
      },
      {
        key: "vercel.timeoutMs",
        type: "positive integer",
        description: "Sandbox runtime auto-terminate timeout, in milliseconds.",
        defaultBehavior: "Provider default.",
      },
      {
        key: "vercel.snapshotTtlMs",
        type: "positive integer",
        description:
          "How long a per-template base snapshot stays fresh before it is rebuilt.",
        defaultBehavior: "86400000 (24 hours).",
      },
      {
        key: "vercel.ports",
        type: "array of positive integers",
        description:
          "Ports exposed at creation so preview URLs can be resolved (max 4).",
        defaultBehavior: "[3000].",
      },
      {
        key: "vercel.runtime",
        type: "string",
        description: "Sandbox runtime image, for example node24.",
        defaultBehavior: "Provider default (node24).",
      },
    ],
    normalize: (value, pathLabel) => {
      const cloud = normalizeCloudConfig(value, pathLabel);
      return cloud === undefined ? {} : { cloud };
    },
  },
] as const;

export const CONFIGURATION_EXAMPLE: WorkspaceConfig = Object.fromEntries(
  CONFIGURATION_REGISTRY.map((field) => [field.key, field.example]),
) as WorkspaceConfig;

export function normalizeWorkspaceConfig(
  value: unknown,
  configPath: string,
): WorkspaceConfig {
  if (value === null || typeof value !== "object") {
    throw new Error(`Workspace config at ${configPath} must be a JSON object.`);
  }

  const source = value as Record<string, unknown>;
  const result: WorkspaceConfig = {};

  for (const field of CONFIGURATION_REGISTRY) {
    Object.assign(
      result,
      field.normalize(source[field.key], `${configPath}.${field.key}`),
    );
  }
  return result;
}

function normalizeDirectoryConfig(
  value: unknown,
  pathLabel: string,
): Required<WorkforestDirectoryConfig> {
  if (value === undefined) {
    return { ...DEFAULT_WORKSPACE_CONFIG.directory };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${pathLabel} must be an object.`);
  }

  const config = value as Record<string, unknown>;
  return {
    base:
      normalizeString(config["base"]) ??
      DEFAULT_WORKSPACE_CONFIG.directory.base,
    repos:
      normalizeString(config["repos"]) ??
      DEFAULT_WORKSPACE_CONFIG.directory.repos,
    workspaces:
      normalizeString(config["workspaces"]) ??
      DEFAULT_WORKSPACE_CONFIG.directory.workspaces,
    reviews:
      normalizeString(config["reviews"]) ??
      DEFAULT_WORKSPACE_CONFIG.directory.reviews,
  };
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeCacheConfig(value: unknown, pathLabel: string): CacheConfig {
  if (value === undefined) {
    return { nodeModules: { ...DEFAULT_WORKSPACE_CONFIG.cache.nodeModules } };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${pathLabel} must be an object.`);
  }

  const config = value as Record<string, unknown>;
  return {
    nodeModules: normalizeNodeModulesCacheConfig(
      config["nodeModules"],
      `${pathLabel}.nodeModules`,
    ),
  };
}

function normalizeNodeModulesCacheConfig(
  value: unknown,
  pathLabel: string,
): Required<NodeModulesCacheConfig> {
  if (value === undefined) {
    return { ...DEFAULT_WORKSPACE_CONFIG.cache.nodeModules };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${pathLabel} must be an object.`);
  }

  const config = value as Record<string, unknown>;
  return {
    enabled:
      normalizeBoolean(config["enabled"], `${pathLabel}.enabled`) ??
      DEFAULT_WORKSPACE_CONFIG.cache.nodeModules.enabled,
    maxRetainedPerRepo:
      normalizePositiveInteger(
        config["maxRetainedPerRepo"],
        `${pathLabel}.maxRetainedPerRepo`,
      ) ?? DEFAULT_WORKSPACE_CONFIG.cache.nodeModules.maxRetainedPerRepo,
  };
}

function normalizeVercelLinkConfig(
  value: unknown,
  pathLabel: string,
): VercelLinkConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${pathLabel} must be an object.`);
  }

  const config = value as Record<string, unknown>;
  const teamByGitHubOwner = normalizeStringRecord(
    config["teamByGitHubOwner"],
    `${pathLabel}.teamByGitHubOwner`,
  );
  const repoOverrides = normalizeRepoOverrides(
    config["repoOverrides"],
    `${pathLabel}.repoOverrides`,
  );

  const result: VercelLinkConfig = {};
  if (teamByGitHubOwner && Object.keys(teamByGitHubOwner).length > 0) {
    result.teamByGitHubOwner = teamByGitHubOwner;
  }
  if (repoOverrides && Object.keys(repoOverrides).length > 0) {
    result.repoOverrides = repoOverrides;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeAiConfig(
  value: unknown,
  pathLabel: string,
): AiConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${pathLabel} must be an object.`);
  }

  const config = value as Record<string, unknown>;
  const result: AiConfig = {};
  const provider = normalizeString(config["provider"]);
  const model = normalizeString(config["model"]);
  const timeoutMs = normalizePositiveInteger(
    config["timeoutMs"],
    `${pathLabel}.timeoutMs`,
  );
  const disabled = normalizeBoolean(
    config["disabled"],
    `${pathLabel}.disabled`,
  );

  if (provider !== undefined) result.provider = provider;
  if (model !== undefined) result.model = model;
  if (timeoutMs !== undefined) result.timeoutMs = timeoutMs;
  if (disabled !== undefined) result.disabled = disabled;

  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeCloudConfig(
  value: unknown,
  pathLabel: string,
): CloudConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${pathLabel} must be an object.`);
  }

  const config = value as Record<string, unknown>;
  const vercel = normalizeVercelCloudConfig(
    config["vercel"],
    `${pathLabel}.vercel`,
  );
  return vercel === undefined ? undefined : { vercel };
}

function normalizeVercelCloudConfig(
  value: unknown,
  pathLabel: string,
): VercelCloudConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${pathLabel} must be an object.`);
  }

  const config = value as Record<string, unknown>;
  const result: VercelCloudConfig = {};
  const team = normalizeString(config["team"]);
  const project = normalizeString(config["project"]);
  const vcpus = normalizePositiveInteger(config["vcpus"], `${pathLabel}.vcpus`);
  const timeoutMs = normalizePositiveInteger(
    config["timeoutMs"],
    `${pathLabel}.timeoutMs`,
  );
  const snapshotTtlMs = normalizePositiveInteger(
    config["snapshotTtlMs"],
    `${pathLabel}.snapshotTtlMs`,
  );
  const ports = normalizeNumberArray(config["ports"], `${pathLabel}.ports`);
  const runtime = normalizeString(config["runtime"]);

  if (team !== undefined) result.team = team;
  if (project !== undefined) result.project = project;
  if (vcpus !== undefined) result.vcpus = vcpus;
  if (timeoutMs !== undefined) result.timeoutMs = timeoutMs;
  if (snapshotTtlMs !== undefined) result.snapshotTtlMs = snapshotTtlMs;
  if (ports !== undefined) result.ports = ports;
  if (runtime !== undefined) result.runtime = runtime;

  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeNumberArray(
  value: unknown,
  pathLabel: string,
): number[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${pathLabel} must be an array of positive integers.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry <= 0) {
      throw new Error(`${pathLabel}[${index}] must be a positive integer.`);
    }
    return entry;
  });
}

function normalizePositiveInteger(
  value: unknown,
  pathLabel: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${pathLabel} must be a positive integer.`);
  }
  return value;
}

function normalizeBoolean(
  value: unknown,
  pathLabel: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${pathLabel} must be a boolean.`);
  }
  return value;
}

function normalizeStringRecord(
  value: unknown,
  pathLabel: string,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${pathLabel} must be an object.`);
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.trim();
    const normalizedValue = normalizeString(entry);
    if (!normalizedKey) {
      throw new Error(`${pathLabel} contains an empty key.`);
    }
    if (normalizedValue === undefined) {
      throw new Error(`${pathLabel}.${normalizedKey} must be a string.`);
    }
    result[normalizedKey] = normalizedValue;
  }

  return result;
}

function normalizeRepoOverrides(
  value: unknown,
  pathLabel: string,
): Record<string, VercelRepoOverride> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${pathLabel} must be an object.`);
  }

  const result: Record<string, VercelRepoOverride> = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      throw new Error(`${pathLabel} contains an empty key.`);
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${pathLabel}.${normalizedKey} must be an object.`);
    }

    const override = entry as Record<string, unknown>;
    const team = normalizeString(override["team"]);
    const disabledValue = override["disabled"];
    if (disabledValue !== undefined && typeof disabledValue !== "boolean") {
      throw new Error(
        `${pathLabel}.${normalizedKey}.disabled must be a boolean.`,
      );
    }
    if (override["team"] !== undefined && team === undefined) {
      throw new Error(`${pathLabel}.${normalizedKey}.team must be a string.`);
    }

    const normalizedOverride: VercelRepoOverride = {};
    if (team !== undefined) {
      normalizedOverride.team = team;
    }
    if (disabledValue !== undefined) {
      normalizedOverride.disabled = disabledValue;
    }
    result[normalizedKey] = normalizedOverride;
  }

  return result;
}
