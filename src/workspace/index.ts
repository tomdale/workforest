import os from "node:os";
import path from "node:path";
import { log } from "../logger.ts";
import { getGitHubSlug } from "../services/git.ts";
import { fetchRepoDiskUsage } from "../services/github.ts";
import {
  installDependenciesIfNeeded,
  turboLinkIfNeeded,
} from "../services/pnpm.ts";
import type { RepoConfig } from "../types.ts";
import { ensureDir } from "../utils/fs.ts";
import { ensureMirrorRepo, ensureWorkingCopy } from "./repository.ts";

type StampWorkspaceOptions = {
  featureName: string;
  workspaceDir: string;
  repos: readonly RepoConfig[];
};

export async function stampWorkspace({
  featureName,
  workspaceDir,
  repos,
}: StampWorkspaceOptions): Promise<void> {
  if (repos.length === 0) {
    throw new Error("stampWorkspace requires at least one repository.");
  }

  const cacheDir = await ensureCacheDir();
  await ensureDir(workspaceDir);
  log.info(`Stamping workspace for "${featureName}" at ${workspaceDir}`);
  log.info(
    `Preparing repositories: ${repos.map((repo) => repo.name).join(", ")}`,
  );

  await warnAboutLargeRepositories(repos);

  await Promise.all(
    repos.map((repo) => stampRepository(repo, cacheDir, workspaceDir)),
  );

  log.success("Workspace ready.");
}

async function stampRepository(
  repo: RepoConfig,
  cacheDir: string,
  workspaceDir: string,
): Promise<void> {
  const mirrorDir = path.join(cacheDir, `${repo.name}.git`);
  await ensureMirrorRepo(repo, mirrorDir);

  const targetDir = path.join(workspaceDir, repo.name);
  await ensureWorkingCopy(repo, mirrorDir, targetDir);

  await installDependenciesIfNeeded(repo, targetDir);
  await turboLinkIfNeeded(repo, targetDir);
}

async function ensureCacheDir(): Promise<string> {
  const cacheHome =
    process.env["XDG_CACHE_HOME"] ?? path.join(os.homedir(), ".cache");
  const cacheRoot = path.join(cacheHome, "vercel-workspace");
  await ensureDir(cacheRoot);
  return cacheRoot;
}

const LARGE_REPO_THRESHOLD_MB = 500;

async function warnAboutLargeRepositories(
  repos: readonly RepoConfig[],
): Promise<void> {
  await Promise.all(
    repos.map(async (repo) => {
      const slug = getGitHubSlug(repo.remote);
      if (!slug) {
        return;
      }

      const sizeBytes = await fetchRepoDiskUsage(slug);
      if (sizeBytes === null) {
        return;
      }

      const sizeMB = sizeBytes / (1024 * 1024);
      if (sizeMB >= LARGE_REPO_THRESHOLD_MB) {
        const sizeString = sizeMB.toFixed(1);
        log.warn(
          `Repository ${repo.name} is approximately ${sizeString} MB and may take a while to mirror.`,
        );
      }
    }),
  );
}
