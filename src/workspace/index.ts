import os from "node:os";
import path from "node:path";
import { getRepositories } from "../config.ts";
import { log } from "../logger.ts";
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
};

export async function stampWorkspace({
  featureName,
  workspaceDir,
}: StampWorkspaceOptions): Promise<void> {
  const cacheDir = await ensureCacheDir();
  await ensureDir(workspaceDir);
  log.info(`Stamping workspace for "${featureName}" at ${workspaceDir}`);

  await Promise.all(
    getRepositories().map((repo) =>
      stampRepository(repo, cacheDir, workspaceDir),
    ),
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
    process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  const cacheRoot = path.join(cacheHome, "vercel-workspace");
  await ensureDir(cacheRoot);
  return cacheRoot;
}

