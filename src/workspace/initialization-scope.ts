import path from "node:path";
import { validateRepositoryComponent } from "../repository-components.ts";
import {
  resolveContainedPath,
  validateResourceName,
} from "../utils/path-safety.ts";
import {
  getRepositoryMetadataDirPath,
  getWorkspaceMetadataDirPath,
} from "./metadata.ts";

export type WorkspaceInitializationScope = Readonly<{
  kind: "workspace";
  workspaceDir: string;
}>;

export type WorktreeInitializationScope = Readonly<{
  kind: "worktree";
  repoRootDir: string;
  changeName: string;
}>;

export type InitializationScope =
  | WorkspaceInitializationScope
  | WorktreeInitializationScope;

export type InitializationTarget = string | InitializationScope;

export function workspaceInitializationScope(
  workspaceDir: string,
): WorkspaceInitializationScope {
  return {
    kind: "workspace",
    workspaceDir: path.resolve(workspaceDir),
  };
}

export function worktreeInitializationScope({
  repoRootDir,
  changeName,
}: {
  repoRootDir: string;
  changeName: string;
}): WorktreeInitializationScope {
  return {
    kind: "worktree",
    repoRootDir: path.resolve(repoRootDir),
    changeName: validateResourceName(changeName, "Name"),
  };
}

export function normalizeInitializationTarget(
  target: InitializationTarget,
): InitializationScope {
  return typeof target === "string"
    ? workspaceInitializationScope(target)
    : target;
}

export function getInitializationRootDir(scope: InitializationScope): string {
  return scope.kind === "workspace"
    ? path.resolve(scope.workspaceDir)
    : path.resolve(scope.repoRootDir);
}

export function getInitializationMetadataDir(
  scope: InitializationScope,
): string {
  return scope.kind === "workspace"
    ? getWorkspaceMetadataDirPath(scope.workspaceDir)
    : getRepositoryMetadataDirPath(scope.repoRootDir);
}

export function getInitializationStateDir(scope: InitializationScope): string {
  const metadataDir = getInitializationMetadataDir(scope);
  return scope.kind === "workspace"
    ? path.join(metadataDir, "initialization")
    : path.join(metadataDir, "initialization", scope.changeName);
}

export function getInitializationRepoDir(
  scope: InitializationScope,
  repoName: string,
): string {
  validateRepositoryComponent(repoName, "Repository name");
  const rootDir = getInitializationRootDir(scope);
  return scope.kind === "workspace"
    ? resolveContainedPath(rootDir, repoName)
    : resolveContainedPath(rootDir, scope.changeName);
}
