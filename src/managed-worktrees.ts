import { promises as fs } from "node:fs";
import path from "node:path";
import { hasAny } from "@wf-plugin/core";
import { getCacheDir, reposFromSlugs } from "./config.ts";
import { log } from "./logger.ts";
import { normalizeRemote, resolveMirrorDir } from "./repositories.ts";
import { validateRepositoryComponent } from "./repository-components.ts";
import { runGit } from "./services/git.ts";
import { runSingleRepoInitializersGenerator } from "./services/initializers/index.ts";
import {
  applyTemplateGenerator,
  copyTemplateFiles,
} from "./templates/apply.ts";
import type { Template } from "./templates/index.ts";
import type { RepoConfig } from "./types.ts";
import { buildBranchName } from "./utils/branch-prefix.ts";
import { pathExists } from "./utils/fs.ts";
import {
  resolveContainedPath,
  validateResourceName,
} from "./utils/path-safety.ts";
import { isSlug } from "./utils/slug.ts";
import {
  addReposToWorkspace,
  writeVSCodeWorkspaceFile,
} from "./workspace/index.ts";
import {
  readWorkspaceMetadata,
  writeWorkspaceMetadata,
} from "./workspace/metadata.ts";
import { createSingleWorktree, removeStandaloneWorktree } from "./worktree.ts";

export type ManagedWorktreeContext = {
  repo: RepoConfig;
  mirrorDir: string;
  familyDir: string;
  checkoutPath: string;
  name: string;
  branch: string | null;
  detached: boolean;
  locked: boolean;
};

export type ManagedWorktreeInfo = {
  name: string;
  path: string;
  branch: string | null;
  detached: boolean;
  locked: boolean;
};

export type CreateManagedWorktreeOptions = {
  repo: RepoConfig;
  name: string;
  defaultDir: string;
  branchPrefix?: string;
  dryRun?: boolean;
};

export type CreateManagedWorktreeResult = {
  repo: RepoConfig;
  name: string;
  branchName: string;
  targetDir: string;
  dryRun: boolean;
  setupStatus: "ready" | "failed";
  setupError?: Error;
};

export type PromoteManagedWorktreeOptions = {
  context: ManagedWorktreeContext;
  defaultDir: string;
  dirPrefix?: string;
  template?: Template | null;
  repos?: readonly RepoConfig[];
  dryRun?: boolean;
};

export type PromoteManagedWorktreeResult = {
  workspaceDir: string;
  repoDir: string;
  repos: readonly RepoConfig[];
  addedRepos: readonly RepoConfig[];
  failures: readonly string[];
  dryRun: boolean;
};

type GitWorktreeEntry = {
  path: string;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  bare: boolean;
};

export async function resolveManagedWorktreeContext({
  cwd,
  defaultDir,
}: {
  cwd: string;
  defaultDir: string;
}): Promise<ManagedWorktreeContext | null> {
  const topLevel = await getGitTopLevel(cwd);
  if (!topLevel) return null;

  const [rootDir, checkoutPath] = await Promise.all([
    canonicalPath(defaultDir),
    canonicalPath(topLevel),
  ]);
  const relative = path.relative(rootDir, checkoutPath);
  const segments = relative.split(path.sep);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    segments.length !== 2
  ) {
    return null;
  }

  const [familyName, name] = segments;
  if (!familyName || !name || !isSlug(name)) {
    return null;
  }

  const remote = await getOriginRemote(checkoutPath);
  if (!remote) return null;
  const repo = reposFromSlugs([remote])[0];
  if (!repo || repo.name !== familyName) {
    return null;
  }

  const commonDir = await getGitCommonDir(checkoutPath);
  if (!commonDir) return null;
  const mirrorDir = await resolveMirrorDir(repo, getCacheDir());
  if (!(await pathsReferToSameLocation(commonDir, mirrorDir))) {
    return null;
  }

  const entries = await listGitWorktrees(mirrorDir);
  const current = entries.find(
    (entry) => path.resolve(entry.path) === checkoutPath,
  );
  if (!current || current.bare) {
    return null;
  }

  return {
    repo,
    mirrorDir,
    familyDir: path.dirname(checkoutPath),
    checkoutPath,
    name,
    branch: current.branch,
    detached: current.detached,
    locked: current.locked,
  };
}

export async function createManagedWorktree({
  repo,
  name,
  defaultDir,
  branchPrefix,
  dryRun = false,
}: CreateManagedWorktreeOptions): Promise<CreateManagedWorktreeResult> {
  if (!isSlug(name)) {
    throw new Error(
      `Invalid slug "${name}". Slugs must be lowercase words separated by hyphens.`,
    );
  }

  const repoName = validateRepositoryComponent(repo.name, "Repository name");
  validateResourceName(name, "Worktree name");
  const targetDir = resolveContainedPath(defaultDir, repoName, name);
  const branchName = buildBranchName(name, branchPrefix);
  if (dryRun) {
    return {
      repo,
      name,
      branchName,
      targetDir,
      dryRun: true,
      setupStatus: "ready",
    };
  }

  const familyDir = path.dirname(targetDir);
  const familyExisted = await pathExists(familyDir);
  await fs.mkdir(familyDir, { recursive: true });
  try {
    await createSingleWorktree({ repo, branchName, targetDir });
  } catch (error) {
    if (!familyExisted) {
      await fs.rmdir(familyDir).catch(() => {});
    }
    throw error;
  }

  let setupError: Error | undefined;
  try {
    for await (const state of runSingleRepoInitializersGenerator({
      context: {
        repoDir: targetDir,
        workspaceDir: targetDir,
        repo,
      },
    })) {
      if (state.phase === "running") {
        if (state.state.status === "log") {
          log[state.state.level](state.state.message);
        } else if (state.state.status === "failed") {
          setupError = state.state.error;
          break;
        }
      }
    }
  } catch (error) {
    setupError = toError(error);
  }

  return {
    repo,
    name,
    branchName,
    targetDir,
    dryRun: false,
    setupStatus: setupError ? "failed" : "ready",
    ...(setupError ? { setupError } : {}),
  };
}

export async function listManagedWorktrees(
  context: ManagedWorktreeContext,
): Promise<ManagedWorktreeInfo[]> {
  const entries = await listGitWorktrees(context.mirrorDir);
  const familyDir = path.resolve(context.familyDir);
  const results: ManagedWorktreeInfo[] = [];

  for (const entry of entries) {
    if (entry.bare) continue;
    const entryPath = path.resolve(entry.path);
    if (path.dirname(entryPath) !== familyDir) continue;

    const name = path.basename(entryPath);
    if (!isSlug(name)) continue;
    results.push({
      name,
      path: entryPath,
      branch: entry.branch,
      detached: entry.detached,
      locked: entry.locked,
    });
  }

  return results.sort((left, right) => left.name.localeCompare(right.name));
}

export async function removeManagedWorktree({
  context,
  name,
  dryRun = false,
  force = false,
}: {
  context: ManagedWorktreeContext;
  name: string;
  dryRun?: boolean;
  force?: boolean;
}): Promise<ManagedWorktreeInfo> {
  if (!isSlug(name)) {
    throw new Error(
      `Invalid slug "${name}". Slugs must be lowercase words separated by hyphens.`,
    );
  }

  const worktrees = await listManagedWorktrees(context);
  const worktree = worktrees.find((candidate) => candidate.name === name);
  if (!worktree) {
    throw new Error(
      `Managed worktree "${name}" was not found in ${context.familyDir}.`,
    );
  }

  await removeStandaloneWorktree({
    targetDir: worktree.path,
    dryRun,
    force,
  });
  return worktree;
}

export async function promoteManagedWorktree({
  context,
  defaultDir,
  dirPrefix = "",
  template = null,
  repos = [],
  dryRun = false,
}: PromoteManagedWorktreeOptions): Promise<PromoteManagedWorktreeResult> {
  await validatePromotionSource(context);

  validateRepositoryComponent(context.repo.name, "Repository name");
  const workspaceName = validateResourceName(
    `${dirPrefix}${context.name}`,
    "Workspace name",
  );
  const workspaceDir = resolveContainedPath(defaultDir, workspaceName);
  const repoDir = resolveContainedPath(workspaceDir, context.repo.name);
  if (await pathExists(workspaceDir)) {
    throw new Error(`Promotion destination already exists: ${workspaceDir}`);
  }

  const mergedRepos = await mergePromotionRepos(context.repo, repos);
  const addedRepos = mergedRepos.slice(1);

  if (dryRun) {
    return {
      workspaceDir,
      repoDir,
      repos: mergedRepos,
      addedRepos,
      failures: [],
      dryRun: true,
    };
  }

  await fs.mkdir(workspaceDir, { recursive: true });
  let moved = false;
  try {
    await runGit(["worktree", "move", context.checkoutPath, repoDir], {
      cwd: context.mirrorDir,
      timeout: 30_000,
    });
    moved = true;

    const hasLockfile = await hasAny(repoDir, [
      "pnpm-lock.yaml",
      "pnpm-lock.yml",
    ]);
    await writeWorkspaceMetadata(workspaceDir, {
      featureName: context.name,
      branchName: requireCurrentBranch(context),
      repos: [
        {
          name: context.repo.name,
          remote: context.repo.remote,
          defaultBranch: context.repo.defaultBranch,
          hasLockfile,
        },
      ],
      ...(template ? { templateId: template.id } : {}),
    });
    await writeVSCodeWorkspaceFile(workspaceDir, [context.repo]);
  } catch (error) {
    if (moved) {
      try {
        await runGit(["worktree", "move", repoDir, context.checkoutPath], {
          cwd: context.mirrorDir,
          timeout: 30_000,
        });
      } catch (rollbackError) {
        throw new Error(
          `Promotion failed and the worktree could not be moved back: ${toError(error).message}. Rollback error: ${toError(rollbackError).message}`,
        );
      }
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
    throw error;
  }

  const failures: string[] = [];
  if (template) {
    try {
      await copyTemplateFiles(template, workspaceDir);
    } catch (error) {
      failures.push(`Template files: ${toError(error).message}`);
    }
  }

  if (addedRepos.length > 0) {
    try {
      const result = await addReposToWorkspace({
        workspaceDir,
        repos: addedRepos,
        branchName: requireCurrentBranch(context),
        ...(template?.config.disableInitializers !== undefined
          ? { disabledInitializers: template.config.disableInitializers }
          : {}),
      });
      failures.push(
        ...result.failedRepos.map(
          (failure) => `${failure.name}: ${failure.error.message}`,
        ),
      );
    } catch (error) {
      failures.push(`Repository setup: ${toError(error).message}`);
    }
  }

  if (template) {
    try {
      const metadata = await readWorkspaceMetadata(workspaceDir);
      const repoDirs = metadata?.repos.map((repo) => repo.name) ?? [
        context.repo.name,
      ];
      for await (const state of applyTemplateGenerator({
        template,
        workspaceDir,
        repoDirs,
      })) {
        if (state.phase === "hook" && state.state.status === "log") {
          log[state.state.level](state.state.message);
        }
      }
    } catch (error) {
      failures.push(`Template hooks: ${toError(error).message}`);
    }
  }

  return {
    workspaceDir,
    repoDir,
    repos: mergedRepos,
    addedRepos,
    failures,
    dryRun: false,
  };
}

async function validatePromotionSource(
  context: ManagedWorktreeContext,
): Promise<void> {
  if (context.detached || !context.branch) {
    throw new Error("Cannot promote a detached worktree.");
  }
  if (context.locked) {
    throw new Error("Cannot promote a locked worktree.");
  }

  const { stdout } = await runGit(["submodule", "status", "--recursive"], {
    cwd: context.checkoutPath,
  });
  const initialized = stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("-"));
  if (initialized.length > 0) {
    throw new Error(
      "Cannot promote a worktree with initialized submodules. Deinitialize them before promotion.",
    );
  }
}

async function mergePromotionRepos(
  currentRepo: RepoConfig,
  repos: readonly RepoConfig[],
): Promise<RepoConfig[]> {
  const merged: RepoConfig[] = [currentRepo];
  const remoteByName = new Map<string, string>([
    [currentRepo.name, normalizeRemote(currentRepo.remote)],
  ]);
  const seenRemotes = new Set(remoteByName.values());

  for (const repo of repos) {
    const remote = normalizeRemote(repo.remote);
    const existingRemote = remoteByName.get(repo.name);
    if (existingRemote && existingRemote !== remote) {
      throw new Error(
        `Repository name "${repo.name}" refers to multiple remotes.`,
      );
    }
    if (seenRemotes.has(remote)) continue;

    remoteByName.set(repo.name, remote);
    seenRemotes.add(remote);
    merged.push(repo);
  }

  return merged;
}

function requireCurrentBranch(context: ManagedWorktreeContext): string {
  if (!context.branch) {
    throw new Error("Cannot promote a detached worktree.");
  }
  return context.branch;
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
    return path.isAbsolute(commonDir)
      ? path.resolve(commonDir)
      : path.resolve(cwd, commonDir);
  } catch {
    return null;
  }
}

async function getOriginRemote(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(["config", "--get", "remote.origin.url"], {
      cwd,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function pathsReferToSameLocation(
  left: string,
  right: string,
): Promise<boolean> {
  const [resolvedLeft, resolvedRight] = await Promise.all([
    canonicalPath(left),
    canonicalPath(right),
  ]);
  return resolvedLeft === resolvedRight;
}

async function canonicalPath(value: string): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

async function listGitWorktrees(
  mirrorDir: string,
): Promise<GitWorktreeEntry[]> {
  const { stdout } = await runGit(["worktree", "list", "--porcelain"], {
    cwd: mirrorDir,
  });
  return parseGitWorktrees(stdout);
}

export function parseGitWorktrees(stdout: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;

  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = {
        path: path.resolve(line.slice("worktree ".length).trim()),
        branch: null,
        detached: false,
        locked: false,
        bare: false,
      };
      continue;
    }
    if (!current) continue;

    if (line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length).trim();
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
    }
  }

  if (current) entries.push(current);
  return entries;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
