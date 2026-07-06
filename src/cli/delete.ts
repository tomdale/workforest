import { promises as fs } from "node:fs";
import path from "node:path";
import { loadWorkspaceConfig } from "../config.ts";
import { log } from "../logger.ts";
import { resolveRepositorySpecifiers } from "../repository-specifiers.ts";
import { type ReviewTarget, removeReviewWorktree } from "../review.ts";
import { reportShellCdTarget } from "../shell.ts";
import { compactHomePath } from "../terminal/paths.ts";
import { type ReportSection, renderReport } from "../terminal/report.ts";
import { resolveContainedPath } from "../utils/path-safety.ts";
import {
  type CleanupResult,
  type CleanupState,
  type CleanupStateSink,
  cleanupWorkspace,
  cleanupWorktree,
} from "../workspace/cleanup.ts";
import {
  buildDeleteRepositorySafety,
  buildDeleteTaskSafety,
  type DeleteRepositorySafety,
  type DeleteSafety,
  type DeleteTaskSafety,
  deleteSafetyFor,
} from "../workspace/delete-safety.ts";
import type { InventoryEntry } from "../workspace/inventory.ts";
import { readWorkspaceMetadata } from "../workspace/metadata.ts";
import {
  isComparablePathInsideOrEqual,
  resolveWorkforestDirectories,
} from "../workspace/paths.ts";
import { resolveSelector } from "../workspace/selectors.ts";
import {
  createDeleteTimingRecorder,
  type DeleteTimingRecorder,
} from "./delete-timing.ts";
import { OperationalError, UsageError } from "./errors.ts";
import { jsonSuccess, reportOutput, success } from "./output.ts";
import type { CommandResult, ParsedInvocation } from "./types.ts";

export type RunCleanupOptions = Readonly<{
  interactive: boolean;
  writeShellCdPath: (targetDir: string) => Promise<void>;
  buildDeleteRepositorySafety?: typeof buildDeleteRepositorySafety;
  buildDeleteTaskSafety?: typeof buildDeleteTaskSafety;
  cleanupWorkspace?: typeof cleanupWorkspace;
  cleanupWorktree?: typeof cleanupWorktree;
  resolveRepositorySpecifiers?: typeof resolveRepositorySpecifiers;
  onCleanupState?: CleanupStateSink;
  cwd?: string;
}>;

type DeleteBlocker = Readonly<{
  message: string;
  suggestion: string;
}>;

type DeleteTargetType = InventoryEntry["type"] | "review-worktree";

type DeleteWorktreeTarget = Readonly<{
  repo: string;
  path: string;
  branch: string | null;
}>;

type DeletePlan = Readonly<{
  dryRun: true;
  selector: string;
  type: DeleteTargetType;
  typeLabel: string;
  path: string;
  force: boolean;
  blocked: boolean;
  blockers: readonly DeleteBlocker[];
  wouldRemove: Readonly<{
    worktrees: readonly DeleteWorktreeTarget[];
    directories: readonly string[];
    metadata: readonly string[];
    branches: readonly string[];
  }>;
  preservation: Readonly<{
    nodeModules: Readonly<{
      action: "preserve-before-delete";
      repositories: readonly string[];
    }>;
    cachedMirrors: Readonly<{
      action: "preserve";
      repositories: readonly string[];
    }>;
    branches: Readonly<{
      action: "preserve";
      names: readonly string[];
    }>;
  }>;
  notes: readonly string[];
}>;

type DeleteResultData = Readonly<{
  action: "deleted";
  selector: string;
  type: DeleteTargetType;
  path: string;
  removedRepos: readonly string[];
  deletedBranches: readonly string[];
  preservation: Readonly<{
    cachedMirrors: "preserved";
    nodeModules: "preserved-before-delete";
    branches: "preserved" | "deleted-review-branch";
  }>;
}>;

const DRY_RUN_NOTE =
  "Dry run only. No files, worktrees, metadata, branches, node_modules, or mirrors were removed.";

/**
 * Removes a worktree or workspace. Without --force, it refuses unless every
 * managed repository is clean, integrated into its remote default branch, and
 * free of unmerged nested tasks. --force skips those checks and removes
 * regardless: the deliberate abandon path for squash merges, cherry-picks, or
 * thrown-away work.
 */
export async function runDeleteCommand(
  invocation: ParsedInvocation,
  options: RunCleanupOptions,
): Promise<CommandResult> {
  const timing = createDeleteTimingRecorder();
  const force = invocation.flags["force"] === true;
  const dryRun = invocation.flags["dryRun"] === true;
  const json = invocation.flags["json"] === true;

  try {
    if (!invocation.beforeDoubleDash[0]) {
      const reviewWorktree = await timing.time("review-resolution", () =>
        resolveCurrentReviewWorktree(options.cwd ?? process.cwd()),
      );
      if (reviewWorktree) {
        return await deleteReviewWorktree(
          reviewWorktree,
          { dryRun, force, json },
          options,
          timing,
        );
      }
    }

    const entry = await timing.time("selector-resolution", () =>
      resolveDeleteSelector(invocation.beforeDoubleDash[0]),
    );
    const safety =
      dryRun || !force ? await buildDeleteSafety(entry, options, timing) : null;

    if (dryRun) {
      const plan = buildDeletePlan(entry, safety ?? emptySafety(entry), force);
      return json
        ? jsonSuccess(plan)
        : success(reportOutput(renderDeletePlan(plan)));
    }

    if (!force && safety) {
      const blockers = deleteBlockers(safety);
      if (blockers.length > 0) {
        throw new OperationalError(renderDeleteBlockers(safety, blockers));
      }
    }

    const cleanup = await timing.time("cleanup-dispatch", () =>
      cleanupTarget(entry, options, timing),
    );
    if (json) {
      return jsonSuccess(deleteResult(entry, cleanup));
    }
    log.success(`Deleted: ${entry.selector}`);
    return success();
  } finally {
    await timing.flush();
  }
}

async function buildDeleteSafety(
  entry: InventoryEntry,
  options: RunCleanupOptions,
  timing: DeleteTimingRecorder,
): Promise<DeleteSafety> {
  const repositories = await timing.time("repository-safety", () =>
    (options.buildDeleteRepositorySafety ?? buildDeleteRepositorySafety)(entry),
  );
  const tasks = await timing.time("task-checks", () =>
    (options.buildDeleteTaskSafety ?? buildDeleteTaskSafety)(entry),
  );
  return deleteSafetyFor(entry, repositories, tasks);
}

function emptySafety(entry: InventoryEntry): DeleteSafety {
  return deleteSafetyFor(entry, [], []);
}

async function deleteReviewWorktree(
  reviewWorktree: ResolvedReviewWorktree,
  deleteOptions: Readonly<{ dryRun: boolean; force: boolean; json: boolean }>,
  options: RunCleanupOptions,
  timing: DeleteTimingRecorder,
): Promise<CommandResult> {
  const initialCwd = options.cwd ?? process.cwd();
  const isInsideTarget = await isComparablePathInsideOrEqual(
    reviewWorktree.path,
    initialCwd,
  );
  const result = await timing.time("cleanup-dispatch", () =>
    removeReviewWorktree({
      target: reviewWorktree.target,
      reviewsRoot: reviewWorktree.reviewsRoot,
      force: deleteOptions.force,
      dryRun: deleteOptions.dryRun,
    }),
  );
  const selector = reviewSelector(reviewWorktree.target);

  if (deleteOptions.dryRun) {
    const plan = buildReviewDeletePlan(
      reviewWorktree,
      result.branch ?? null,
      deleteOptions.force,
    );
    return deleteOptions.json
      ? jsonSuccess(plan)
      : success(reportOutput(renderDeletePlan(plan)));
  }

  if (isInsideTarget) {
    await reportShellCdTarget(path.dirname(result.path), {
      writeShellCdPath: options.writeShellCdPath,
    });
  }
  if (deleteOptions.json) {
    return jsonSuccess({
      action: "deleted",
      selector,
      type: "review-worktree",
      path: result.path,
      removedRepos: [reviewWorktree.target.repo],
      deletedBranches: result.branch ? [result.branch] : [],
      preservation: {
        cachedMirrors: "preserved",
        nodeModules: "preserved-before-delete",
        branches: result.branch ? "deleted-review-branch" : "preserved",
      },
    } satisfies DeleteResultData);
  }
  log.success(`Deleted: ${selector}`);
  return success();
}

type ResolvedReviewWorktree = Readonly<{
  target: ReviewTarget;
  reviewsRoot: string;
  path: string;
}>;

async function resolveCurrentReviewWorktree(
  cwd: string,
): Promise<ResolvedReviewWorktree | null> {
  const { config } = await loadWorkspaceConfig();
  const reviewsRoot = resolveWorkforestDirectories(config).reviews;
  const reviewRepos = await readReviewWorkspaceDirs(reviewsRoot);

  for (const workspaceDir of reviewRepos) {
    const metadata = await readWorkspaceMetadata(workspaceDir).catch(
      () => null,
    );
    if (metadata?.workspace.type !== "review" || !metadata.workspace.review) {
      continue;
    }

    for (const worktree of metadata.review_worktrees ?? []) {
      const worktreePath = resolveContainedPath(workspaceDir, worktree.path);
      if (await isComparablePathInsideOrEqual(worktreePath, cwd)) {
        return {
          reviewsRoot,
          path: worktreePath,
          target: {
            owner: metadata.workspace.review.owner,
            repo: metadata.workspace.review.repo,
            prNumber: worktree.pr_number,
          },
        };
      }
    }
  }

  return null;
}

async function readReviewWorkspaceDirs(reviewsRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(reviewsRoot, {
      withFileTypes: true,
      encoding: "utf8",
    });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(reviewsRoot, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function resolveDeleteSelector(
  selector: string | undefined,
): Promise<InventoryEntry> {
  const { config } = await loadWorkspaceConfig();
  const resolution = await resolveSelector(config, selector);
  if (resolution.kind === "resolved") {
    return resolution.entry;
  }
  if (resolution.kind === "outside") {
    throw new OperationalError(
      [
        "Not in a Workforest worktree or workspace.",
        "Run: wf list",
        "Or pass a selector explicitly.",
      ].join("\n"),
    );
  }
  if (resolution.kind === "missing") {
    throw new UsageError(`Unknown selector: ${resolution.selector}`);
  }
  throw new UsageError(
    [
      `Ambiguous selector "${resolution.selector}".`,
      "Matches:",
      ...resolution.matches.map((match) => `  ${match}`),
      resolution.hint ?? "Use <group>/<name>.",
    ].join("\n"),
  );
}

function deleteBlockers(status: DeleteSafety): DeleteBlocker[] {
  return [
    ...status.repositories.flatMap(repositoryBlockers),
    ...status.tasks.flatMap(taskBlockers),
  ];
}

function repositoryBlockers(
  repo: DeleteRepositorySafety,
): readonly DeleteBlocker[] {
  const blockers: DeleteBlocker[] = [];

  if (repo.state === "dirty") {
    blockers.push({
      message: `${repo.name}: worktree has uncommitted changes at ${repo.path}.`,
      suggestion: `Run: git -C ${repo.path} status`,
    });
  } else if (repo.state === "stale") {
    blockers.push({
      message: `${repo.name}: worktree is missing at ${repo.path}.`,
      suggestion: "Pass --force if it was already removed intentionally.",
    });
  }

  if (repo.integrated !== true) {
    blockers.push({
      message:
        repo.integrated === false
          ? `${repo.name}: ${repo.branch ?? "HEAD"} is not reachable from ${repo.base ?? "the remote default branch"}.`
          : `${repo.name}: integration status could not be verified.`,
      suggestion:
        "Merge the branch first, or pass --force if it was integrated another way.",
    });
  }

  return blockers;
}

function taskBlockers(task: DeleteTaskSafety): readonly DeleteBlocker[] {
  if (task.merged === true && task.state === "ready") {
    return [];
  }

  return [
    {
      message: `${task.selector}: nested task branch ${task.branch} is not integrated.`,
      suggestion: `Run: wf task delete ${task.slug} --repo ${task.parentRepo} --force`,
    },
  ];
}

function renderDeleteBlockers(
  status: DeleteSafety,
  blockers: readonly DeleteBlocker[],
): string {
  return [
    `Cannot delete ${status.selector}.`,
    "Blockers:",
    ...blockers.flatMap((blocker) => [
      `  - ${blocker.message}`,
      `    ${blocker.suggestion}`,
    ]),
    "Use --force only for squash merges, cherry-picks, abandoned work, or proof Workforest cannot detect.",
  ].join("\n");
}

function buildDeletePlan(
  entry: InventoryEntry,
  safety: DeleteSafety,
  force: boolean,
): DeletePlan {
  const blockers = deleteBlockers(safety);
  const worktrees = planWorktrees(entry, safety);
  const branchNames = worktrees
    .map((worktree) => worktree.branch)
    .filter((branch): branch is string => branch !== null);
  const repos = worktrees.map((worktree) => worktree.repo);

  return {
    dryRun: true,
    selector: entry.selector,
    type: entry.type,
    typeLabel: typeLabel(entry),
    path: entry.path,
    force,
    blocked: blockers.length > 0 && !force,
    blockers,
    wouldRemove: {
      worktrees,
      directories: [entry.path],
      metadata: metadataTargets(entry),
      branches: [],
    },
    preservation: {
      nodeModules: {
        action: "preserve-before-delete",
        repositories: repos,
      },
      cachedMirrors: {
        action: "preserve",
        repositories: repos,
      },
      branches: {
        action: "preserve",
        names: branchNames,
      },
    },
    notes: [DRY_RUN_NOTE],
  };
}

function buildReviewDeletePlan(
  reviewWorktree: ResolvedReviewWorktree,
  branch: string | null,
  force: boolean,
): DeletePlan {
  const selector = reviewSelector(reviewWorktree.target);
  return {
    dryRun: true,
    selector,
    type: "review-worktree",
    typeLabel: "review worktree",
    path: reviewWorktree.path,
    force,
    blocked: false,
    blockers: [],
    wouldRemove: {
      worktrees: [
        {
          repo: reviewWorktree.target.repo,
          path: reviewWorktree.path,
          branch,
        },
      ],
      directories: [reviewWorktree.path],
      metadata: [
        path.join(
          reviewWorktree.reviewsRoot,
          reviewWorktree.target.repo,
          ".workforest",
          "workspace.json",
        ),
      ],
      branches: branch ? [branch] : [],
    },
    preservation: {
      nodeModules: {
        action: "preserve-before-delete",
        repositories: [],
      },
      cachedMirrors: {
        action: "preserve",
        repositories: [reviewWorktree.target.repo],
      },
      branches: {
        action: "preserve",
        names: [],
      },
    },
    notes: [DRY_RUN_NOTE],
  };
}

function renderDeletePlan(plan: DeletePlan): string {
  const sections: ReportSection[] = [
    {
      title: "Target",
      fields: [
        { label: "Selector", value: plan.selector },
        { label: "Type", value: plan.typeLabel },
        { label: "Path", value: compactHomePath(plan.path) },
        { label: "Action", value: planAction(plan) },
      ],
    },
    {
      title: "Would remove",
      fields: [
        {
          label: "Worktrees",
          value: formatWorktrees(plan.wouldRemove.worktrees),
        },
        {
          label: "Directories",
          value: formatPaths(plan.wouldRemove.directories),
        },
        { label: "Metadata", value: formatPaths(plan.wouldRemove.metadata) },
        { label: "Branches", value: formatList(plan.wouldRemove.branches) },
      ],
    },
    {
      title: "Would preserve",
      fields: [
        {
          label: "node_modules",
          value:
            "Preserved in the Workforest cache before worktrees are removed.",
        },
        {
          label: "Cached mirrors",
          value: "Preserved.",
        },
        {
          label: "Branches",
          value: preservedBranchesText(plan.preservation.branches.names),
        },
      ],
    },
    blockerSection(plan),
  ];

  return renderReport({
    title: "Delete preview",
    sections,
    footer: plan.notes.join("\n"),
  });
}

function blockerSection(plan: DeletePlan): ReportSection {
  if (plan.blockers.length === 0) {
    return {
      title: "Blockers",
      note: "No blockers found.",
    };
  }

  return {
    title: "Blockers",
    entries: plan.blockers.map((blocker) => ({
      title: blocker.message,
      details: [{ label: "Suggestion", value: blocker.suggestion }],
      tone: plan.force ? "warning" : "error",
    })),
  };
}

function planAction(plan: DeletePlan): string {
  if (plan.blocked) {
    return "Blocked; real delete would stop before cleanup.";
  }
  if (plan.force && plan.blockers.length > 0) {
    return "Would proceed because --force is set.";
  }
  return "Would proceed.";
}

function planWorktrees(
  entry: InventoryEntry,
  safety: DeleteSafety,
): readonly DeleteWorktreeTarget[] {
  if (safety.repositories.length > 0) {
    return safety.repositories.map((repo) => ({
      repo: repo.name,
      path: repo.path,
      branch: repo.branch,
    }));
  }

  if (entry.type === "worktree") {
    return [
      {
        repo: entry.repository,
        path: entry.path,
        branch: null,
      },
    ];
  }

  return entry.repos.map((repo) => ({
    repo,
    path: path.join(entry.path, repo),
    branch: null,
  }));
}

function metadataTargets(entry: InventoryEntry): readonly string[] {
  if (entry.type === "worktree") {
    return [
      path.join(
        path.dirname(entry.path),
        ".workforest",
        "changes",
        `${entry.changeName}.json`,
      ),
    ];
  }

  return [path.join(entry.path, ".workforest", "workspace.json")];
}

function deleteResult(
  entry: InventoryEntry,
  cleanup: CleanupResult,
): DeleteResultData {
  return {
    action: "deleted",
    selector: entry.selector,
    type: entry.type,
    path: entry.path,
    removedRepos: cleanup.removedRepos,
    deletedBranches: cleanup.deletedBranches,
    preservation: {
      cachedMirrors: "preserved",
      nodeModules: "preserved-before-delete",
      branches: "preserved",
    },
  };
}

function typeLabel(entry: InventoryEntry): string {
  return entry.type === "worktree" ? "repository change" : "workspace";
}

function reviewSelector(target: ReviewTarget): string {
  return `${target.repo}#${target.prNumber}`;
}

function formatWorktrees(worktrees: readonly DeleteWorktreeTarget[]): string {
  if (worktrees.length === 0) return "none";
  return worktrees
    .map((worktree) => `${worktree.repo} (${compactHomePath(worktree.path)})`)
    .join(", ");
}

function formatPaths(paths: readonly string[]): string {
  if (paths.length === 0) return "none";
  return paths.map((targetPath) => compactHomePath(targetPath)).join(", ");
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

function preservedBranchesText(branches: readonly string[]): string {
  if (branches.length === 0) {
    return "No branches are removed by this delete.";
  }
  return `${branches.join(", ")} kept.`;
}

async function cleanupTarget(
  entry: InventoryEntry,
  options: RunCleanupOptions,
  timing: DeleteTimingRecorder,
): Promise<CleanupResult> {
  const initialCwd = options.cwd ?? process.cwd();
  const cleanupRoot = entry.path;
  const isInsideTarget = await isComparablePathInsideOrEqual(
    cleanupRoot,
    initialCwd,
  );
  const onState = cleanupStateSink(options.onCleanupState, timing);

  let result: CleanupResult;
  if (entry.type === "worktree") {
    const resolveRepositories =
      options.resolveRepositorySpecifiers ?? resolveRepositorySpecifiers;
    const repo = await resolveRepositories([entry.repository])
      .then((repos) => repos[0])
      .catch(() => undefined);
    result = await (options.cleanupWorktree ?? cleanupWorktree)({
      repoName: entry.repository,
      targetPath: entry.path,
      ...(repo ? { repo } : {}),
      onState,
    });
  } else {
    result = await (options.cleanupWorkspace ?? cleanupWorkspace)(entry.path, {
      keepMirrors: true,
      onState,
    });
  }

  if (isInsideTarget) {
    const target = path.dirname(path.resolve(cleanupRoot));
    await reportShellCdTarget(target, {
      writeShellCdPath: options.writeShellCdPath,
    });
  }

  return result;
}

function cleanupStateSink(
  configured: CleanupStateSink | undefined,
  timing: DeleteTimingRecorder,
): CleanupStateSink {
  return async (state: CleanupState) => {
    timing.recordCleanupState(state);
    await configured?.(state);
  };
}
