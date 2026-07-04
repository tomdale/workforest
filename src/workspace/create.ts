import { promises as fs } from "node:fs";
import path from "node:path";
import { UsageError } from "../cli/errors.ts";
import { loadWorkspaceConfig } from "../config.ts";
import { log } from "../logger.ts";
import { resolveRepositorySpecifiers } from "../repository-specifiers.ts";
import type { ServiceEventSink } from "../services/events.ts";
import { reportShellCdTarget } from "../shell.ts";
import { loadTemplate } from "../templates/index.ts";
import type { RepositorySource } from "../types.ts";
import {
  presentPipelines,
  type renderPipelinesGrid,
  type shouldUseGrid,
} from "../ui/grid-consumer.ts";
import {
  buildBranchName,
  resolveBranchPrefix,
} from "../utils/branch-prefix.ts";
import { validateResourceName } from "../utils/path-safety.ts";
import {
  createRunFailureSummary,
  printRepoSetupFailures,
  type RepoSetupFailureSummary,
  runScopedRepoSetupPipeline,
  stampWorkspace,
} from "./index.ts";
import {
  initializeWorktreeSetup,
  worktreeInitializationScope,
} from "./initialization.ts";
import { writeWorktreeMetadata } from "./metadata.ts";
import {
  ADHOC_WORKSPACE_GROUP,
  getWorkspacePath,
  getWorktreePath,
  resolveWorkforestDirectories,
  type WorkforestDirectories,
} from "./paths.ts";
import { createRunSession } from "./run-log/session.ts";

/**
 * A start source that has already been resolved to concrete repositories.
 * This is the input contract shared by `wf new` and the entry surface.
 */
export type ResolvedSource =
  | Readonly<{ kind: "repository"; repo: RepositorySource }>
  | Readonly<{ kind: "adhoc"; repos: readonly RepositorySource[] }>
  | Readonly<{
      kind: "template";
      templateId: string;
      templateVariant?: string;
      groupName: string;
      repos: readonly RepositorySource[];
      branchPrefix?: string;
    }>;

export type CreateInput = Readonly<{
  changeName: string;
  source: ResolvedSource;
  branchName: string;
  directories: WorkforestDirectories;
}>;

export type CreateOptions = Readonly<{
  interactive: boolean;
  onEvent?: ServiceEventSink;
  writeShellCdPath: (targetDir: string) => Promise<void>;
  initializeWorktreeSetup?: typeof initializeWorktreeSetup;
  runScopedRepoSetupPipeline?: typeof runScopedRepoSetupPipeline;
  stampWorkspace?: typeof stampWorkspace;
  renderPipelinesGrid?: typeof renderPipelinesGrid;
  shouldUseGrid?: typeof shouldUseGrid;
}>;

export type CreateResult = Readonly<{
  targetDir: string;
  setupFailures: readonly RepoSetupFailureSummary[];
}>;

/**
 * Reusable change-creation core: everything that happens after a start source
 * has been resolved and a branch name derived. Single-repo changes land in a
 * per-repo change layout; multi-repo (adhoc/template) changes are stamped into
 * a workspace. Presentation (grid vs. console fallback) is chosen here based on
 * `interactive` and `shouldUseGrid`, so both `wf new` and any future surface
 * get identical behavior by calling this one function.
 */
export async function create(
  input: CreateInput,
  options: CreateOptions,
): Promise<CreateResult> {
  const { source } = input;
  if (source.kind === "repository") {
    return createWorktree({ ...input, source }, options);
  }
  return createWorkspace({ ...input, source }, options);
}

type WorktreeInput = CreateInput &
  Readonly<{ source: Extract<ResolvedSource, { kind: "repository" }> }>;

type WorkspaceInput = CreateInput &
  Readonly<{
    source: Exclude<ResolvedSource, { kind: "repository" }>;
  }>;

/**
 * Single-repo change creation. Routes the one repo's setup through the same
 * seam as workspaces — grid when interactive, inline drain otherwise — with
 * initialization handed to a detached worker and metadata/finalization deferred
 * to onBeforeCompletionPrompt so both surfaces finalize identically.
 */
async function createWorktree(
  input: WorktreeInput,
  options: CreateOptions,
): Promise<CreateResult> {
  const { changeName, branchName, directories } = input;
  const repo = input.source.repo;
  const targetDir = getWorktreePath(directories, repo.name, changeName);
  const repoRootDir = path.dirname(targetDir);
  await fs.mkdir(repoRootDir, { recursive: true });

  const scope = worktreeInitializationScope({ repoRootDir, changeName });
  await writeWorktreeMetadata(repoRootDir, {
    featureName: changeName,
    branchName,
    repos: [{ ...repo, hasLockfile: false }],
  });
  await (options.initializeWorktreeSetup ?? initializeWorktreeSetup)({
    repoRootDir,
    changeName,
    repo,
  });

  const session = await createRunSession({
    scope,
    command: "new",
    repos: [repo.name],
  });

  const setupFailures = new Map<string, RepoSetupFailureSummary>();
  try {
    await presentPipelines({
      pipelines: new Map([
        [
          repo.name,
          (options.runScopedRepoSetupPipeline ?? runScopedRepoSetupPipeline)({
            repo,
            scope,
            rootDir: repoRootDir,
            repoDir: targetDir,
            branchName,
            isNewWorkspace: true,
            monitorBackground: options.interactive,
            session,
          }),
        ],
      ]),
      repoNames: [repo.name],
      interactive: options.interactive,
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      workspacePath: targetDir,
      getLogPath: () => Promise.resolve(session.runDir),
      onFailure: (repoName, state) => {
        setupFailures.set(
          repoName,
          createRunFailureSummary({
            session,
            repoName,
            error: state.error,
            ...(state.step ? { step: state.step } : {}),
          }),
        );
      },
      onBeforeCompletionPrompt: async (results) => {
        await writeWorktreeMetadata(repoRootDir, {
          featureName: changeName,
          branchName,
          repos: [
            {
              ...repo,
              hasLockfile: results.get(repo.name)?.hasLockfile ?? false,
            },
          ],
        });
      },
      completeOnWorktreesReady: true,
      backgroundInitialization: true,
      ...(options.renderPipelinesGrid
        ? { renderPipelinesGrid: options.renderPipelinesGrid }
        : {}),
      ...(options.shouldUseGrid
        ? { shouldUseGrid: options.shouldUseGrid }
        : {}),
    });
  } finally {
    await session.close().catch(() => undefined);
  }

  const failures = [...setupFailures.values()];
  printRepoSetupFailures(failures, options.onEvent);

  log.success(`Change ready: ${targetDir}`);
  await reportShellCdTarget(targetDir, {
    writeShellCdPath: options.writeShellCdPath,
  });

  return { targetDir, setupFailures: failures };
}

async function createWorkspace(
  input: WorkspaceInput,
  options: CreateOptions,
): Promise<CreateResult> {
  const { changeName, branchName, directories, source } = input;
  const groupName =
    source.kind === "template" ? source.groupName : ADHOC_WORKSPACE_GROUP;
  const workspaceDir = getWorkspacePath(directories, groupName, changeName);

  // One path: stampWorkspace renders the grid when interactive and drains to
  // events otherwise, deferring finalization identically either way.
  const result = await (options.stampWorkspace ?? stampWorkspace)({
    featureName: changeName,
    branchName,
    workspaceDir,
    repos: source.repos,
    ...(source.kind === "template"
      ? {
          templateId: source.templateId,
          ...(source.templateVariant
            ? { templateVariant: source.templateVariant }
            : {}),
        }
      : {}),
    interactive: options.interactive,
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    ...(options.renderPipelinesGrid
      ? { renderPipelinesGrid: options.renderPipelinesGrid }
      : {}),
    ...(options.shouldUseGrid ? { shouldUseGrid: options.shouldUseGrid } : {}),
  });
  printRepoSetupFailures(result.setupFailures, options.onEvent);

  log.success(`Change ready: ${workspaceDir}`);
  await reportShellCdTarget(workspaceDir, {
    writeShellCdPath: options.writeShellCdPath,
  });

  return { targetDir: workspaceDir, setupFailures: result.setupFailures };
}

/**
 * A source as chosen in the entry surface, before resolution: either a
 * repository token (a cached name, an `org/repo` slug, or a full git URL — all
 * accepted by {@link resolveRepositorySpecifiers}) or one `@template` name.
 */
export type ChosenSourceInput =
  | Readonly<{ kind: "repo"; token: string }>
  | Readonly<{ kind: "template"; name: string }>;

/**
 * Resolve the surface's chosen sources + change name into a {@link CreateInput}
 * ready for {@link create}. Mirrors `wf new`'s resolution rules: one repo
 * is a worktree, two or more an adhoc workspace, one `@template` a
 * template workspace; templates cannot combine with other sources.
 */
export async function buildCreateInput(args: {
  changeName: string;
  sources: readonly ChosenSourceInput[];
  branchOverride?: string;
}): Promise<CreateInput> {
  const changeName = validateResourceName(args.changeName, "Name");

  const templates = args.sources.filter((source) => source.kind === "template");
  const repoTokens = args.sources
    .filter(
      (source): source is Extract<ChosenSourceInput, { kind: "repo" }> =>
        source.kind === "repo",
    )
    .map((source) => source.token);

  if (templates.length > 0 && (templates.length > 1 || repoTokens.length > 0)) {
    throw new UsageError(
      "Template sources cannot be combined with repository sources.",
    );
  }

  const { config } = await loadWorkspaceConfig();
  const directories = resolveWorkforestDirectories(config);

  const source = await resolveChosenSource(templates[0], repoTokens);
  const branchName =
    args.branchOverride ??
    buildBranchName(
      changeName,
      source.kind === "template"
        ? resolveBranchPrefix(config.branchPrefix, source.branchPrefix)
        : config.branchPrefix,
    );

  return { changeName, source, branchName, directories };
}

async function resolveChosenSource(
  template: Extract<ChosenSourceInput, { kind: "template" }> | undefined,
  repoTokens: readonly string[],
): Promise<ResolvedSource> {
  if (template) {
    const loaded = await loadTemplate(template.name);
    if (!loaded) throw new UsageError(`Unknown template: @${template.name}`);
    return {
      kind: "template",
      groupName: loaded.id,
      templateId: loaded.parentId,
      ...(loaded.variantId ? { templateVariant: loaded.variantId } : {}),
      repos: await resolveRepositorySpecifiers(loaded.config.repos),
      ...(loaded.config.branchPrefix !== undefined
        ? { branchPrefix: loaded.config.branchPrefix }
        : {}),
    };
  }

  const repos = await resolveRepositorySpecifiers(repoTokens);
  const [first] = repos;
  if (!first) throw new UsageError("No repositories specified.");
  return repos.length === 1
    ? { kind: "repository", repo: first }
    : { kind: "adhoc", repos };
}
