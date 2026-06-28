import path from "node:path";
import { validateRepositoryComponent } from "../repository-components.ts";
import { validateTemplateIdentifier } from "../templates/index.ts";
import { validateResourceName } from "../utils/path-safety.ts";
import type { WorkforestDirectories } from "./paths.ts";
import {
  ADHOC_WORKSPACE_GROUP,
  isPathInsideOrEqual,
  TASKS_DIRECTORY_NAME,
} from "./paths.ts";

export type WorktreeContext = Readonly<{
  kind: "worktree";
  selector: string;
  repoName: string;
  changeName: string;
  path: string;
}>;

export type RepositoryRootContext = Readonly<{
  kind: "repository-root";
  repoName: string;
  path: string;
}>;

export type TemplateWorkspaceContext = Readonly<{
  kind: "template-workspace";
  selector: string;
  groupName: string;
  changeName: string;
  path: string;
}>;

export type AdhocWorkspaceContext = Readonly<{
  kind: "adhoc-workspace";
  selector: string;
  groupName: typeof ADHOC_WORKSPACE_GROUP;
  changeName: string;
  path: string;
}>;

export type WorkspaceRepoContext = Readonly<{
  kind: "workspace-repo";
  selector: string;
  groupName: string;
  changeName: string;
  repoName: string;
  workspacePath: string;
  path: string;
}>;

export type NestedTaskContext = Readonly<{
  kind: "nested-task";
  parentSelector: string;
  repoName: string;
  changeName: string;
  taskName: string;
  path: string;
  parentKind: "worktree" | "workspace";
  groupName?: string;
}>;

export type ReviewCheckoutContext = Readonly<{
  kind: "review-checkout";
  repoName: string;
  path: string;
}>;

export type OutsideWorkforestContext = Readonly<{
  kind: "outside-workforest";
  path: string;
}>;

export type WorkforestManagedContext =
  | WorktreeContext
  | RepositoryRootContext
  | TemplateWorkspaceContext
  | AdhocWorkspaceContext
  | WorkspaceRepoContext
  | NestedTaskContext
  | ReviewCheckoutContext
  | OutsideWorkforestContext;

export function resolveWorkforestContext(
  currentDirectory: string,
  directories: WorkforestDirectories,
): WorkforestManagedContext {
  const resolvedCurrentDirectory = path.resolve(currentDirectory);

  const repositoryContext = resolveRepositoryContext(
    resolvedCurrentDirectory,
    directories,
  );
  if (repositoryContext) {
    return repositoryContext;
  }

  const workspaceContext = resolveWorkspaceContext(
    resolvedCurrentDirectory,
    directories,
  );
  if (workspaceContext) {
    return workspaceContext;
  }

  const reviewContext = resolveReviewContext(
    resolvedCurrentDirectory,
    directories,
  );
  if (reviewContext) {
    return reviewContext;
  }

  return {
    kind: "outside-workforest",
    path: resolvedCurrentDirectory,
  };
}

function resolveRepositoryContext(
  currentDirectory: string,
  directories: WorkforestDirectories,
): WorkforestManagedContext | null {
  const parts = relativeParts(directories.repos, currentDirectory);
  if (!parts || parts.length < 1) {
    return null;
  }

  const [repoName, second, third, fourth] = parts;
  if (!repoName) {
    return null;
  }
  const safeRepoName = safeRepositoryComponent(repoName);
  if (!safeRepoName) {
    return null;
  }

  const repositoryRootPath = path.join(directories.repos, safeRepoName);
  if (parts.length === 1) {
    return {
      kind: "repository-root",
      repoName: safeRepoName,
      path: repositoryRootPath,
    };
  }
  if (!second) {
    return null;
  }

  if (second === TASKS_DIRECTORY_NAME) {
    if (!third || !fourth) {
      return null;
    }
    const safeName = safeResourceName(third);
    const safeTaskName = safeResourceName(fourth);
    if (!safeName || !safeTaskName) {
      return null;
    }
    const taskPath = path.join(
      directories.repos,
      safeRepoName,
      TASKS_DIRECTORY_NAME,
      safeName,
      safeTaskName,
    );
    return {
      kind: "nested-task",
      parentKind: "worktree",
      parentSelector: `${safeRepoName}/${safeName}`,
      repoName: safeRepoName,
      changeName: safeName,
      taskName: safeTaskName,
      path: taskPath,
    };
  }

  const safeName = safeResourceName(second);
  if (!safeName) {
    return null;
  }
  const targetPath = path.join(repositoryRootPath, safeName);
  return {
    kind: "worktree",
    selector: `${safeRepoName}/${safeName}`,
    repoName: safeRepoName,
    changeName: safeName,
    path: targetPath,
  };
}

function resolveWorkspaceContext(
  currentDirectory: string,
  directories: WorkforestDirectories,
): WorkforestManagedContext | null {
  const parts = relativeParts(directories.workspaces, currentDirectory);
  if (!parts || parts.length < 2) {
    return null;
  }

  const [groupName, changeName, third, fourth, fifth] = parts;
  if (!groupName || !changeName) {
    return null;
  }
  const safeGroupName = safeWorkspaceGroupName(groupName);
  const safeName = safeResourceName(changeName);
  if (!safeGroupName || !safeName) {
    return null;
  }

  const workspacePath = path.join(
    directories.workspaces,
    safeGroupName,
    safeName,
  );
  const selector = `${safeGroupName}/${safeName}`;

  if (third === TASKS_DIRECTORY_NAME) {
    if (!fourth || !fifth) {
      return null;
    }
    const safeRepoName = safeRepositoryComponent(fourth);
    const safeTaskName = safeResourceName(fifth);
    if (!safeRepoName || !safeTaskName) {
      return null;
    }
    return {
      kind: "nested-task",
      parentKind: "workspace",
      parentSelector: selector,
      groupName: safeGroupName,
      repoName: safeRepoName,
      changeName: safeName,
      taskName: safeTaskName,
      path: path.join(
        workspacePath,
        TASKS_DIRECTORY_NAME,
        safeRepoName,
        safeTaskName,
      ),
    };
  }

  const safeRepoName = third ? safeRepositoryComponent(third) : null;
  if (!safeRepoName) {
    return safeGroupName === ADHOC_WORKSPACE_GROUP
      ? {
          kind: "adhoc-workspace",
          selector,
          groupName: ADHOC_WORKSPACE_GROUP,
          changeName: safeName,
          path: workspacePath,
        }
      : {
          kind: "template-workspace",
          selector,
          groupName: safeGroupName,
          changeName: safeName,
          path: workspacePath,
        };
  }

  return {
    kind: "workspace-repo",
    selector,
    groupName: safeGroupName,
    changeName: safeName,
    repoName: safeRepoName,
    workspacePath,
    path: path.join(workspacePath, safeRepoName),
  };
}

function resolveReviewContext(
  currentDirectory: string,
  directories: WorkforestDirectories,
): ReviewCheckoutContext | null {
  const parts = relativeParts(directories.reviews, currentDirectory);
  if (!parts || parts.length < 1) {
    return null;
  }

  const [repoName] = parts;
  if (!repoName) {
    return null;
  }
  const safeRepoName = safeRepositoryComponent(repoName);
  if (!safeRepoName) {
    return null;
  }

  return {
    kind: "review-checkout",
    repoName: safeRepoName,
    path: path.join(directories.reviews, safeRepoName),
  };
}

function relativeParts(
  root: string,
  currentDirectory: string,
): string[] | null {
  if (!isPathInsideOrEqual(root, currentDirectory)) {
    return null;
  }

  const relative = path.relative(path.resolve(root), currentDirectory);
  return relative ? relative.split(path.sep).filter(Boolean) : [];
}

function safeRepositoryComponent(value: string): string | null {
  try {
    return validateRepositoryComponent(value, "Repository name");
  } catch {
    return null;
  }
}

function safeResourceName(value: string): string | null {
  try {
    return validateResourceName(value, "Name");
  } catch {
    return null;
  }
}

function safeWorkspaceGroupName(value: string): string | null {
  if (value === ADHOC_WORKSPACE_GROUP) {
    return value;
  }

  try {
    return validateTemplateIdentifier(value);
  } catch {
    return null;
  }
}
