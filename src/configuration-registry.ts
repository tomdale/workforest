import type {
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
  dirPrefix: string;
  branchPrefix: string;
} = {
  directory: {
    base: "~/Code",
    repos: "Repos",
    workspaces: "Workspaces",
    reviews: "Reviews",
  },
  dirPrefix: "",
  branchPrefix: "",
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
        description: "Directory for single-repository changes.",
        defaultBehavior:
          "Repos. Relative values resolve against directory.base.",
      },
      {
        key: "workspaces",
        type: "string (path)",
        description: "Directory for template and _adhoc workspace changes.",
        defaultBehavior:
          "Workspaces. Relative values resolve against directory.base.",
      },
      {
        key: "reviews",
        type: "string (path)",
        description: "Directory for pull request review checkouts.",
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
      "Unset. Built-in owner mappings still apply for vercel and vercel-labs.",
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
          "No custom mappings. Built-in mappings cover vercel and vercel-labs.",
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
  Object.assign(result, normalizeLegacyConfigFields(source));

  return result;
}

function normalizeLegacyConfigFields(
  source: Record<string, unknown>,
): Readonly<Partial<WorkspaceConfig>> {
  const defaultDir = normalizeString(source["defaultDir"]);
  const reviewsDir = normalizeString(source["reviewsDir"]);
  return {
    ...(defaultDir ? { defaultDir } : {}),
    ...(reviewsDir ? { reviewsDir } : {}),
    dirPrefix:
      normalizeString(source["dirPrefix"]) ??
      DEFAULT_WORKSPACE_CONFIG.dirPrefix,
  };
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
