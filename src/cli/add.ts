import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "@wf-plugin/core";
import { loadWorkspaceConfig } from "../config.ts";
import { log } from "../logger.ts";
import { resolveRepositorySpecifiers } from "../repository-specifiers.ts";
import type { ServiceEventSink } from "../services/events.ts";
import { runGit } from "../services/git.ts";
import { isShellAutoCdEnabled } from "../shell.ts";
import { invalidateWorkspaceAgentsMd } from "../templates/agents-md.ts";
import { loadTemplate } from "../templates/index.ts";
import type { RepoConfig, WorkspaceMetadata } from "../types.ts";
import { promptConfirm } from "../ui/prompts/index.ts";
import {
  resolveWorkforestContext,
  type WorkforestManagedContext,
} from "../workspace/context.ts";
import {
  addReposToWorkspace,
  writeVSCodeWorkspaceFile,
} from "../workspace/index.ts";
import {
  readWorkspaceMetadata,
  removeRepositoryChangeMetadata,
  writeWorkspaceMetadata,
} from "../workspace/metadata.ts";
import {
  ADHOC_WORKSPACE_GROUP,
  getWorkspaceChangePath,
  getWorkspaceRepoPath,
  resolveWorkforestDirectories,
  type WorkforestDirectories,
} from "../workspace/paths.ts";
import { OperationalError, UsageError } from "./errors.ts";
import { success } from "./output.ts";
import type { CommandResult, ParsedInvocation } from "./types.ts";

export type ParsedAddOperands = Readonly<
  | { kind: "repositories"; tokens: readonly string[] }
  | { kind: "template"; templateName: string }
>;

export type RunAddCommandOptions = Readonly<{
  interactive: boolean;
  onEvent?: ServiceEventSink;
  writeShellCdPath: (targetDir: string) => Promise<void>;
  confirm?: typeof promptConfirm;
  addReposToWorkspace?: typeof addReposToWorkspace;
  moveRepoWorktree?: typeof moveRepoWorktree;
}>;

type WorkspaceAddTarget = Readonly<{
  workspaceDir: string;
  metadata: WorkspaceMetadata;
}>;

type RepositoryPromotionTarget = Readonly<{
  repoName: string;
  changeName: string;
  sourcePath: string;
}>;

export async function runChangeAddCommand(
  invocation: ParsedInvocation,
  options: RunAddCommandOptions,
): Promise<CommandResult> {
  const parsed = parseAddOperands(invocation.beforeDoubleDash);
  const yes = invocation.flags["yes"] === true;
  const { config } = await loadWorkspaceConfig();
  const directories = resolveWorkforestDirectories(config);
  const context = resolveWorkforestContext(
    await comparablePath(process.cwd()),
    await comparableDirectories(directories),
  );

  if (
    context.kind === "template-workspace-change" ||
    context.kind === "adhoc-workspace-change" ||
    context.kind === "workspace-repo" ||
    (context.kind === "nested-task" &&
      context.parentKind === "workspace-change")
  ) {
    const target = await resolveWorkspaceAddTarget(context, directories);
    return addToWorkspaceChange(parsed, target, options);
  }

  if (
    context.kind === "repository-change" ||
    (context.kind === "nested-task" &&
      context.parentKind === "repository-change")
  ) {
    const target =
      context.kind === "repository-change"
        ? {
            repoName: context.repoName,
            changeName: context.changeName,
            sourcePath: context.path,
          }
        : {
            repoName: context.repoName,
            changeName: context.changeName,
            sourcePath: path.join(
              directories.repos,
              context.repoName,
              context.changeName,
            ),
          };
    return promoteRepositoryChange(parsed, target, directories, {
      ...options,
      yes,
    });
  }

  throw new OperationalError(
    "Not in a Workforest-managed repo or workspace.\nStart explicitly: wf start <change> <repo|@template>",
  );
}

export function parseAddOperands(
  operands: readonly string[],
): ParsedAddOperands {
  if (operands.length === 0) {
    throw new UsageError("wf add requires a repository or @template source.");
  }

  const templateTokens = operands.filter((token) => token.startsWith("@"));
  if (templateTokens.length > 0) {
    if (operands.length !== 1) {
      throw new UsageError(
        "Template sources cannot be combined with repository sources.",
      );
    }

    const templateName = templateTokens[0]?.slice(1) ?? "";
    if (!templateName) {
      throw new UsageError("Template source must be @<template>.");
    }
    return { kind: "template", templateName };
  }

  return { kind: "repositories", tokens: operands };
}

async function addToWorkspaceChange(
  parsed: ParsedAddOperands,
  target: WorkspaceAddTarget,
  options: RunAddCommandOptions,
): Promise<CommandResult> {
  if (parsed.kind === "template") {
    throw new UsageError(
      "Template sources can only promote a repository change.",
    );
  }

  const repos = await resolveRepositorySpecifiers(parsed.tokens);
  const branchName = existingBranchName(target.metadata);
  const result = await (options.addReposToWorkspace ?? addReposToWorkspace)({
    workspaceDir: target.workspaceDir,
    repos,
    branchName,
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });

  if (result.failedRepos.length > 0) {
    throw new OperationalError(
      `Failed to add ${result.failedRepos.length} repo${result.failedRepos.length === 1 ? "" : "s"}.`,
    );
  }

  if (result.addedRepos.length > 0) {
    log.success(
      `Added ${result.addedRepos.length} repo${result.addedRepos.length === 1 ? "" : "s"} to ${target.metadata.workspace.feature_name}.`,
    );
    const templateId = target.metadata.workspace.template_id;
    const template = templateId ? await loadTemplate(templateId) : null;
    if (template)
      await invalidateWorkspaceAgentsMd(template, target.workspaceDir);
  }
  await options.writeShellCdPath(target.workspaceDir);
  return success();
}

async function promoteRepositoryChange(
  parsed: ParsedAddOperands,
  target: RepositoryPromotionTarget,
  directories: WorkforestDirectories,
  options: RunAddCommandOptions & Readonly<{ yes: boolean }>,
): Promise<CommandResult> {
  const currentRepo = await resolveCurrentRepo(target.repoName);
  const branchName =
    (await currentBranch(target.sourcePath)) ?? target.changeName;
  const sourceRepos = await resolvePromotionRepos(parsed, currentRepo);
  const groupName =
    sourceRepos.kind === "template"
      ? sourceRepos.templateId
      : ADHOC_WORKSPACE_GROUP;
  const workspaceDir = getWorkspaceChangePath(
    directories,
    groupName,
    target.changeName,
  );
  const destinationPath = getWorkspaceRepoPath(
    directories,
    groupName,
    target.changeName,
    currentRepo.name,
  );

  await confirmPromotion({
    sourcePath: target.sourcePath,
    destinationPath,
    addedRepos: sourceRepos.repos,
    yes: options.yes,
    options,
  });

  if (await pathExists(destinationPath)) {
    throw new OperationalError(
      `Target directory already exists: ${destinationPath}`,
    );
  }
  await fs.mkdir(workspaceDir, { recursive: true });
  await (options.moveRepoWorktree ?? moveRepoWorktree)(
    target.sourcePath,
    destinationPath,
  );

  await writeWorkspaceMetadata(workspaceDir, {
    featureName: target.changeName,
    branchName,
    repos: [
      {
        name: currentRepo.name,
        remote: currentRepo.remote,
        defaultBranch: currentRepo.defaultBranch,
        hasLockfile: await hasLockfile(destinationPath),
      },
    ],
    ...(sourceRepos.kind === "template"
      ? { templateId: sourceRepos.templateId }
      : {}),
  });
  await writeVSCodeWorkspaceFile(workspaceDir, [currentRepo], {
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });
  await removeRepositoryChangeMetadata(
    path.dirname(target.sourcePath),
    target.changeName,
  );

  if (sourceRepos.repos.length > 0) {
    const result = await (options.addReposToWorkspace ?? addReposToWorkspace)({
      workspaceDir,
      repos: sourceRepos.repos,
      branchName,
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    });

    if (result.failedRepos.length > 0) {
      throw new OperationalError(
        `Failed to add ${result.failedRepos.length} repo${result.failedRepos.length === 1 ? "" : "s"}.`,
      );
    }
  }

  await options.writeShellCdPath(workspaceDir);
  log.success(`Promoted change to workspace: ${workspaceDir}`);
  if (!isShellAutoCdEnabled()) {
    log.info(`Run: cd ${workspaceDir}`);
  }
  return success();
}

async function resolveWorkspaceAddTarget(
  context: WorkforestManagedContext,
  directories: WorkforestDirectories,
): Promise<WorkspaceAddTarget> {
  const workspaceDir =
    context.kind === "workspace-repo"
      ? context.workspacePath
      : context.kind === "nested-task"
        ? getWorkspaceChangePath(
            directories,
            context.groupName ?? ADHOC_WORKSPACE_GROUP,
            context.changeName,
          )
        : context.path;
  const metadata = await readWorkspaceMetadata(workspaceDir);
  if (!metadata) {
    throw new OperationalError(
      `Could not read workspace metadata from ${workspaceDir}`,
    );
  }
  return { workspaceDir, metadata };
}

async function resolvePromotionRepos(
  parsed: ParsedAddOperands,
  currentRepo: RepoConfig,
): Promise<
  | Readonly<{ kind: "adhoc"; repos: readonly RepoConfig[] }>
  | Readonly<{
      kind: "template";
      templateId: string;
      repos: readonly RepoConfig[];
    }>
> {
  if (parsed.kind === "repositories") {
    const repos = await resolveRepositorySpecifiers(parsed.tokens);
    const duplicate = repos.find(
      (repo) =>
        repo.name === currentRepo.name || repo.remote === currentRepo.remote,
    );
    if (duplicate) {
      throw new UsageError(
        `Change already contains repository "${currentRepo.name}".`,
      );
    }
    return { kind: "adhoc", repos };
  }

  const template = await loadTemplate(parsed.templateName);
  if (!template) {
    throw new UsageError(`Unknown template: @${parsed.templateName}`);
  }
  const templateRepos = await resolveRepositorySpecifiers(
    template.config.repos,
  );
  const currentIndex = templateRepos.findIndex(
    (repo) =>
      repo.name === currentRepo.name || repo.remote === currentRepo.remote,
  );
  if (currentIndex === -1) {
    throw new UsageError(
      `Repository "${currentRepo.name}" is not part of @${template.id}.`,
    );
  }

  return {
    kind: "template",
    templateId: template.id,
    repos: templateRepos.filter((_, index) => index !== currentIndex),
  };
}

async function confirmPromotion({
  sourcePath,
  destinationPath,
  addedRepos,
  yes,
  options,
}: {
  sourcePath: string;
  destinationPath: string;
  addedRepos: readonly RepoConfig[];
  yes: boolean;
  options: RunAddCommandOptions;
}): Promise<void> {
  log.info(`Source: ${sourcePath}`);
  log.info(`Destination: ${destinationPath}`);
  log.info(
    `Adding: ${addedRepos.length > 0 ? addedRepos.map((repo) => repo.name).join(", ") : "(none)"}`,
  );
  if (yes) return;
  if (!options.interactive) {
    throw new UsageError(
      "Promoting a repository change requires --yes without an interactive terminal.",
    );
  }
  const confirmed = await (options.confirm ?? promptConfirm)(
    "Promote repository change into a workspace?",
    false,
  );
  if (!confirmed) {
    throw new OperationalError("Promotion cancelled.");
  }
}

async function resolveCurrentRepo(repoName: string): Promise<RepoConfig> {
  const [repo] = await resolveRepositorySpecifiers([repoName]);
  if (!repo) {
    throw new OperationalError(`Cached repository not found: ${repoName}`);
  }
  return repo;
}

function existingBranchName(metadata: WorkspaceMetadata): string {
  return (
    metadata.repos.find((repo) => repo.feature_branch)?.feature_branch ??
    metadata.workspace.feature_name
  );
}

async function currentBranch(repoDir: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(["branch", "--show-current"], {
      cwd: repoDir,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function hasLockfile(repoDir: string): Promise<boolean> {
  return (
    (await pathExists(path.join(repoDir, "pnpm-lock.yaml"))) ||
    (await pathExists(path.join(repoDir, "pnpm-lock.yml")))
  );
}

async function moveRepoWorktree(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const { stdout } = await runGit(["rev-parse", "--git-common-dir"], {
    cwd: sourcePath,
  });
  const rawCommonDir = stdout.trim();
  const commonDir = path.isAbsolute(rawCommonDir)
    ? rawCommonDir
    : path.resolve(sourcePath, rawCommonDir);
  await runGit(["worktree", "move", sourcePath, destinationPath], {
    cwd: commonDir,
  });
}

async function comparableDirectories(
  directories: WorkforestDirectories,
): Promise<WorkforestDirectories> {
  const [base, repos, workspaces, reviews] = await Promise.all([
    comparablePath(directories.base),
    comparablePath(directories.repos),
    comparablePath(directories.workspaces),
    comparablePath(directories.reviews),
  ]);
  return { base, repos, workspaces, reviews };
}

async function comparablePath(value: string): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch {
    return path.resolve(value);
  }
}
