import { log } from "./logger.ts";
import { resolveMirrorDir } from "./repositories.ts";
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

export async function createSingleWorktree({
  repo,
  branchName,
  targetDir,
}: CreateSingleWorktreeOptions): Promise<SingleWorktreeResult> {
  const cacheDir = await ensureCacheDir();
  const mirrorDir = await resolveMirrorDir(repo, cacheDir);

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
