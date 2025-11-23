import path from "node:path";
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

export async function cleanupWorkspaceWorktrees(
  mirrorDir: string,
  workspaceDir: string,
): Promise<void> {
  const normalizedWorkspaceDir = path.resolve(workspaceDir);
  const { stdout } = await runGit(["worktree", "list", "--porcelain"], {
    cwd: mirrorDir,
    capture: true,
  });

  const worktreePaths = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.substring("worktree ".length).trim())
    .filter(Boolean);

  const targets = worktreePaths.filter((worktreePath) => {
    const normalizedWorktree = path.resolve(worktreePath);
    return (
      normalizedWorktree === normalizedWorkspaceDir ||
      normalizedWorktree.startsWith(`${normalizedWorkspaceDir}${path.sep}`)
    );
  });

  if (targets.length === 0) {
    return;
  }

  log.info(
    `Cleaning up ${targets.length} existing worktree(s) under ${workspaceDir}`,
  );

  for (const worktreePath of targets) {
    await withRetry(
      () =>
        runGit(["worktree", "remove", "--force", worktreePath], {
          cwd: mirrorDir,
        }),
      { attempts: 3, label: `worktree-remove:${path.basename(worktreePath)}` },
    );
  }
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
