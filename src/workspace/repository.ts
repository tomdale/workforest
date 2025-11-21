import type { RepoConfig } from "../types.ts";
import { log } from "../logger.ts";
import { pathExists } from "../utils/fs.ts";
import { withRetry } from "../utils/retry.ts";
import { runGit, cloneRepository } from "../services/git.ts";

export async function ensureMirrorRepo(
  repo: RepoConfig,
  mirrorDir: string,
): Promise<void> {
  const mirrorExists = await pathExists(mirrorDir);

  if (!mirrorExists) {
    log.info(`Seeding mirror for ${repo.name}`);
    await withRetry(
      () => cloneRepository(repo.remote, mirrorDir, ["--mirror"], {}),
      { attempts: 3, label: `clone-mirror:${repo.name}` },
    );
    return;
  }

  try {
    await withRetry(
      () => runGit(["fetch", "--all", "--prune"], { cwd: mirrorDir }),
      { attempts: 3, label: `update-mirror:${repo.name}` },
    );
  } catch (error_) {
    log.warn(
      `Unable to update mirror for ${repo.name}. Using the last cached snapshot.`,
    );
    log.warn(String(error_));
  }
}

export async function ensureWorkingCopy(
  repo: RepoConfig,
  mirrorDir: string,
  targetDir: string,
): Promise<void> {
  const workingCopyExists = await pathExists(targetDir);

  if (!workingCopyExists) {
    log.info(`Cloning ${repo.name} into workspace`);
    await withRetry(
      () =>
        runGit(
          ["clone", "--reference-if-able", mirrorDir, repo.remote, targetDir],
          {},
        ),
      { attempts: 3, label: `clone:${repo.name}` },
    );
  } else {
    log.info(`Reusing existing checkout for ${repo.name}`);
  }

  const clean = await isWorkingTreeClean(targetDir);
  if (!clean) {
    log.warn(
      `${repo.name} has local changes. Skipping automatic reset to origin/${repo.defaultBranch}.`,
    );
    return;
  }

  try {
    await withRetry(
      () => runGit(["fetch", "origin", "--prune"], { cwd: targetDir }),
      { attempts: 3, label: `fetch:${repo.name}` },
    );
  } catch (error_) {
    log.warn(
      `Unable to fetch latest changes for ${repo.name}. Using cached refs.`,
    );
    log.warn(String(error_));
  }

  await runGit(["checkout", repo.defaultBranch], { cwd: targetDir });
  await runGit(["reset", "--hard", `origin/${repo.defaultBranch}`], {
    cwd: targetDir,
  });
}

async function isWorkingTreeClean(repoDir: string): Promise<boolean> {
  const { stdout } = await runGit(["status", "--porcelain"], {
    cwd: repoDir,
    capture: true,
  });
  return stdout.trim().length === 0;
}

