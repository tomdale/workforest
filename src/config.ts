import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateRepositoryComponent } from "./repository-components.ts";
import type {
  RepoConfig,
  ResolvedWorkspaceConfig,
  VercelLinkConfig,
  VercelRepoOverride,
  WorkspaceConfig,
} from "./types.ts";
import { normalizeBranchPrefix } from "./utils/branch-prefix.ts";
import { ensureDir, pathExists } from "./utils/fs.ts";

const DEFAULT_TRUNK_BRANCH = "main";
const DEFAULT_DIR_PREFIX = "";
const CONFIG_FILENAME = "config.json";
const LEGACY_CONFIG_DIR = ".workforest";
const XDG_CONFIG_DIR = "workforest";

// Environment variable overrides for testing and benchmarking
const ENV_CACHE_DIR = "WORKFOREST_CACHE_DIR";
const ENV_CONFIG_DIR = "WORKFOREST_CONFIG_DIR";
const ENV_TIMING_FILE = "WORKFOREST_TIMING_FILE";

export const DEFAULT_VERCEL_TEAM_BY_GITHUB_OWNER: Record<string, string> = {
  vercel: "vercel",
  "vercel-labs": "vercel-labs",
};

/**
 * Get the cache directory, respecting WORKFOREST_CACHE_DIR environment variable.
 */
export function getCacheDir(): string {
  const envCacheDir = process.env[ENV_CACHE_DIR];
  if (envCacheDir) {
    return envCacheDir;
  }

  const cacheHome =
    process.env["XDG_CACHE_HOME"] ?? path.join(os.homedir(), ".cache");
  return path.join(cacheHome, "workforest");
}

/**
 * Get the timing file path from environment variable, or null if not set.
 */
export function getTimingFilePath(): string | null {
  return process.env[ENV_TIMING_FILE] ?? null;
}

const DEFAULT_CONFIG: Required<
  Pick<WorkspaceConfig, "dirPrefix" | "branchPrefix">
> = {
  dirPrefix: DEFAULT_DIR_PREFIX,
  branchPrefix: "",
};

type RepoSlug = {
  org: string;
  repo: string;
  slug: string;
};

type ParsedGitUrl = {
  name: string;
  remote: string;
};

export async function loadWorkspaceConfig(): Promise<ResolvedWorkspaceConfig> {
  const { xdgPath, legacyPath, preferredPath } = getConfigPaths();
  const [xdgExists, legacyExists] = await Promise.all([
    xdgPath ? pathExists(xdgPath) : Promise.resolve(false),
    pathExists(legacyPath),
  ]);

  let configPath: string;
  if (xdgExists && xdgPath) {
    configPath = xdgPath;
  } else if (legacyExists) {
    configPath = legacyPath;
  } else {
    configPath = preferredPath;
  }

  const fileExists = await pathExists(configPath);
  if (!fileExists) {
    return {
      path: configPath,
      config: { ...DEFAULT_CONFIG },
    };
  }

  const raw = await fs.readFile(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error_) {
    throw new Error(
      `Unable to parse workspace config at ${configPath}: ${String(error_)}`,
    );
  }

  return {
    path: configPath,
    config: normalizeConfig(parsed, configPath),
  };
}

export async function saveWorkspaceConfig(
  configPath: string,
  config: WorkspaceConfig,
): Promise<void> {
  const normalized = normalizeConfig(config, configPath);
  await ensureDir(path.dirname(configPath));
  const contents = JSON.stringify(normalized, null, 2);
  await fs.writeFile(configPath, `${contents}\n`, "utf8");
}

/**
 * Check if a string looks like a repo reference (org/repo slug or git URL).
 */
export function isRepoSlug(token: string): boolean {
  return parseRepoSlug(token) !== null || parseGitUrl(token) !== null;
}

/**
 * Convert repo inputs (org/repo slugs or git URLs) to RepoConfig objects.
 * Deduplicates by remote URL and validates format.
 *
 * Supported formats:
 * - org/repo (shorthand, defaults to GitHub SSH)
 * - git@host:path/to/repo.git (SSH)
 * - https://host/path/to/repo.git (HTTPS)
 * - ssh://git@host/path/to/repo.git (SSH URL)
 * - git://host/path/to/repo.git (Git protocol)
 */
export function reposFromSlugs(inputs: readonly string[]): RepoConfig[] {
  const resolved: RepoConfig[] = [];
  const seenRemotes = new Set<string>();
  const names = new Map<string, string>();

  for (const token of inputs) {
    const normalized = token.trim();
    if (!normalized) continue;

    // Try parsing as a full git URL first
    const urlParsed = parseGitUrl(normalized);
    if (urlParsed) {
      const { name, remote } = urlParsed;
      const existingRemote = names.get(name);
      if (existingRemote && existingRemote !== remote) {
        throw new Error(
          `Repository name "${name}" is ambiguous (seen from different remotes).`,
        );
      }

      if (seenRemotes.has(remote)) continue;

      names.set(name, remote);
      seenRemotes.add(remote);
      resolved.push({
        name,
        remote,
        defaultBranch: DEFAULT_TRUNK_BRANCH,
      });
      continue;
    }

    // Try parsing as org/repo shorthand
    const slugParsed = parseRepoSlug(normalized);
    if (slugParsed) {
      const { slug, org, repo } = slugParsed;
      const repoConfig = createRepoConfig(org, repo);
      const existingRemote = names.get(repo);
      if (existingRemote && existingRemote !== repoConfig.remote) {
        throw new Error(
          `Repository name "${repo}" is ambiguous (seen ${existingRemote} and ${slug}).`,
        );
      }

      if (seenRemotes.has(repoConfig.remote)) continue;

      names.set(repo, repoConfig.remote);
      seenRemotes.add(repoConfig.remote);
      resolved.push(repoConfig);
      continue;
    }

    throw new Error(
      `Invalid repository "${normalized}" — expected "org/repo" or a git URL.`,
    );
  }

  return resolved;
}

export function getConfigPaths(): {
  xdgPath: string;
  legacyPath: string;
  preferredPath: string;
} {
  // Check for WORKFOREST_CONFIG_DIR environment variable override first
  const envConfigDir = process.env[ENV_CONFIG_DIR];
  if (envConfigDir) {
    const overridePath = path.join(envConfigDir, CONFIG_FILENAME);
    return {
      xdgPath: overridePath,
      legacyPath: overridePath,
      preferredPath: overridePath,
    };
  }

  const homeDir = os.homedir();
  const legacyPath = path.join(homeDir, LEGACY_CONFIG_DIR, CONFIG_FILENAME);
  const xdgHome = process.env["XDG_CONFIG_HOME"];
  const xdgPath = xdgHome
    ? path.join(xdgHome, XDG_CONFIG_DIR, CONFIG_FILENAME)
    : "";
  const preferredPath = xdgHome ? xdgPath : legacyPath;
  return { xdgPath, legacyPath, preferredPath };
}

function normalizeConfig(value: unknown, configPath: string): WorkspaceConfig {
  if (value === null || typeof value !== "object") {
    throw new Error(`Workspace config at ${configPath} must be a JSON object.`);
  }

  const config = value as Record<string, unknown>;
  const dirPrefix = normalizeString(config["dirPrefix"]) ?? DEFAULT_DIR_PREFIX;
  const branchPrefix =
    normalizeBranchPrefix(normalizeString(config["branchPrefix"])) ?? "";
  const defaultDir = normalizeString(config["defaultDir"]);
  const reviewsDir = normalizeString(config["reviewsDir"]);
  const vercelLink = normalizeVercelLinkConfig(
    config["vercelLink"],
    `${configPath}.vercelLink`,
  );

  const result: WorkspaceConfig = {
    dirPrefix,
    branchPrefix,
  };

  if (defaultDir !== undefined) {
    result.defaultDir = defaultDir;
  }

  if (reviewsDir !== undefined) {
    result.reviewsDir = reviewsDir;
  }

  if (vercelLink !== undefined) {
    result.vercelLink = vercelLink;
  }

  return result;
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

function parseRepoSlug(token: string): RepoSlug | null {
  const trimmed = token.trim().replace(/\.git$/i, "");
  if (!trimmed) return null;

  // Don't match if it looks like a URL
  if (
    trimmed.includes("://") ||
    trimmed.includes("@") ||
    trimmed.startsWith("git:")
  ) {
    return null;
  }

  const parts = trimmed.split("/");
  if (parts.length !== 2) return null;
  try {
    const org = validateRepositoryComponent(
      parts[0]?.trim() ?? "",
      "Repository owner",
    );
    const repo = validateRepositoryComponent(
      parts[1]?.trim() ?? "",
      "Repository name",
    );
    return { org, repo, slug: `${org}/${repo}` };
  } catch {
    return null;
  }
}

/**
 * Parse a full git URL and extract the repository name.
 *
 * Supported formats:
 * - git@host:path/to/repo.git (SSH)
 * - https://host/path/to/repo.git (HTTPS)
 * - http://host/path/to/repo.git (HTTP)
 * - ssh://git@host/path/to/repo.git (SSH URL)
 * - git://host/path/to/repo.git (Git protocol)
 */
function parseGitUrl(token: string): ParsedGitUrl | null {
  const trimmed = token.trim();
  if (!trimmed) return null;

  let remote = trimmed;
  let repoPath: string | null = null;

  // SSH format: git@host:org/repo.git
  const sshMatch = trimmed.match(/^[\w-]+@[\w.-]+:(.+)$/);
  if (sshMatch?.[1]) {
    repoPath = sshMatch[1];
  }

  // URL formats: https://, http://, ssh://, git://
  if (!repoPath) {
    const urlMatch = trimmed.match(/^(?:https?|ssh|git):\/\/[^/]+\/(.+)$/);
    if (urlMatch?.[1]) {
      repoPath = urlMatch[1];
    }
  }

  if (!repoPath) return null;

  // Extract repo name from path (last component, without .git)
  let pathParts: string[];
  try {
    pathParts = repoPath
      .replace(/\.git$/i, "")
      .split("/")
      .map((part) => decodeURIComponent(part));
    if (pathParts.length < 2) return null;
    for (const [index, part] of pathParts.entries()) {
      validateRepositoryComponent(
        part,
        index === pathParts.length - 1 ? "Repository name" : "Repository owner",
      );
    }
  } catch {
    return null;
  }
  const name = pathParts.at(-1);
  if (!name) return null;

  // Normalize remote to include .git suffix for consistency
  if (!remote.endsWith(".git")) {
    remote = `${remote}.git`;
  }

  return { name, remote };
}

function createRepoConfig(org: string, repo: string): RepoConfig {
  return {
    name: repo,
    remote: `git@github.com:${org}/${repo}.git`,
    defaultBranch: DEFAULT_TRUNK_BRANCH,
  };
}
