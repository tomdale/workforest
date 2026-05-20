import path from "node:path";
import { log } from "./logger.ts";
import { runGit } from "./services/git.ts";
import type { RepoConfig } from "./types.ts";
import { ensureCacheDir } from "./workspace/index.ts";
import {
  createWorkingCopyGenerator,
  ensureMirrorRepoGenerator,
} from "./workspace/repository.ts";

export type CreateSingleWorktreeOptions = {
  repo: RepoConfig;
  branchName: string;
  targetDir: string;
};

export type SingleWorktreeResult = {
  repo: RepoConfig;
  branchName: string;
  targetDir: string;
};

export type StandaloneWorktreeInfo = {
  path: string;
  branch?: string;
};

export type RemoveStandaloneWorktreeOptions = {
  targetDir: string;
  dryRun?: boolean;
  force?: boolean;
};

export type RemoveStandaloneWorktreeResult = StandaloneWorktreeInfo & {
  dryRun: boolean;
};

type GitWorktreeEntry = {
  path: string;
  branch?: string;
};

export async function createSingleWorktree({
  repo,
  branchName,
  targetDir,
}: CreateSingleWorktreeOptions): Promise<SingleWorktreeResult> {
  const cacheDir = await ensureCacheDir();
  const mirrorDir = path.join(cacheDir, `${repo.name}.git`);

  for await (const state of ensureMirrorRepoGenerator(repo, mirrorDir)) {
    if (state.status === "log") {
      log[state.level](state.message);
    }
  }

  for await (const state of createWorkingCopyGenerator(
    repo,
    mirrorDir,
    targetDir,
    branchName,
  )) {
    if (state.status === "log") {
      log[state.level](state.message);
    }
  }

  return {
    repo,
    branchName,
    targetDir,
  };
}

export async function resolveStandaloneWorktree(
  cwd: string,
): Promise<StandaloneWorktreeInfo | null> {
  const topLevel = await getGitTopLevel(cwd);
  if (!topLevel) {
    return null;
  }

  const commonDir = await getGitCommonDir(topLevel);
  if (!commonDir) {
    return null;
  }

  const entries = await listGitWorktrees(commonDir);
  const current = entries.find(
    (entry) => path.resolve(entry.path) === path.resolve(topLevel),
  );
  if (!current || entries[0]?.path === current.path) {
    return null;
  }

  return current;
}

export async function removeStandaloneWorktree({
  targetDir,
  dryRun = false,
  force = false,
}: RemoveStandaloneWorktreeOptions): Promise<RemoveStandaloneWorktreeResult> {
  const worktree = await resolveStandaloneWorktree(targetDir);
  if (!worktree) {
    throw new Error(`No standalone worktree found at ${targetDir}.`);
  }

  if (dryRun) {
    return { ...worktree, dryRun: true };
  }

  const commonDir = await getGitCommonDir(worktree.path);
  if (!commonDir) {
    throw new Error(`Could not resolve git metadata for ${worktree.path}.`);
  }

  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(worktree.path);
  await runGit(args, { cwd: commonDir, timeout: 30_000 });

  return { ...worktree, dryRun: false };
}

async function getGitTopLevel(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(["rev-parse", "--show-toplevel"], {
      cwd,
    });
    return path.resolve(stdout.trim());
  } catch {
    return null;
  }
}

async function getGitCommonDir(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(["rev-parse", "--git-common-dir"], {
      cwd,
    });
    const commonDir = stdout.trim();
    if (!commonDir) return null;
    return path.isAbsolute(commonDir)
      ? commonDir
      : path.resolve(cwd, commonDir);
  } catch {
    return null;
  }
}

async function listGitWorktrees(
  commonDir: string,
): Promise<GitWorktreeEntry[]> {
  const { stdout } = await runGit(["worktree", "list", "--porcelain"], {
    cwd: commonDir,
  });
  return parseGitWorktrees(stdout);
}

function parseGitWorktrees(stdout: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;

  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: path.resolve(line.slice("worktree ".length).trim()) };
      continue;
    }

    if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).trim();
    }
  }

  if (current) entries.push(current);
  return entries;
}
