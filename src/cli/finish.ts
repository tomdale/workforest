import path from "node:path";
import { loadWorkspaceConfig } from "../config.ts";
import { log } from "../logger.ts";
import { resolveRepositorySpecifiers } from "../repository-specifiers.ts";
import { isShellAutoCdEnabled, resolveCleanupCdTarget } from "../shell.ts";
import { promptConfirm } from "../ui/prompts/index.ts";
import type { ChangeInventoryEntry } from "../workspace/change-inventory.ts";
import {
  type CleanupStateSink,
  cleanupRepositoryChange,
  cleanupWorkspace,
} from "../workspace/cleanup.ts";
import { isPathInsideOrEqual } from "../workspace/paths.ts";
import { resolveChangeSelector } from "../workspace/selectors.ts";
import {
  buildChangeStatus,
  type ChangeRepositoryStatus,
  type ChangeStatus,
  type ChangeTaskStatus,
} from "../workspace/status.ts";
import { OperationalError, UsageError } from "./errors.ts";
import { success } from "./output.ts";
import type { CommandResult, ParsedInvocation } from "./types.ts";

export type RunChangeCleanupOptions = Readonly<{
  interactive: boolean;
  writeShellCdPath: (targetDir: string) => Promise<void>;
  confirm?: typeof promptConfirm;
  buildChangeStatus?: typeof buildChangeStatus;
  cleanupWorkspace?: typeof cleanupWorkspace;
  cleanupRepositoryChange?: typeof cleanupRepositoryChange;
  resolveRepositorySpecifiers?: typeof resolveRepositorySpecifiers;
  onCleanupState?: CleanupStateSink;
  cwd?: string;
}>;

type FinishBlocker = Readonly<{
  message: string;
  suggestion: string;
}>;

export async function runFinishCommand(
  invocation: ParsedInvocation,
  options: RunChangeCleanupOptions,
): Promise<CommandResult> {
  const force = invocation.flags["force"] === true;
  const entry = await resolveCleanupSelector(invocation.beforeDoubleDash[0], {
    requireExplicit: false,
  });
  const status = await (options.buildChangeStatus ?? buildChangeStatus)(entry);
  const blockers = force ? [] : finishBlockers(status);

  if (blockers.length > 0) {
    throw new OperationalError(renderFinishBlockers(status, blockers));
  }

  await cleanupChange(entry, options);
  log.success(`Finished change: ${status.selector}`);
  return success();
}

export async function runChangeDeleteCommand(
  invocation: ParsedInvocation,
  options: RunChangeCleanupOptions,
): Promise<CommandResult> {
  const selector = invocation.beforeDoubleDash[0];
  if (!selector) {
    throw new UsageError("wf delete requires a change selector.");
  }

  const force = invocation.flags["force"] === true;
  const entry = await resolveCleanupSelector(selector, {
    requireExplicit: true,
  });

  if (!force) {
    if (!options.interactive) {
      throw new UsageError(
        "Deleting a change requires --force without an interactive terminal.",
      );
    }
    const confirmed = await (options.confirm ?? promptConfirm)(
      `Delete change ${entry.selector}?`,
      false,
    );
    if (!confirmed) {
      return success();
    }
  }

  await cleanupChange(entry, options);
  log.success(`Deleted change: ${entry.selector}`);
  return success();
}

async function resolveCleanupSelector(
  selector: string | undefined,
  { requireExplicit }: { requireExplicit: boolean },
): Promise<ChangeInventoryEntry> {
  if (requireExplicit && !selector) {
    throw new UsageError("wf delete requires a change selector.");
  }

  const { config } = await loadWorkspaceConfig();
  const resolution = await resolveChangeSelector(config, selector);
  if (resolution.kind === "resolved") {
    return resolution.entry;
  }
  if (resolution.kind === "outside") {
    throw new OperationalError(
      [
        "Not in a Workforest change.",
        "Run: wf list",
        "Or pass a change selector explicitly.",
      ].join("\n"),
    );
  }
  if (resolution.kind === "missing") {
    throw new UsageError(`Unknown change selector: ${resolution.selector}`);
  }
  throw new UsageError(
    [
      `Ambiguous change selector "${resolution.selector}".`,
      "Matches:",
      ...resolution.matches.map((match) => `  ${match}`),
      resolution.hint ?? "Use <group>/<change>.",
    ].join("\n"),
  );
}

function finishBlockers(status: ChangeStatus): FinishBlocker[] {
  return [
    ...status.repositories.flatMap(repositoryBlockers),
    ...status.tasks.flatMap(taskBlockers),
  ];
}

function repositoryBlockers(
  repo: ChangeRepositoryStatus,
): readonly FinishBlocker[] {
  const blockers: FinishBlocker[] = [];

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
        "Merge the change branch first, or pass --force if it was integrated another way.",
    });
  }

  return blockers;
}

function taskBlockers(task: ChangeTaskStatus): readonly FinishBlocker[] {
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

function renderFinishBlockers(
  status: ChangeStatus,
  blockers: readonly FinishBlocker[],
): string {
  return [
    `Cannot finish ${status.selector}.`,
    "Blockers:",
    ...blockers.flatMap((blocker) => [
      `  - ${blocker.message}`,
      `    ${blocker.suggestion}`,
    ]),
    "Use --force only for squash merges, cherry-picks, abandoned work, or proof Workforest cannot detect.",
  ].join("\n");
}

async function cleanupChange(
  entry: ChangeInventoryEntry,
  options: RunChangeCleanupOptions,
): Promise<void> {
  const initialCwd = options.cwd ?? process.cwd();
  const cleanupRoot = entry.path;
  const isInsideChange = isPathInsideOrEqual(cleanupRoot, initialCwd);

  if (entry.type === "repository-change") {
    const resolveRepositories =
      options.resolveRepositorySpecifiers ?? resolveRepositorySpecifiers;
    const repo = await resolveRepositories([entry.repository])
      .then((repos) => repos[0])
      .catch(() => undefined);
    await (options.cleanupRepositoryChange ?? cleanupRepositoryChange)({
      repoName: entry.repository,
      changePath: entry.path,
      ...(repo ? { repo } : {}),
      ...(options.onCleanupState ? { onState: options.onCleanupState } : {}),
    });
  } else {
    await (options.cleanupWorkspace ?? cleanupWorkspace)(entry.path, {
      keepMirrors: true,
      ...(options.onCleanupState ? { onState: options.onCleanupState } : {}),
    });
  }

  if (isInsideChange) {
    const target =
      resolveCleanupCdTarget(initialCwd, cleanupRoot) ??
      path.dirname(path.resolve(cleanupRoot));
    await options.writeShellCdPath(target);
    if (!isShellAutoCdEnabled()) {
      log.info(`Run: cd ${target}`);
    }
  }
}
