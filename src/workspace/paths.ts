import os from "node:os";
import path from "node:path";
import { validateRepositoryComponent } from "../repository-components.ts";
import type { WorkspaceConfig } from "../types.ts";
import { validateResourceName } from "../utils/path-safety.ts";

export const ADHOC_WORKSPACE_GROUP = "_adhoc";
export const TASKS_DIRECTORY_NAME = "_tasks";

export type WorkforestDirectories = Readonly<{
  base: string;
  repos: string;
  workspaces: string;
  reviews: string;
}>;

export function resolveWorkforestDirectories(
  config: WorkspaceConfig,
): WorkforestDirectories {
  const directory = config.directory ?? {};
  const base = resolveBaseDirectory(directory.base);

  return {
    base,
    repos: resolveDirectoryChild(base, directory.repos ?? "Repos"),
    workspaces: resolveDirectoryChild(
      base,
      directory.workspaces ?? "Workspaces",
    ),
    reviews: resolveDirectoryChild(base, directory.reviews ?? "Reviews"),
  };
}

export function getRepositoryChangePath(
  directories: WorkforestDirectories,
  repoName: string,
  changeName: string,
): string {
  return path.join(
    directories.repos,
    validateRepositoryComponent(repoName, "Repository name"),
    validateResourceName(changeName, "Change name"),
  );
}

export function getWorkspaceChangePath(
  directories: WorkforestDirectories,
  groupName: string,
  changeName: string,
): string {
  return path.join(
    directories.workspaces,
    validateChangeGroupName(groupName),
    validateResourceName(changeName, "Change name"),
  );
}

export function getWorkspaceRepoPath(
  directories: WorkforestDirectories,
  groupName: string,
  changeName: string,
  repoName: string,
): string {
  return path.join(
    getWorkspaceChangePath(directories, groupName, changeName),
    validateRepositoryComponent(repoName, "Repository name"),
  );
}

export function getReviewRepoPath(
  directories: WorkforestDirectories,
  repoName: string,
): string {
  return path.join(
    directories.reviews,
    validateRepositoryComponent(repoName, "Repository name"),
  );
}

export function getRepositoryTaskPath(
  directories: WorkforestDirectories,
  repoName: string,
  changeName: string,
  taskName: string,
): string {
  return path.join(
    directories.repos,
    validateRepositoryComponent(repoName, "Repository name"),
    TASKS_DIRECTORY_NAME,
    validateResourceName(changeName, "Change name"),
    validateResourceName(taskName, "Task name"),
  );
}

export function getWorkspaceTaskPath(
  directories: WorkforestDirectories,
  groupName: string,
  changeName: string,
  repoName: string,
  taskName: string,
): string {
  return path.join(
    getWorkspaceChangePath(directories, groupName, changeName),
    TASKS_DIRECTORY_NAME,
    validateRepositoryComponent(repoName, "Repository name"),
    validateResourceName(taskName, "Task name"),
  );
}

export function isPathInsideOrEqual(
  parent: string,
  candidate: string,
): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative.length === 0 ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function resolveBaseDirectory(value: string | undefined): string {
  return path.resolve(expandHome(value ?? "~/Code"));
}

function resolveDirectoryChild(base: string, value: string): string {
  const expanded = expandHome(value);
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(base, expanded);
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function validateChangeGroupName(value: string): string {
  return value === ADHOC_WORKSPACE_GROUP
    ? value
    : validateResourceName(value, "Workspace group");
}
