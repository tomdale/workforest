import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathExists } from "@wf-plugin/core";
import {
  DEFAULT_WORKSPACE_CONFIG,
  normalizeWorkspaceConfig,
} from "./configuration-registry.ts";
import {
  readEnvironmentVariable,
  STANDARD_ENVIRONMENT_VARIABLES,
  WORKFOREST_ENVIRONMENT_VARIABLES,
} from "./environment.ts";
import { validateRepositoryComponent } from "./repository-components.ts";
import type {
  RepositorySource,
  ResolvedWorkspaceConfig,
  WorkspaceConfig,
} from "./types.ts";
import { ensureDir } from "./utils/fs.ts";

const CONFIG_FILENAME = "config.json";
const LEGACY_CONFIG_DIR = ".workforest";
const XDG_CONFIG_DIR = "workforest";

/**
 * Get the cache directory, respecting WORKFOREST_CACHE_DIR environment variable.
 */
export function getCacheDir(): string {
  const envCacheDir = readEnvironmentVariable(
    WORKFOREST_ENVIRONMENT_VARIABLES.cacheDir,
  );
  if (envCacheDir) {
    return envCacheDir;
  }

  const cacheHome =
    readEnvironmentVariable(STANDARD_ENVIRONMENT_VARIABLES.xdgCacheHome) ??
    path.join(os.homedir(), ".cache");
  return path.join(cacheHome, "workforest");
}

/**
 * Get the timing file path from environment variable, or null if not set.
 */
export function getTimingFilePath(): string | null {
  return (
    readEnvironmentVariable(WORKFOREST_ENVIRONMENT_VARIABLES.timingFile) ?? null
  );
}

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
      config: { ...DEFAULT_WORKSPACE_CONFIG },
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
    config: normalizeWorkspaceConfig(parsed, configPath),
  };
}

export async function saveWorkspaceConfig(
  configPath: string,
  config: WorkspaceConfig,
): Promise<void> {
  const normalized = normalizeWorkspaceConfig(config, configPath);
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
 * Convert repo inputs (org/repo slugs or git URLs) to RepositorySource objects.
 * Deduplicates by remote URL and validates format.
 *
 * Supported formats:
 * - org/repo (shorthand, defaults to GitHub SSH)
 * - git@host:path/to/repo.git (SSH)
 * - https://host/path/to/repo.git (HTTPS)
 * - ssh://git@host/path/to/repo.git (SSH URL)
 * - git://host/path/to/repo.git (Git protocol)
 */
export function reposFromSlugs(inputs: readonly string[]): RepositorySource[] {
  const resolved: RepositorySource[] = [];
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
      resolved.push({ name, remote });
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
  const envConfigDir = readEnvironmentVariable(
    WORKFOREST_ENVIRONMENT_VARIABLES.configDir,
  );
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
  const xdgHome = readEnvironmentVariable(
    STANDARD_ENVIRONMENT_VARIABLES.xdgConfigHome,
  );
  const xdgPath = xdgHome
    ? path.join(xdgHome, XDG_CONFIG_DIR, CONFIG_FILENAME)
    : "";
  const preferredPath = xdgHome ? xdgPath : legacyPath;
  return { xdgPath, legacyPath, preferredPath };
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
    const repositoryName = pathParts.at(-1);
    if (!repositoryName) return null;
    for (const part of pathParts.slice(0, -1)) {
      if (!isSafeGitRemotePathComponent(part)) {
        return null;
      }
    }
    validateRepositoryComponent(repositoryName, "Repository name");
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

function isSafeGitRemotePathComponent(value: string): boolean {
  if (value === "" || value === "." || value === "..") {
    return false;
  }
  if (value.includes("/") || value.includes("\\")) {
    return false;
  }
  return ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function createRepoConfig(org: string, repo: string): RepositorySource {
  return {
    name: repo,
    remote: `git@github.com:${org}/${repo}.git`,
  };
}
