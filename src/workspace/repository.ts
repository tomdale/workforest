import path from "node:path";
import { cloneRepositoryGenerator, runGit } from "../services/git.ts";
import type { RepoConfig } from "../types.ts";
import { pathExists } from "../utils/fs.ts";
import { asGenerator, withRetryGenerator } from "../utils/retry.ts";
import type { TaskState } from "../utils/task-generator.ts";

/**
 * Generator version of ensureMirrorRepo that yields log messages.
 */
export async function* ensureMirrorRepoGenerator(
  repo: RepoConfig,
  mirrorDir: string,
): AsyncGenerator<TaskState, void, undefined> {
  const mirrorExists = await pathExists(mirrorDir);

  if (!mirrorExists) {
    yield {
      status: "log",
      level: "info",
      message: `Seeding pristine repo for ${repo.name}`,
    };

    const cloneGen = () =>
      cloneRepositoryGenerator(
        repo.remote,
        mirrorDir,
        [
          "--bare",
          "--filter=blob:none",
          "--config",
          "remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*",
        ],
        {},
      );

    yield* withRetryGenerator(cloneGen, {
      attempts: 3,
      label: `clone-pristine:${repo.name}`,
    });
  } else {
    yield* updatePristineRepoGenerator(repo, mirrorDir);
  }
}

/**
 * @deprecated Use ensureMirrorRepoGenerator for generator-based workflows.
 */
export async function ensureMirrorRepo(
  repo: RepoConfig,
  mirrorDir: string,
): Promise<void> {
  const gen = ensureMirrorRepoGenerator(repo, mirrorDir);
  // Consume the generator, discarding states
  let result = await gen.next();
  while (!result.done) {
    result = await gen.next();
  }
}

/**
 * Generator version of ensureWorkingCopy that yields log messages.
 */
export async function* ensureWorkingCopyGenerator(
  repo: RepoConfig,
  mirrorDir: string,
  targetDir: string,
  branchName: string,
): AsyncGenerator<TaskState, void, undefined> {
  const workingCopyExists = await pathExists(targetDir);

  if (workingCopyExists) {
    yield {
      status: "log",
      level: "info",
      message: `Reusing existing checkout for ${repo.name}`,
    };
    return;
  }

  yield {
    status: "log",
    level: "info",
    message: `Creating worktree for ${repo.name} on branch "${branchName}" from origin/${repo.defaultBranch}`,
  };

  // Wrap the git command in a generator for withRetryGenerator
  const worktreeGen = asGenerator(() =>
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
  );

  yield* withRetryGenerator(worktreeGen, {
    attempts: 3,
    label: `worktree:${repo.name}`,
  });
}

/**
 * @deprecated Use ensureWorkingCopyGenerator for generator-based workflows.
 */
export async function ensureWorkingCopy(
  repo: RepoConfig,
  mirrorDir: string,
  targetDir: string,
  branchName: string,
): Promise<void> {
  const gen = ensureWorkingCopyGenerator(
    repo,
    mirrorDir,
    targetDir,
    branchName,
  );
  let result = await gen.next();
  while (!result.done) {
    result = await gen.next();
  }
}

/**
 * Generator version of cleanupWorkspaceWorktrees that yields log messages.
 */
export async function* cleanupWorkspaceWorktreesGenerator(
  mirrorDir: string,
  workspaceDir: string,
): AsyncGenerator<TaskState, void, undefined> {
  const normalizedWorkspaceDir = path.resolve(workspaceDir);
  const { stdout } = await runGit(["worktree", "list", "--porcelain"], {
    cwd: mirrorDir,
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

  yield {
    status: "log",
    level: "info",
    message: `Cleaning up ${targets.length} existing worktree(s) under ${workspaceDir}`,
  };

  for (const worktreePath of targets) {
    const removeGen = asGenerator(() =>
      runGit(["worktree", "remove", "--force", worktreePath], {
        cwd: mirrorDir,
      }),
    );

    yield* withRetryGenerator(removeGen, {
      attempts: 3,
      label: `worktree-remove:${path.basename(worktreePath)}`,
    });
  }
}

/**
 * @deprecated Use cleanupWorkspaceWorktreesGenerator for generator-based workflows.
 */
export async function cleanupWorkspaceWorktrees(
  mirrorDir: string,
  workspaceDir: string,
): Promise<void> {
  const gen = cleanupWorkspaceWorktreesGenerator(mirrorDir, workspaceDir);
  let result = await gen.next();
  while (!result.done) {
    result = await gen.next();
  }
}

/**
 * Generator version of updatePristineRepo that yields log messages.
 */
async function* updatePristineRepoGenerator(
  repo: RepoConfig,
  mirrorDir: string,
): AsyncGenerator<TaskState, void, undefined> {
  const fetchGen = asGenerator(() =>
    runGit(["fetch", "origin", "--prune"], { cwd: mirrorDir }),
  );

  try {
    yield* withRetryGenerator(fetchGen, {
      attempts: 3,
      label: `update-pristine:${repo.name}`,
    });
  } catch (error_) {
    yield {
      status: "log",
      level: "warn",
      message: `Unable to update pristine repo for ${repo.name}. Using the last cached snapshot.`,
    };
    yield {
      status: "log",
      level: "warn",
      message: String(error_),
    };
  }
}
