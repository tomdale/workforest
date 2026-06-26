import { promises as fs } from "node:fs";
import path from "node:path";
import { loadWorkspaceConfig } from "../config.ts";
import { resolveRepositorySpecifiers } from "../repository-specifiers.ts";
import { runGit } from "../services/git.ts";
import { loadTemplate } from "../templates/index.ts";
import type { RepoConfig, WorkspaceMetadata } from "../types.ts";
import {
  buildBranchName,
  resolveBranchPrefix,
} from "../utils/branch-prefix.ts";
import { validateResourceName } from "../utils/path-safety.ts";
import { resolveWorkforestContext } from "../workspace/context.ts";
import {
  type CreateChangeOptions,
  createChange,
  type ResolvedStartSource,
} from "../workspace/create-change.ts";
import { readWorkspaceMetadata } from "../workspace/metadata.ts";
import {
  ADHOC_WORKSPACE_GROUP,
  getWorkspaceChangePath,
  resolveWorkforestDirectories,
  type WorkforestDirectories,
} from "../workspace/paths.ts";
import { OperationalError, UsageError } from "./errors.ts";
import { success } from "./output.ts";
import type { CommandResult, ParsedInvocation } from "./types.ts";

export type ParsedStartOperands = Readonly<{
  changeName: string;
  source:
    | Readonly<{ kind: "current" }>
    | Readonly<{ kind: "repositories"; tokens: readonly string[] }>
    | Readonly<{ kind: "template"; templateName: string }>;
}>;

type StartSource = ResolvedStartSource;

export type RunStartCommandOptions = CreateChangeOptions;

const START_CONTEXT_ERROR = [
  "Not in a Workforest-managed repo or workspace.",
  "Start explicitly: wf start <change> <repo|@template>",
].join("\n");

export async function runStartCommand(
  invocation: ParsedInvocation,
  options: RunStartCommandOptions,
): Promise<CommandResult> {
  const parsed = parseStartOperands(invocation.beforeDoubleDash);
  const explicitBranchName = await parseExplicitBranchFlag(
    invocation.flags["branch"],
  );
  const { config } = await loadWorkspaceConfig();
  const directories = resolveWorkforestDirectories(config);
  const source =
    parsed.source.kind === "current"
      ? await resolveCurrentStartSource(directories)
      : await resolveExplicitStartSource(parsed.source);

  const changeName = validateResourceName(parsed.changeName, "Change name");
  const branchName =
    explicitBranchName ??
    buildBranchName(
      changeName,
      source.kind === "template"
        ? resolveBranchPrefix(config.branchPrefix, source.branchPrefix)
        : config.branchPrefix,
    );

  await createChange({ changeName, source, branchName, directories }, options);
  return success();
}

export function parseStartOperands(
  operands: readonly string[],
): ParsedStartOperands {
  const [changeName, ...sourceTokens] = operands;
  if (!changeName) {
    throw new UsageError("wf start requires a change name.");
  }

  validateResourceName(changeName, "Change name");
  if (sourceTokens.length === 0) {
    return { changeName, source: { kind: "current" } };
  }

  const templateTokens = sourceTokens.filter((token) => token.startsWith("@"));
  if (templateTokens.length > 0) {
    if (sourceTokens.length !== 1) {
      throw new UsageError(
        "Template sources cannot be combined with repository sources.",
      );
    }

    const templateName = templateTokens[0]?.slice(1) ?? "";
    if (!templateName) {
      throw new UsageError("Template source must be @<template>.");
    }
    validateResourceName(templateName, "Template name");
    return { changeName, source: { kind: "template", templateName } };
  }

  return { changeName, source: { kind: "repositories", tokens: sourceTokens } };
}

async function parseExplicitBranchFlag(
  value: boolean | string | undefined,
): Promise<string | undefined> {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new UsageError('Flag "--branch" requires a branch name.');
  }

  const branchName = value.trim();
  if (branchName.length === 0) {
    throw new UsageError('Flag "--branch" requires a non-empty branch name.');
  }

  try {
    await runGit(["check-ref-format", "--branch", branchName]);
  } catch {
    throw new UsageError(`Invalid Git branch name: ${branchName}`);
  }

  return branchName;
}

async function resolveExplicitStartSource(
  source: Exclude<ParsedStartOperands["source"], { kind: "current" }>,
): Promise<StartSource> {
  if (source.kind === "template") {
    return resolveTemplateStartSource(source.templateName);
  }

  const repos = await resolveRepositorySpecifiers(source.tokens);
  if (repos.length === 1) {
    const repo = repos[0];
    if (!repo) throw new Error("No repositories specified.");
    return { kind: "repository", repo };
  }
  if (repos.length === 0) {
    throw new UsageError("No repositories specified.");
  }
  return { kind: "adhoc", repos };
}

async function resolveTemplateStartSource(
  templateName: string,
): Promise<StartSource> {
  const template = await loadTemplate(templateName);
  if (!template) {
    throw new UsageError(`Unknown template: @${templateName}`);
  }

  return {
    kind: "template",
    templateId: template.id,
    repos: await resolveRepositorySpecifiers(template.config.repos),
    ...(template.config.branchPrefix !== undefined
      ? { branchPrefix: template.config.branchPrefix }
      : {}),
  };
}

async function resolveCurrentStartSource(
  directories: WorkforestDirectories,
): Promise<StartSource> {
  const context = resolveWorkforestContext(
    await comparablePath(process.cwd()),
    await comparableDirectories(directories),
  );

  if (context.kind === "repository-change") {
    return resolveRepositoryStartSource(context.repoName);
  }
  if (
    context.kind === "nested-task" &&
    context.parentKind === "repository-change"
  ) {
    return resolveRepositoryStartSource(context.repoName);
  }

  if (context.kind === "template-workspace-change") {
    return resolveTemplateStartSource(context.groupName);
  }
  if (context.kind === "workspace-repo") {
    if (context.groupName === ADHOC_WORKSPACE_GROUP) {
      return resolveAdhocStartSource(context.workspacePath);
    }
    return resolveTemplateStartSource(context.groupName);
  }
  if (context.kind === "adhoc-workspace-change") {
    return resolveAdhocStartSource(context.path);
  }
  if (
    context.kind === "nested-task" &&
    context.parentKind === "workspace-change"
  ) {
    if (context.groupName === ADHOC_WORKSPACE_GROUP) {
      return resolveAdhocStartSource(
        getWorkspaceChangePath(
          directories,
          context.groupName,
          context.changeName,
        ),
      );
    }
    if (context.groupName) {
      return resolveTemplateStartSource(context.groupName);
    }
  }

  throw new OperationalError(START_CONTEXT_ERROR);
}

async function resolveRepositoryStartSource(
  repoName: string,
): Promise<StartSource> {
  const [repo] = await resolveRepositorySpecifiers([repoName]);
  if (!repo) {
    throw new OperationalError(`Cached repository not found: ${repoName}`);
  }
  return { kind: "repository", repo };
}

async function resolveAdhocStartSource(
  workspaceDir: string,
): Promise<StartSource> {
  const metadata = await readWorkspaceMetadata(workspaceDir);
  if (!metadata) {
    throw new OperationalError(
      `Could not read workspace metadata from ${workspaceDir}`,
    );
  }

  return { kind: "adhoc", repos: reposFromMetadata(metadata) };
}

function reposFromMetadata(metadata: WorkspaceMetadata): RepoConfig[] {
  return metadata.repos.map((repo) => ({
    name: repo.name,
    remote: repo.remote,
    defaultBranch: repo.default_branch,
  }));
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
