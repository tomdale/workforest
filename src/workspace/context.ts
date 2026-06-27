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

export type RepositoryChangeContext = Readonly<{
  kind: "repository-change";
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

export type TemplateWorkspaceChangeContext = Readonly<{
  kind: "template-workspace-change";
  selector: string;
  groupName: string;
  changeName: string;
  path: string;
}>;

export type AdhocWorkspaceChangeContext = Readonly<{
  kind: "adhoc-workspace-change";
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
  parentKind: "repository-change" | "workspace-change";
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
  | RepositoryChangeContext
  | RepositoryRootContext
  | TemplateWorkspaceChangeContext
  | AdhocWorkspaceChangeContext
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
    const safeChangeName = safeResourceName(third);
    const safeTaskName = safeResourceName(fourth);
    if (!safeChangeName || !safeTaskName) {
      return null;
    }
    const taskPath = path.join(
      directories.repos,
      safeRepoName,
      TASKS_DIRECTORY_NAME,
      safeChangeName,
      safeTaskName,
    );
    return {
      kind: "nested-task",
      parentKind: "repository-change",
      parentSelector: `${safeRepoName}/${safeChangeName}`,
      repoName: safeRepoName,
      changeName: safeChangeName,
      taskName: safeTaskName,
      path: taskPath,
    };
  }

  const safeChangeName = safeResourceName(second);
  if (!safeChangeName) {
    return null;
  }
  const changePath = path.join(repositoryRootPath, safeChangeName);
  return {
    kind: "repository-change",
    selector: `${safeRepoName}/${safeChangeName}`,
    repoName: safeRepoName,
    changeName: safeChangeName,
    path: changePath,
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
  const safeChangeName = safeResourceName(changeName);
  if (!safeGroupName || !safeChangeName) {
    return null;
  }

  const workspacePath = path.join(
    directories.workspaces,
    safeGroupName,
    safeChangeName,
  );
  const selector = `${safeGroupName}/${safeChangeName}`;

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
      parentKind: "workspace-change",
      parentSelector: selector,
      groupName: safeGroupName,
      repoName: safeRepoName,
      changeName: safeChangeName,
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
          kind: "adhoc-workspace-change",
          selector,
          groupName: ADHOC_WORKSPACE_GROUP,
          changeName: safeChangeName,
          path: workspacePath,
        }
      : {
          kind: "template-workspace-change",
          selector,
          groupName: safeGroupName,
          changeName: safeChangeName,
          path: workspacePath,
        };
  }

  return {
    kind: "workspace-repo",
    selector,
    groupName: safeGroupName,
    changeName: safeChangeName,
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
    return validateResourceName(value, "Change name");
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
