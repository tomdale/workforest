import { promises as fs } from "node:fs";
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
import {
  cleanupWorkspaceWorktrees,
  ensureMirrorRepo,
  ensureWorkingCopy,
} from "./repository.ts";

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

  for (const repo of repos) {
    await stampRepository(repo, cacheDir, workspaceDir, featureName);
  }

  await writeVSCodeWorkspaceFile(workspaceDir, repos);
  log.success("Workspace ready.");
}

async function stampRepository(
  repo: RepoConfig,
  cacheDir: string,
  workspaceDir: string,
  featureName: string,
): Promise<void> {
  const mirrorDir = path.join(cacheDir, `${repo.name}.git`);
  await ensureMirrorRepo(repo, mirrorDir);

  const targetDir = path.join(workspaceDir, repo.name);
  await cleanupWorkspaceWorktrees(mirrorDir, workspaceDir);
  await ensureWorkingCopy(repo, mirrorDir, targetDir, featureName);

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

async function writeVSCodeWorkspaceFile(
  workspaceDir: string,
  repos: readonly RepoConfig[],
): Promise<void> {
  const workspaceName = path.basename(workspaceDir) || "vercel-workspace";
  const workspaceFile = path.join(
    workspaceDir,
    `${workspaceName}.code-workspace`,
  );

  const contents = JSON.stringify(
    { folders: repos.map((repo) => ({ path: repo.name })) },
    null,
    2,
  );

  await fs.writeFile(workspaceFile, `${contents}\n`, "utf8");
  log.info(`VS Code workspace saved to ${workspaceFile}`);
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
