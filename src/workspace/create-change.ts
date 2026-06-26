import { promises as fs } from "node:fs";
import path from "node:path";
import { UsageError } from "../cli/errors.ts";
import { loadWorkspaceConfig } from "../config.ts";
import { log } from "../logger.ts";
import { resolveRepositorySpecifiers } from "../repository-specifiers.ts";
import type { ServiceEventSink } from "../services/events.ts";
import { isShellAutoCdEnabled } from "../shell.ts";
import { loadTemplate } from "../templates/index.ts";
import type { RepoConfig } from "../types.ts";
import { renderPipelinesGrid, shouldUseGrid } from "../ui/grid-consumer.ts";
import {
  buildBranchName,
  resolveBranchPrefix,
} from "../utils/branch-prefix.ts";
import { validateResourceName } from "../utils/path-safety.ts";
import { createSingleWorktree } from "../worktree.ts";
import {
  createRepoSetupFailureSummary,
  printRepoSetupFailures,
  type RepoSetupFailureSummary,
  runScopedRepoSetupPipeline,
  stampWorkspace,
  stampWorkspaceInteractive,
} from "./index.ts";
import {
  initializeRepositoryChangeSetup,
  repositoryChangeInitializationScope,
  startRepoInitialization,
} from "./initialization.ts";
import { writeRepositoryChangeMetadata } from "./metadata.ts";
import {
  ADHOC_WORKSPACE_GROUP,
  getRepositoryChangePath,
  getWorkspaceChangePath,
  resolveWorkforestDirectories,
  type WorkforestDirectories,
} from "./paths.ts";
import { getRepoSetupLogPath } from "./setup-logs.ts";

/**
 * A start source that has already been resolved to concrete repositories.
 * This is the input contract shared by `wf start` and the change-entry surface.
 */
export type ResolvedStartSource =
  | Readonly<{ kind: "repository"; repo: RepoConfig }>
  | Readonly<{ kind: "adhoc"; repos: readonly RepoConfig[] }>
  | Readonly<{
      kind: "template";
      templateId: string;
      repos: readonly RepoConfig[];
      branchPrefix?: string;
    }>;

export type CreateChangeInput = Readonly<{
  changeName: string;
  source: ResolvedStartSource;
  branchName: string;
  directories: WorkforestDirectories;
}>;

export type CreateChangeOptions = Readonly<{
  interactive: boolean;
  onEvent?: ServiceEventSink;
  writeShellCdPath: (targetDir: string) => Promise<void>;
  createSingleWorktree?: typeof createSingleWorktree;
  initializeRepositoryChangeSetup?: typeof initializeRepositoryChangeSetup;
  startRepoInitialization?: typeof startRepoInitialization;
  stampWorkspace?: typeof stampWorkspace;
  stampWorkspaceInteractive?: typeof stampWorkspaceInteractive;
  renderPipelinesGrid?: typeof renderPipelinesGrid;
  shouldUseGrid?: typeof shouldUseGrid;
}>;

export type CreateChangeResult = Readonly<{
  targetDir: string;
  setupFailures: readonly RepoSetupFailureSummary[];
}>;

/**
 * Reusable change-creation core: everything that happens after a start source
 * has been resolved and a branch name derived. Single-repo changes land in a
 * per-repo change layout; multi-repo (adhoc/template) changes are stamped into
 * a workspace. Presentation (grid vs. console fallback) is chosen here based on
 * `interactive` and `shouldUseGrid`, so both `wf start` and any future surface
 * get identical behavior by calling this one function.
 */
export async function createChange(
  input: CreateChangeInput,
  options: CreateChangeOptions,
): Promise<CreateChangeResult> {
  const { source } = input;
  if (source.kind === "repository") {
    return createRepositoryChange({ ...input, source }, options);
  }
  return createWorkspaceChange({ ...input, source }, options);
}

type RepositoryChangeInput = CreateChangeInput &
  Readonly<{ source: Extract<ResolvedStartSource, { kind: "repository" }> }>;

type WorkspaceChangeInput = CreateChangeInput &
  Readonly<{
    source: Exclude<ResolvedStartSource, { kind: "repository" }>;
  }>;

async function createRepositoryChange(
  input: RepositoryChangeInput,
  options: CreateChangeOptions,
): Promise<CreateChangeResult> {
  const { changeName, branchName, directories } = input;
  const repo = input.source.repo;
  const targetDir = getRepositoryChangePath(directories, repo.name, changeName);
  const repoRootDir = path.dirname(targetDir);
  await fs.mkdir(repoRootDir, { recursive: true });

  const context = { repo, changeName, branchName, targetDir, repoRootDir };
  const useGrid =
    options.interactive && (options.shouldUseGrid ?? shouldUseGrid)(1);
  const setupFailures = useGrid
    ? await createRepositoryChangeWithGrid(context, options)
    : await createRepositoryChangeFallback(context, options);

  await options.writeShellCdPath(targetDir);
  log.success(`Change ready: ${targetDir}`);
  if (!isShellAutoCdEnabled()) {
    log.info(`Run: cd ${targetDir}`);
  }

  return { targetDir, setupFailures };
}

type RepositoryChangeContext = Readonly<{
  repo: RepoConfig;
  changeName: string;
  branchName: string;
  targetDir: string;
  repoRootDir: string;
}>;

/**
 * Console fallback used outside a grid-capable TTY: create the worktree, write
 * metadata with the real lockfile state, and hand initialization to a detached
 * worker. Identical to the long-standing single-repo behavior.
 */
async function createRepositoryChangeFallback(
  {
    repo,
    changeName,
    branchName,
    targetDir,
    repoRootDir,
  }: RepositoryChangeContext,
  options: CreateChangeOptions,
): Promise<readonly RepoSetupFailureSummary[]> {
  await (options.createSingleWorktree ?? createSingleWorktree)({
    repo,
    branchName,
    targetDir,
  });
  await writeRepositoryChangeMetadata(repoRootDir, {
    featureName: changeName,
    branchName,
    repos: [{ ...repo, hasLockfile: await hasLockfile(targetDir) }],
  });
  await (
    options.initializeRepositoryChangeSetup ?? initializeRepositoryChangeSetup
  )({ repoRootDir, changeName, repo });
  await (options.startRepoInitialization ?? startRepoInitialization)({
    scope: repositoryChangeInitializationScope({ repoRootDir, changeName }),
    repo,
  });
  return [];
}

/**
 * Render a single-repo change through the same split-pane grid + confetti
 * completion modal used for workspaces. The worktree is created live inside the
 * pipeline; metadata and initialization state are written up front so the
 * pipeline can record git progress against existing state. Initialization is
 * handed to a detached worker (backgroundInitialization), and the grid returns
 * once the worktree is ready and the user acknowledges the completion modal.
 */
async function createRepositoryChangeWithGrid(
  {
    repo,
    changeName,
    branchName,
    targetDir,
    repoRootDir,
  }: RepositoryChangeContext,
  options: CreateChangeOptions,
): Promise<readonly RepoSetupFailureSummary[]> {
  const scope = repositoryChangeInitializationScope({
    repoRootDir,
    changeName,
  });

  await writeRepositoryChangeMetadata(repoRootDir, {
    featureName: changeName,
    branchName,
    repos: [{ ...repo, hasLockfile: false }],
  });
  await (
    options.initializeRepositoryChangeSetup ?? initializeRepositoryChangeSetup
  )({ repoRootDir, changeName, repo });

  const pipeline = runScopedRepoSetupPipeline({
    repo,
    scope,
    rootDir: repoRootDir,
    repoDir: targetDir,
    branchName,
    isNewWorkspace: true,
    monitorBackground: false,
  });

  const setupFailures = new Map<string, RepoSetupFailureSummary>();
  await (options.renderPipelinesGrid ?? renderPipelinesGrid)({
    pipelines: new Map([[repo.name, pipeline]]),
    repoNames: [repo.name],
    workspacePath: targetDir,
    getLogPath: (repoName) =>
      getRepoSetupLogPath({
        workspaceDir: repoRootDir,
        repoName,
        initializationScope: scope,
      }),
    onFailure: async (repoName, state) => {
      setupFailures.set(
        repoName,
        await createRepoSetupFailureSummary({
          workspaceDir: repoRootDir,
          repoName,
          error: state.error,
          ...(state.step ? { step: state.step } : {}),
          initializationScope: scope,
        }),
      );
    },
    completeOnWorktreesReady: true,
    backgroundInitialization: true,
  });

  const failures = [...setupFailures.values()];
  printRepoSetupFailures(failures, options.onEvent);
  return failures;
}

async function createWorkspaceChange(
  input: WorkspaceChangeInput,
  options: CreateChangeOptions,
): Promise<CreateChangeResult> {
  const { changeName, branchName, directories, source } = input;
  const groupName =
    source.kind === "template" ? source.templateId : ADHOC_WORKSPACE_GROUP;
  const workspaceDir = getWorkspaceChangePath(
    directories,
    groupName,
    changeName,
  );
  const stampOptions = {
    featureName: changeName,
    branchName,
    workspaceDir,
    repos: source.repos,
    ...(source.kind === "template" ? { templateId: source.templateId } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  };

  let setupFailures: readonly RepoSetupFailureSummary[] = [];
  if (options.interactive) {
    const result = await (
      options.stampWorkspaceInteractive ?? stampWorkspaceInteractive
    )(stampOptions);
    setupFailures = result.setupFailures;
    printRepoSetupFailures(result.setupFailures);
  } else {
    await (options.stampWorkspace ?? stampWorkspace)(stampOptions);
  }

  await options.writeShellCdPath(workspaceDir);
  log.success(`Change ready: ${workspaceDir}`);
  if (!isShellAutoCdEnabled()) {
    log.info(`Run: cd ${workspaceDir}`);
  }

  return { targetDir: workspaceDir, setupFailures };
}

async function hasLockfile(repoDir: string): Promise<boolean> {
  return (
    (await fileExists(path.join(repoDir, "pnpm-lock.yaml"))) ||
    (await fileExists(path.join(repoDir, "pnpm-lock.yml")))
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * A source as chosen in the change-entry surface, before resolution: either a
 * repository token (a cached name, an `org/repo` slug, or a full git URL — all
 * accepted by {@link resolveRepositorySpecifiers}) or one `@template` name.
 */
export type ChosenSourceInput =
  | Readonly<{ kind: "repo"; token: string }>
  | Readonly<{ kind: "template"; name: string }>;

/**
 * Resolve the surface's chosen sources + change name into a {@link CreateChangeInput}
 * ready for {@link createChange}. Mirrors `wf start`'s resolution rules: one repo
 * is a repository change, two or more an adhoc workspace, one `@template` a
 * template workspace; templates cannot combine with other sources.
 */
export async function buildCreateChangeInput(args: {
  changeName: string;
  sources: readonly ChosenSourceInput[];
  branchOverride?: string;
}): Promise<CreateChangeInput> {
  const changeName = validateResourceName(args.changeName, "Change name");

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
): Promise<ResolvedStartSource> {
  if (template) {
    const loaded = await loadTemplate(template.name);
    if (!loaded) throw new UsageError(`Unknown template: @${template.name}`);
    return {
      kind: "template",
      templateId: loaded.id,
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
