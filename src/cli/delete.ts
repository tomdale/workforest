import { promises as fs } from "node:fs";
import path from "node:path";
import { loadWorkspaceConfig } from "../config.ts";
import { log } from "../logger.ts";
import { resolveRepositorySpecifiers } from "../repository-specifiers.ts";
import { type ReviewTarget, removeReviewWorktree } from "../review.ts";
import { reportShellCdTarget } from "../shell.ts";
import { resolveContainedPath } from "../utils/path-safety.ts";
import {
  type CleanupStateSink,
  cleanupWorkspace,
  cleanupWorktree,
} from "../workspace/cleanup.ts";
import type { InventoryEntry } from "../workspace/inventory.ts";
import { readWorkspaceMetadata } from "../workspace/metadata.ts";
import {
  isComparablePathInsideOrEqual,
  resolveWorkforestDirectories,
} from "../workspace/paths.ts";
import { resolveSelector } from "../workspace/selectors.ts";
import {
  buildStatus,
  type RepositoryStatus,
  type Status,
  type TaskStatus,
} from "../workspace/status.ts";
import { OperationalError, UsageError } from "./errors.ts";
import { success } from "./output.ts";
import type { CommandResult, ParsedInvocation } from "./types.ts";

export type RunCleanupOptions = Readonly<{
  interactive: boolean;
  writeShellCdPath: (targetDir: string) => Promise<void>;
  buildStatus?: typeof buildStatus;
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

/**
 * Removes a worktree or workspace. Without --force, it refuses unless every
 * managed repository is clean, integrated into its remote default branch, and
 * free of unmerged nested tasks — the verification the former `finish` verb
 * enforced. --force skips the checks and removes regardless: the deliberate
 * "abandon" path for squash merges, cherry-picks, or thrown-away work.
 */
export async function runDeleteCommand(
  invocation: ParsedInvocation,
  options: RunCleanupOptions,
): Promise<CommandResult> {
  const force = invocation.flags["force"] === true;
  if (!invocation.beforeDoubleDash[0]) {
    const reviewWorktree = await resolveCurrentReviewWorktree(
      options.cwd ?? process.cwd(),
    );
    if (reviewWorktree) {
      return deleteReviewWorktree(reviewWorktree, force, options);
    }
  }

  const entry = await resolveDeleteSelector(invocation.beforeDoubleDash[0]);

  if (!force) {
    const status = await (options.buildStatus ?? buildStatus)(entry);
    const blockers = deleteBlockers(status);
    if (blockers.length > 0) {
      throw new OperationalError(renderDeleteBlockers(status, blockers));
    }
  }

  await cleanupTarget(entry, options);
  log.success(`Deleted: ${entry.selector}`);
  return success();
}

async function deleteReviewWorktree(
  reviewWorktree: ResolvedReviewWorktree,
  force: boolean,
  options: RunCleanupOptions,
): Promise<CommandResult> {
  const initialCwd = options.cwd ?? process.cwd();
  const isInsideTarget = await isComparablePathInsideOrEqual(
    reviewWorktree.path,
    initialCwd,
  );
  const result = await removeReviewWorktree({
    target: reviewWorktree.target,
    reviewsRoot: reviewWorktree.reviewsRoot,
    force,
  });
  if (isInsideTarget) {
    await reportShellCdTarget(path.dirname(result.path), {
      writeShellCdPath: options.writeShellCdPath,
    });
  }
  log.success(
    `Deleted: ${reviewWorktree.target.repo}#${reviewWorktree.target.prNumber}`,
  );
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

function deleteBlockers(status: Status): DeleteBlocker[] {
  return [
    ...status.repositories.flatMap(repositoryBlockers),
    ...status.tasks.flatMap(taskBlockers),
  ];
}

function repositoryBlockers(repo: RepositoryStatus): readonly DeleteBlocker[] {
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

function taskBlockers(task: TaskStatus): readonly DeleteBlocker[] {
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
  status: Status,
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

async function cleanupTarget(
  entry: InventoryEntry,
  options: RunCleanupOptions,
): Promise<void> {
  const initialCwd = options.cwd ?? process.cwd();
  const cleanupRoot = entry.path;
  const isInsideTarget = await isComparablePathInsideOrEqual(
    cleanupRoot,
    initialCwd,
  );

  if (entry.type === "worktree") {
    const resolveRepositories =
      options.resolveRepositorySpecifiers ?? resolveRepositorySpecifiers;
    const repo = await resolveRepositories([entry.repository])
      .then((repos) => repos[0])
      .catch(() => undefined);
    await (options.cleanupWorktree ?? cleanupWorktree)({
      repoName: entry.repository,
      targetPath: entry.path,
      ...(repo ? { repo } : {}),
      ...(options.onCleanupState ? { onState: options.onCleanupState } : {}),
    });
  } else {
    await (options.cleanupWorkspace ?? cleanupWorkspace)(entry.path, {
      keepMirrors: true,
      ...(options.onCleanupState ? { onState: options.onCleanupState } : {}),
    });
  }

  if (isInsideTarget) {
    const target = path.dirname(path.resolve(cleanupRoot));
    await reportShellCdTarget(target, {
      writeShellCdPath: options.writeShellCdPath,
    });
  }
}
