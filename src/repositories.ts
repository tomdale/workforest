import { promises as fs } from "node:fs";
import path from "node:path";
import { getCacheDir } from "./config.ts";
import { runGit } from "./services/git.ts";
import { pathExists } from "./utils/fs.ts";

type RegisteredRepository = {
  name: string;
  slug: string;
};

export class RegisteredRepositoryNameCollisionError extends Error {
  readonly repositoryName: string;
  readonly slugs: string[];

  constructor(repositoryName: string, slugs: string[]) {
    super(
      `Repository shorthand "${repositoryName}" has a naming collision: multiple registered repositories match (${slugs.join(", ")}). Use a fully qualified org/repo.`,
    );
    this.name = "RegisteredRepositoryNameCollisionError";
    this.repositoryName = repositoryName;
    this.slugs = slugs;
  }
}

export async function resolveRegisteredRepository(
  repositoryName: string,
): Promise<string | null> {
  const normalizedName = repositoryName.trim().toLowerCase();
  if (!normalizedName) {
    return null;
  }

  const repositories = await listRegisteredRepositories();
  const matches = repositories.filter(
    (repository) => repository.name.toLowerCase() === normalizedName,
  );

  if (matches.length === 0) {
    return null;
  }

  const slugs = [
    ...new Map(
      matches.map((repository) => [
        repository.slug.toLowerCase(),
        repository.slug,
      ]),
    ).values(),
  ].sort((a, b) => a.localeCompare(b));

  if (slugs.length > 1) {
    throw new RegisteredRepositoryNameCollisionError(repositoryName, slugs);
  }

  return slugs[0] ?? null;
}

async function listRegisteredRepositories(): Promise<RegisteredRepository[]> {
  const cacheDir = getCacheDir();
  if (!(await pathExists(cacheDir))) {
    return [];
  }

  const entries = await fs.readdir(cacheDir, { withFileTypes: true });
  const repositories = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(".git"))
      .map(async (entry) => {
        const mirrorDir = path.join(cacheDir, entry.name);

        try {
          const { stdout } = await runGit(
            ["config", "--get", "remote.origin.url"],
            { cwd: mirrorDir },
          );
          return parseGitHubRepository(stdout.trim());
        } catch {
          return null;
        }
      }),
  );

  return repositories.filter(
    (repository): repository is RegisteredRepository => repository !== null,
  );
}

function parseGitHubRepository(remote: string): RegisteredRepository | null {
  const sshMatch = remote.match(
    /^(?:[^@]+@)?github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
  );
  if (sshMatch?.[1] && sshMatch[2]) {
    return createRegisteredRepository(sshMatch[1], sshMatch[2]);
  }

  let parsed: URL;
  try {
    parsed = new URL(remote);
  } catch {
    return null;
  }

  if (parsed.hostname.toLowerCase() !== "github.com") {
    return null;
  }

  const parts = parsed.pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .split("/");
  if (parts.length !== 2) {
    return null;
  }

  const [org, repo] = parts;
  if (!org || !repo) {
    return null;
  }

  return createRegisteredRepository(org, repo);
}

function createRegisteredRepository(
  org: string,
  repo: string,
): RegisteredRepository {
  return {
    name: repo,
    slug: `${org}/${repo}`,
  };
}
