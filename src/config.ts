import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  RepoConfig,
  ResolvedWorkspaceConfig,
  WorkspaceConfig,
} from "./types.ts";
import { ensureDir, pathExists } from "./utils/fs.ts";

const DEFAULT_TRUNK_BRANCH = "main";
const DEFAULT_DIR_PREFIX = "";
const CONFIG_FILENAME = "config.json";
const LEGACY_CONFIG_DIR = ".workforest";
const XDG_CONFIG_DIR = "workforest";

const DEFAULT_CONFIG: Required<
  Pick<
    WorkspaceConfig,
    "dirPrefix" | "branchPrefix" | "defaultRepos" | "aliases"
  >
> = {
  dirPrefix: DEFAULT_DIR_PREFIX,
  branchPrefix: "",
  defaultRepos: [],
  aliases: {},
};

type RepoSlug = {
  org: string;
  repo: string;
  slug: string;
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

export function resolveRepositories(
  selections: readonly string[],
  config: WorkspaceConfig,
): RepoConfig[] {
  const tokens =
    selections.length > 0 ? selections : (config.defaultRepos ?? []);
  const aliases = config.aliases ?? {};
  const resolved: RepoConfig[] = [];
  const seen = new Set<string>();
  const names = new Map<string, string>();

  for (const token of tokens) {
    expandToken(token);
  }

  if (resolved.length === 0) {
    throw new Error(
      "No repositories selected. Provide org/repo entries or alias names to continue.",
    );
  }

  return resolved;

  function expandToken(token: string): void {
    const normalized = token.trim();
    if (!normalized) {
      return;
    }

    if (normalized.startsWith("@")) {
      const aliasRepos = aliases[normalized];
      if (!aliasRepos) {
        const availableAliases = Object.keys(aliases);
        const suffix =
          availableAliases.length > 0
            ? `Known aliases: ${availableAliases.join(", ")}.`
            : "No aliases are currently defined.";
        throw new Error(`Unknown repo alias "${normalized}". ${suffix}`);
      }
      for (const repoToken of aliasRepos) {
        addRepoToken(repoToken, normalized);
      }
      return;
    }

    addRepoToken(normalized);
  }

  function addRepoToken(repoToken: string, source?: string): void {
    const parsed = parseRepoSlug(repoToken);
    if (!parsed) {
      const origin = source ? `expanded from alias "${source}" ` : "";
      throw new Error(
        `Invalid repository token "${repoToken}" ${origin}— expected "org/repo".`,
      );
    }

    const { slug, org, repo } = parsed;
    const existingSlug = names.get(repo);
    if (existingSlug && existingSlug !== slug) {
      throw new Error(
        `Repository name "${repo}" is ambiguous (seen ${existingSlug} and ${slug}). Use aliases to avoid collisions.`,
      );
    }

    if (seen.has(slug)) {
      return;
    }

    names.set(repo, slug);
    seen.add(slug);
    resolved.push(createRepoConfig(org, repo));
  }
}

export function getConfigPaths(): {
  xdgPath: string;
  legacyPath: string;
  preferredPath: string;
} {
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

  const config = value as WorkspaceConfig;
  const dirPrefix = normalizeString(config.dirPrefix) ?? DEFAULT_DIR_PREFIX;
  const branchPrefix = normalizeString(config.branchPrefix) ?? "";
  const defaultDir = normalizeString(config.defaultDir);
  const defaultRepos = normalizeRepoTokens(
    config.defaultRepos ?? [],
    configPath,
    "defaultRepos",
    true,
  );
  const aliases = normalizeAliases(config.aliases ?? {}, configPath);

  const result: WorkspaceConfig = {
    dirPrefix,
    branchPrefix,
    defaultRepos,
    aliases,
  };

  if (defaultDir !== undefined) {
    result.defaultDir = defaultDir;
  }

  return result;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeAliases(
  value: unknown,
  configPath: string,
): Record<string, string[]> {
  if (value === null || typeof value !== "object") {
    throw new Error(`"aliases" in ${configPath} must be an object.`);
  }

  const aliases: Record<string, string[]> = {};

  for (const [key, rawRepos] of Object.entries(value)) {
    if (!key.startsWith("@")) {
      throw new Error(`Alias "${key}" in ${configPath} must start with "@".`);
    }
    const repos = normalizeRepoTokens(rawRepos, configPath, `aliases.${key}`);
    aliases[key] = repos;
  }

  return aliases;
}

function normalizeRepoTokens(
  value: unknown,
  configPath: string,
  label: string,
  allowAliases = false,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`"${label}" in ${configPath} must be an array.`);
  }
  const tokens: string[] = [];

  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`"${label}" in ${configPath} must be strings.`);
    }
    const trimmed = item.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("@")) {
      if (!allowAliases) {
        throw new Error(
          `"${label}" in ${configPath} cannot reference alias "${trimmed}".`,
        );
      }
      tokens.push(trimmed);
      continue;
    }

    if (!parseRepoSlug(trimmed)) {
      throw new Error(
        `"${label}" in ${configPath} must use "org/repo" tokens. Received "${trimmed}".`,
      );
    }

    tokens.push(trimmed);
  }

  return tokens;
}

function parseRepoSlug(token: string): RepoSlug | null {
  const trimmed = token.trim().replace(/\.git$/i, "");
  if (!trimmed) return null;
  const parts = trimmed.split("/");
  if (parts.length !== 2) return null;
  const [org, repo] = parts.map((part) => part.trim());
  if (!org || !repo) return null;
  return { org, repo, slug: `${org}/${repo}` };
}

function createRepoConfig(org: string, repo: string): RepoConfig {
  return {
    name: repo,
    remote: `git@github.com:${org}/${repo}.git`,
    defaultBranch: DEFAULT_TRUNK_BRANCH,
  };
}
