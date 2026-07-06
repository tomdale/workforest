import path from "node:path";
import { pathExists } from "@wf-plugin/core";
import { createDefaultBranchResolver, runGit } from "../services/git.ts";
import type { WorkspaceRepoMetadata } from "../types.ts";
import type { InventoryEntry } from "./inventory.ts";
import { readWorkspaceMetadata } from "./metadata.ts";
import { listRepositoryTasks, listTasks } from "./tasks.ts";

export type DeleteSafety = Readonly<{
  selector: string;
  repositories: readonly DeleteRepositorySafety[];
  tasks: readonly DeleteTaskSafety[];
}>;

export type DeleteRepositorySafety = Readonly<{
  name: string;
  path: string;
  branch: string | null;
  state: "clean" | "dirty" | "stale";
  base: string | null;
  integrated: boolean | null;
}>;

export type DeleteTaskSafety = Readonly<{
  selector: string;
  parentRepo: string;
  slug: string;
  branch: string;
  state: "ready" | "failed" | "stale";
  merged: boolean | null;
}>;

type RepositoryTarget = Readonly<{
  name: string;
  path: string;
}>;

export async function buildDeleteRepositorySafety(
  entry: InventoryEntry,
): Promise<DeleteRepositorySafety[]> {
  const targets = await getRepositoryTargets(entry);
  const defaultBranchResolver = createDefaultBranchResolver();
  const repositories = await Promise.all(
    targets.map((target) =>
      buildRepositorySafety(target, defaultBranchResolver),
    ),
  );
  return repositories.sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export async function buildDeleteTaskSafety(
  entry: InventoryEntry,
): Promise<DeleteTaskSafety[]> {
  if (entry.type === "worktree") {
    const tasks = await listRepositoryTasks({
      parentRepoDir: entry.path,
      repoName: entry.repository,
      changeName: entry.changeName,
    }).catch(() => []);
    return tasks.map(toDeleteTaskSafety).sort(compareTaskSafety);
  }

  const metadata = await readWorkspaceMetadata(entry.path).catch(() => null);
  if (!metadata) {
    return [];
  }

  const tasks = await listTasks(entry.path).catch(() => []);
  return tasks.map(toDeleteTaskSafety).sort(compareTaskSafety);
}

export function deleteSafetyFor(
  entry: InventoryEntry,
  repositories: readonly DeleteRepositorySafety[],
  tasks: readonly DeleteTaskSafety[],
): DeleteSafety {
  return {
    selector: entry.selector,
    repositories,
    tasks,
  };
}

async function getRepositoryTargets(
  entry: InventoryEntry,
): Promise<RepositoryTarget[]> {
  if (entry.type === "worktree") {
    return [{ name: entry.repository, path: entry.path }];
  }

  const metadata = await readWorkspaceMetadata(entry.path).catch(() => null);
  const repos =
    metadata?.repos ??
    entry.repos.map(
      (repo): WorkspaceRepoMetadata => ({
        name: repo,
        remote: "",
        has_lockfile: false,
      }),
    );

  return repos.map((repo) => ({
    name: repo.name,
    path: path.join(entry.path, repo.name),
  }));
}

async function buildRepositorySafety(
  target: RepositoryTarget,
  defaultBranchResolver: ReturnType<typeof createDefaultBranchResolver>,
): Promise<DeleteRepositorySafety> {
  const defaultBranch = await inferDefaultBranch(
    target.path,
    defaultBranchResolver,
  );
  const base = defaultBranch ? `origin/${defaultBranch}` : null;

  if (!(await pathExists(target.path))) {
    return {
      name: target.name,
      path: target.path,
      branch: null,
      state: "stale",
      base,
      integrated: null,
    };
  }

  const dirty = await isDirty(target.path);
  const branch = await optionalGitLine(
    ["branch", "--show-current"],
    target.path,
  );
  const integrated = base
    ? await isIntegrated(target.path, base, branch, defaultBranch)
    : null;

  return {
    name: target.name,
    path: target.path,
    branch: branch || null,
    state: dirty ? "dirty" : "clean",
    base,
    integrated,
  };
}

async function isDirty(repoPath: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(["status", "--porcelain"], {
      cwd: repoPath,
    });
    return stdout.split("\n").some(Boolean);
  } catch {
    return false;
  }
}

async function optionalGitLine(
  args: readonly string[],
  cwd: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGit([...args], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function inferDefaultBranch(
  cwd: string,
  defaultBranchResolver: ReturnType<typeof createDefaultBranchResolver>,
): Promise<string | null> {
  try {
    return await defaultBranchResolver.resolveWorktreeDefaultBranch(cwd);
  } catch {
    return null;
  }
}

async function isIntegrated(
  cwd: string,
  base: string,
  branch: string | null,
  defaultBranch: string | null,
): Promise<boolean | null> {
  if (branch && defaultBranch && branch === defaultBranch) {
    return true;
  }
  try {
    await runGit(["merge-base", "--is-ancestor", "HEAD", base], { cwd });
    return true;
  } catch {
    return false;
  }
}

function toDeleteTaskSafety(task: {
  parent_repo: string;
  slug: string;
  branch: string;
  state: "ready" | "failed" | "stale";
  merged: boolean | null;
}): DeleteTaskSafety {
  return {
    selector: `${task.parent_repo}/${task.slug}`,
    parentRepo: task.parent_repo,
    slug: task.slug,
    branch: task.branch,
    state: task.state,
    merged: task.merged,
  };
}

function compareTaskSafety(
  left: DeleteTaskSafety,
  right: DeleteTaskSafety,
): number {
  return left.selector.localeCompare(right.selector);
}
