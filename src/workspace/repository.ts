import { log } from "../logger.ts";
import { cloneRepository, runGit } from "../services/git.ts";
import type { RepoConfig } from "../types.ts";
import { pathExists } from "../utils/fs.ts";
import { withRetry } from "../utils/retry.ts";

export async function ensureMirrorRepo(
  repo: RepoConfig,
  mirrorDir: string,
): Promise<void> {
  const mirrorExists = await pathExists(mirrorDir);

  if (!mirrorExists) {
    log.info(`Seeding pristine repo for ${repo.name}`);
    await withRetry(
      () =>
        cloneRepository(
          repo.remote,
          mirrorDir,
          [
            "--bare",
            "--filter=blob:none",
            "--config",
            "remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*",
          ],
          {},
        ),
      { attempts: 3, label: `clone-pristine:${repo.name}` },
    );
  } else {
    await updatePristineRepo(repo, mirrorDir);
  }
}

export async function ensureWorkingCopy(
  repo: RepoConfig,
  mirrorDir: string,
  targetDir: string,
  branchName: string,
): Promise<void> {
  const workingCopyExists = await pathExists(targetDir);

  if (workingCopyExists) {
    log.info(`Reusing existing checkout for ${repo.name}`);
    return;
  }

  log.info(
    `Creating worktree for ${repo.name} on branch "${branchName}" from origin/${repo.defaultBranch}`,
  );

  await withRetry(
    () =>
      runGit(
        [
          "worktree",
          "add",
          "--track",
          "-B",
          branchName,
          targetDir,
          `origin/${repo.defaultBranch}`,
        ],
        { cwd: mirrorDir },
      ),
    { attempts: 3, label: `worktree:${repo.name}` },
  );
}

async function updatePristineRepo(
  repo: RepoConfig,
  mirrorDir: string,
): Promise<void> {
  try {
    await withRetry(
      () => runGit(["fetch", "origin", "--prune"], { cwd: mirrorDir }),
      { attempts: 3, label: `update-pristine:${repo.name}` },
    );
  } catch (error_) {
    log.warn(
      `Unable to update pristine repo for ${repo.name}. Using the last cached snapshot.`,
    );
    log.warn(String(error_));
  }
}
