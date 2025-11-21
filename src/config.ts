import type { RepoConfig } from "./types.ts";

const DEFAULT_GITHUB_ORG = "vercel";
const DEFAULT_TRUNK_BRANCH = "main";

const REPO_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze(
  {
    "@dashboard": ["front", "api"],
  } satisfies Record<string, readonly string[]>,
);

const DEFAULT_REPO_TOKENS = Object.freeze(["@dashboard"]);

export function getRepoAliases(): Readonly<Record<string, readonly string[]>> {
  return REPO_ALIASES;
}

export function getDefaultRepoTokens(): readonly string[] {
  return DEFAULT_REPO_TOKENS;
}

export function resolveRepositories(
  selections: readonly string[],
): RepoConfig[] {
  const tokens = selections.length > 0 ? selections : DEFAULT_REPO_TOKENS;
  const resolved: RepoConfig[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    expandToken(token);
  }

  if (resolved.length === 0) {
    throw new Error(
      "No repositories selected. Provide repo names or aliases to continue.",
    );
  }

  return resolved;

  function expandToken(token: string): void {
    if (token.startsWith("@")) {
      const aliasRepos = REPO_ALIASES[token];
      if (!aliasRepos) {
        const availableAliases = Object.keys(REPO_ALIASES);
        const suffix =
          availableAliases.length > 0
            ? `Known aliases: ${availableAliases.join(", ")}.`
            : "No aliases are currently defined.";
        throw new Error(`Unknown repo alias "${token}". ${suffix}`);
      }

      for (const repoName of aliasRepos) {
        addRepoByName(repoName, token);
      }
      return;
    }

    addRepoByName(token);
  }

  function addRepoByName(repoName: string, source?: string): void {
    const normalized = repoName.trim();
    if (!normalized) {
      const origin = source ? `expanded from alias "${source}" ` : "";
      throw new Error(`Empty repository name ${origin}is not allowed.`);
    }

    if (normalized.startsWith("@")) {
      throw new Error(
        `Repository names cannot start with "@": received "${normalized}".`,
      );
    }

    if (normalized.includes("/")) {
      throw new Error(
        `Repository name "${normalized}" must not contain "/". All repositories are assumed to live under github.com/${DEFAULT_GITHUB_ORG}/<name>.`,
      );
    }

    if (seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    resolved.push(createRepoConfig(normalized));
  }
}

function createRepoConfig(name: string): RepoConfig {
  return {
    name,
    remote: `git@github.com:${DEFAULT_GITHUB_ORG}/${name}.git`,
    defaultBranch: DEFAULT_TRUNK_BRANCH,
  };
}
