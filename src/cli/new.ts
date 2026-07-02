import { promises as fs } from "node:fs";
import path from "node:path";
import { loadWorkspaceConfig } from "../config.ts";
import { resolveRepositorySpecifiers } from "../repository-specifiers.ts";
import { runGit } from "../services/git.ts";
import {
  loadTemplate,
  validateTemplateIdentifier,
} from "../templates/index.ts";
import type { RepositorySource, WorkspaceMetadata } from "../types.ts";
import {
  buildBranchName,
  resolveBranchPrefix,
} from "../utils/branch-prefix.ts";
import { validateResourceName } from "../utils/path-safety.ts";
import { resolveWorkforestContext } from "../workspace/context.ts";
import {
  type CreateOptions,
  create,
  type ResolvedSource,
} from "../workspace/create.ts";
import { readWorkspaceMetadata } from "../workspace/metadata.ts";
import {
  ADHOC_WORKSPACE_GROUP,
  getWorkspacePath,
  resolveWorkforestDirectories,
  type WorkforestDirectories,
} from "../workspace/paths.ts";
import { OperationalError, UsageError } from "./errors.ts";
import { success } from "./output.ts";
import type { CommandResult, ParsedInvocation } from "./types.ts";

export type ParsedNewOperands = Readonly<{
  changeName: string;
  source:
    | Readonly<{ kind: "current" }>
    | Readonly<{ kind: "repositories"; tokens: readonly string[] }>
    | Readonly<{ kind: "template"; templateName: string }>;
}>;

type SourceSpec = ResolvedSource;

export type RunNewCommandOptions = CreateOptions;

export const NEW_CONTEXT_ERROR = [
  "Not in a Workforest-managed repo or workspace.",
  "Create explicitly: wf new <name> <repo|@template>",
].join("\n");

export async function runNewCommand(
  invocation: ParsedInvocation,
  options: RunNewCommandOptions,
): Promise<CommandResult> {
  const parsed = parseNewOperands(invocation.beforeDoubleDash);
  const explicitBranchName = await parseExplicitBranchFlag(
    invocation.flags["branch"],
  );
  const { config } = await loadWorkspaceConfig();
  const directories = resolveWorkforestDirectories(config);
  const source =
    parsed.source.kind === "current"
      ? await resolveCurrentSource(directories)
      : await resolveExplicitSource(parsed.source);

  const changeName = validateResourceName(parsed.changeName, "Name");
  const branchName =
    explicitBranchName ??
    buildBranchName(
      changeName,
      source.kind === "template"
        ? resolveBranchPrefix(config.branchPrefix, source.branchPrefix)
        : config.branchPrefix,
    );

  if (invocation.flags["cloud"] === true) {
    const { createCloud } = await import("../cloud/provisioning.ts");
    await createCloud(
      { changeName, source, branchName, directories },
      {
        interactive: options.interactive,
        config,
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      },
    );
    return success();
  }

  await create({ changeName, source, branchName, directories }, options);
  return success();
}

export function parseNewOperands(
  operands: readonly string[],
): ParsedNewOperands {
  const [changeName, ...sourceTokens] = operands;
  if (!changeName) {
    throw new UsageError("wf new requires a name.");
  }

  validateResourceName(changeName, "Name");
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
    validateTemplateIdentifier(templateName);
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

async function resolveExplicitSource(
  source: Exclude<ParsedNewOperands["source"], { kind: "current" }>,
): Promise<SourceSpec> {
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
): Promise<SourceSpec> {
  const template = await loadTemplate(templateName);
  if (!template) {
    throw new UsageError(`Unknown template: @${templateName}`);
  }

  return {
    kind: "template",
    groupName: template.id,
    templateId: template.parentId,
    ...(template.variantId ? { templateVariant: template.variantId } : {}),
    repos: await resolveRepositorySpecifiers(template.config.repos),
    ...(template.config.branchPrefix !== undefined
      ? { branchPrefix: template.config.branchPrefix }
      : {}),
  };
}

async function resolveCurrentSource(
  directories: WorkforestDirectories,
): Promise<SourceSpec> {
  const context = resolveWorkforestContext(
    await comparablePath(process.cwd()),
    await comparableDirectories(directories),
  );

  if (context.kind === "repository-root" || context.kind === "worktree") {
    return resolveRepositoryStartSource(context.repoName);
  }
  if (context.kind === "nested-task" && context.parentKind === "worktree") {
    return resolveRepositoryStartSource(context.repoName);
  }

  if (context.kind === "template-workspace") {
    return resolveTemplateStartSource(context.groupName);
  }
  if (context.kind === "workspace-repo") {
    if (context.groupName === ADHOC_WORKSPACE_GROUP) {
      return resolveAdhocStartSource(context.workspacePath);
    }
    return resolveTemplateStartSource(context.groupName);
  }
  if (context.kind === "adhoc-workspace") {
    return resolveAdhocStartSource(context.path);
  }
  if (context.kind === "nested-task" && context.parentKind === "workspace") {
    if (context.groupName === ADHOC_WORKSPACE_GROUP) {
      return resolveAdhocStartSource(
        getWorkspacePath(directories, context.groupName, context.changeName),
      );
    }
    if (context.groupName) {
      return resolveTemplateStartSource(context.groupName);
    }
  }

  throw new OperationalError(NEW_CONTEXT_ERROR);
}

async function resolveRepositoryStartSource(
  repoName: string,
): Promise<SourceSpec> {
  const [repo] = await resolveRepositorySpecifiers([repoName]);
  if (!repo) {
    throw new OperationalError(`Cached repository not found: ${repoName}`);
  }
  return { kind: "repository", repo };
}

async function resolveAdhocStartSource(
  workspaceDir: string,
): Promise<SourceSpec> {
  const metadata = await readWorkspaceMetadata(workspaceDir);
  if (!metadata) {
    throw new OperationalError(
      `Could not read workspace metadata from ${workspaceDir}`,
    );
  }

  return { kind: "adhoc", repos: reposFromMetadata(metadata) };
}

function reposFromMetadata(metadata: WorkspaceMetadata): RepositorySource[] {
  return metadata.repos.map((repo) => ({
    name: repo.name,
    remote: repo.remote,
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
