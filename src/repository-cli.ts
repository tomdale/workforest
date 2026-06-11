import { OperationalError } from "./cli/errors.ts";
import { failure, success } from "./cli/output.ts";
import type {
  CommandResult,
  ParsedInvocation,
  RenderModel,
} from "./cli/types.ts";
import { getCacheDir } from "./config.ts";
import { log } from "./logger.ts";
import {
  addCachedRepository,
  type CachedRepository,
  cleanCachedRepositories,
  deleteCachedRepository,
  formatByteSize,
  listCachedRepositories,
  repairCachedRepository,
  repositoryDisplayName,
  resolveCachedRepository,
  updateCachedRepository,
} from "./repositories.ts";
import { qualifyRepositorySpecifiers } from "./repository-specifiers.ts";
import { printReport } from "./terminal/report.ts";
import {
  isInteractive,
  promptConfirm,
  promptText,
  withSpinner,
} from "./ui/prompts/index.ts";

export async function runRepositoryInvocation(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  const operands = [...invocation.beforeDoubleDash];

  switch (invocation.command.leaf.handler) {
    case "repository.default":
      return isInteractive()
        ? runRepositoryManagerCommand()
        : runRepositoryList(false);
    case "repository.list":
      return runRepositoryList(flag(invocation, "json"));
    case "repository.info":
      return runRepositoryInfo(
        requiredOperand(operands, 0),
        flag(invocation, "json"),
      );
    case "repository.path":
      return runRepositoryPath(operands[0]);
    case "repository.add":
      return runRepositoryAdd(operands);
    case "repository.update":
      return runRepositoryUpdate(operands);
    case "repository.doctor":
      return runRepositoryDoctor(operands, flag(invocation, "json"));
    case "repository.repair":
      return runRepositoryRepair(operands);
    case "repository.delete":
      return runRepositoryDelete(operands, {
        dryRun: flag(invocation, "dryRun"),
        force: flag(invocation, "force"),
      });
    case "repository.clean":
      return runRepositoryClean({
        dryRun: flag(invocation, "dryRun"),
        force: flag(invocation, "force"),
      });
    default:
      throw new Error(
        `Unsupported repository handler: ${invocation.command.leaf.handler}`,
      );
  }
}

async function runRepositoryList(json: boolean): Promise<CommandResult> {
  const repositories = await listCachedRepositories();
  if (json) {
    return result({
      kind: "json",
      value: repositories.map(toJson),
      stream: "stdout",
    });
  }
  if (repositories.length === 0) {
    log.info("No cached repositories.");
    log.info(`Cache directory: ${getCacheDir()}`);
    return success();
  }

  printReport({
    title: "Cached repositories",
    sections: [
      {
        entries: repositories.map((repository) => ({
          title: repositoryDisplayName(repository),
          description: healthSummary(repository),
          details: [
            { label: "Size", value: formatByteSize(repository.sizeBytes) },
            {
              label: "Worktrees",
              value: String(activeWorktreeCount(repository)),
            },
            {
              label: "Updated",
              value: formatDate(repository.lastFetchedAt),
            },
          ],
        })),
      },
    ],
    footer: [
      `Directory: ${getCacheDir()}`,
      `${repositories.length} repositor${repositories.length === 1 ? "y" : "ies"}, ${formatByteSize(totalSize(repositories))}`,
    ].join("\n"),
  });
  return success();
}

async function runRepositoryInfo(
  selector: string,
  json: boolean,
): Promise<CommandResult> {
  const repository = await requireRepository(selector);
  if (json) {
    return result({
      kind: "json",
      value: toJson(repository),
      stream: "stdout",
    });
  }

  printRepositoryInfo(repository);
  return success();
}

async function runRepositoryPath(
  selector: string | undefined,
): Promise<CommandResult> {
  const value = selector
    ? (await requireRepository(selector)).mirrorPath
    : getCacheDir();
  return result({
    kind: "text",
    value,
    stream: "stdout",
  });
}

async function runRepositoryAdd(
  operands: readonly string[],
): Promise<CommandResult> {
  let inputs: string[];
  try {
    inputs = await qualifyRepositorySpecifiers(operands);
  } catch (error) {
    throw operationalError(error);
  }

  let failed = false;
  for (const [index, input] of inputs.entries()) {
    const displayInput = operands[index] ?? input;
    try {
      const repository = await runWithOptionalSpinner(
        `Caching ${displayInput}`,
        () => addCachedRepository(input),
        `Cached ${displayInput}`,
      );
      log.success(
        `${repositoryDisplayName(repository)}: ${repository.mirrorPath}`,
      );
    } catch (error) {
      log.error(`${displayInput}: ${getErrorMessage(error)}`);
      failed = true;
    }
  }
  return statusResult(failed);
}

async function runRepositoryUpdate(
  selectors: readonly string[],
): Promise<CommandResult> {
  const repositories = await resolveRepositorySelection(selectors);
  if (repositories.length === 0) {
    log.info("No cached repositories to update.");
    return success();
  }

  let failed = false;
  for (const repository of repositories) {
    const name = repositoryDisplayName(repository);
    try {
      await runWithOptionalSpinner(
        `Updating ${name}`,
        () => updateCachedRepository(repository),
        `Updated ${name}`,
      );
    } catch (error) {
      log.error(`${name}: ${getErrorMessage(error)}`);
      failed = true;
    }
  }
  return statusResult(failed);
}

async function runRepositoryDoctor(
  selectors: readonly string[],
  json: boolean,
): Promise<CommandResult> {
  const repositories = await resolveRepositorySelection(selectors);
  const unhealthy = repositories.some(
    (repository) => repository.health !== "healthy",
  );

  if (json) {
    return result(
      {
        kind: "json",
        value: repositories.map(toJson),
        stream: "stdout",
      },
      unhealthy ? 1 : 0,
    );
  } else if (repositories.length === 0) {
    log.info("No cached repositories.");
  } else {
    printReport({
      title: "Repository cache health",
      sections: [
        {
          entries: repositories.map((repository) => ({
            title: repositoryDisplayName(repository),
            description: healthSummary(repository),
            details:
              repository.issues.length > 0
                ? [{ label: "Issues", value: repository.issues.join("; ") }]
                : [{ label: "Issues", value: "none" }],
          })),
        },
      ],
      footer: `${repositories.filter((repository) => repository.health !== "healthy").length} need attention`,
    });
  }
  return statusResult(unhealthy);
}

async function runRepositoryRepair(
  selectors: readonly string[],
): Promise<CommandResult> {
  const repositories = await resolveRepositorySelection(selectors);
  if (repositories.length === 0) {
    log.info("No cached repositories to repair.");
    return success();
  }

  let failed = false;
  for (const repository of repositories) {
    const name = repositoryDisplayName(repository);
    try {
      const repaired = await runWithOptionalSpinner(
        `Repairing ${name}`,
        () => repairCachedRepository(repository),
        `Repaired ${name}`,
      );
      if (repaired.health !== "healthy") {
        log.warn(`${name}: ${repaired.issues.join("; ")}`);
        failed = true;
      }
    } catch (error) {
      log.error(`${name}: ${getErrorMessage(error)}`);
      failed = true;
    }
  }
  return statusResult(failed);
}

async function runRepositoryDelete(
  selectors: readonly string[],
  options: Readonly<{ dryRun: boolean; force: boolean }>,
): Promise<CommandResult> {
  const repositories = await resolveRepositorySelection(selectors);
  const activeRepositories = repositories.filter(
    (repository) => activeWorktreeCount(repository) > 0,
  );
  if (activeRepositories.length > 0 && !options.force) {
    throw new OperationalError(
      `Cannot delete cached repositories with active worktrees: ${activeRepositories.map(repositoryDisplayName).join(", ")}. Delete those worktrees first or pass --force.`,
    );
  }
  if (!(await confirmDeletion(repositories, options.force, options.dryRun))) {
    return success();
  }

  let failed = false;
  for (const repository of repositories) {
    try {
      await deleteCachedRepository(repository, {
        dryRun: options.dryRun,
        force: options.force,
      });
      const verb = options.dryRun ? "Would delete" : "Deleted";
      log.success(`${verb} ${repositoryDisplayName(repository)}`);
    } catch (error) {
      log.error(getErrorMessage(error));
      failed = true;
    }
  }
  return statusResult(failed);
}

async function runRepositoryClean(
  options: Readonly<{ dryRun: boolean; force: boolean }>,
): Promise<CommandResult> {
  const repositories = (await listCachedRepositories()).filter(
    (repository) => activeWorktreeCount(repository) === 0,
  );
  if (repositories.length === 0) {
    log.info("No unused cached repositories.");
    return success();
  }
  if (!(await confirmDeletion(repositories, options.force, options.dryRun))) {
    return success();
  }

  try {
    const results = await cleanCachedRepositories({
      dryRun: options.dryRun,
      force: options.force,
    });
    const verb = options.dryRun ? "Would delete" : "Deleted";
    log.success(
      `${verb} ${results.length} unused repositor${results.length === 1 ? "y" : "ies"} (${formatByteSize(totalSize(results.map((result) => result.repository)))})`,
    );
    return success();
  } catch (error) {
    throw operationalError(error);
  }
}

async function runRepositoryManagerCommand(): Promise<CommandResult> {
  const { shouldUseRepositoryManager } = await import(
    "./ui/repository-manager.ts"
  );
  if (!shouldUseRepositoryManager()) {
    return runRepositoryList(false);
  }

  let initialMirrorPath: string | undefined;
  while (true) {
    const repositories = await listCachedRepositories();
    const { runRepositoryManager } = await import("./ui/repository-manager.ts");
    const action = await runRepositoryManager({
      repositories,
      cacheDir: getCacheDir(),
      ...(initialMirrorPath ? { initialMirrorPath } : {}),
    });

    switch (action.type) {
      case "quit":
        return success();
      case "reload":
        continue;
      case "add": {
        const input = await promptText(
          "Repository (cached name, owner/repo, or git URL)",
        );
        await runManagerOperation(() => runRepositoryAdd([input]));
        initialMirrorPath = (await resolveCachedRepository(input))?.mirrorPath;
        continue;
      }
      case "info": {
        const repository = repositories.find(
          (candidate) => candidate.mirrorPath === action.mirrorPath,
        );
        if (repository) printRepositoryInfo(repository);
        return success();
      }
      case "update":
        initialMirrorPath = action.mirrorPath;
        await runManagerOperation(() =>
          runRepositoryUpdate([action.mirrorPath]),
        );
        continue;
      case "repair":
        initialMirrorPath = action.mirrorPath;
        await runManagerOperation(() =>
          runRepositoryRepair([action.mirrorPath]),
        );
        continue;
      case "delete":
        await runManagerOperation(() =>
          runRepositoryDelete([action.mirrorPath], {
            dryRun: false,
            force: false,
          }),
        );
        initialMirrorPath = undefined;
        continue;
      case "clean":
        await runManagerOperation(() =>
          runRepositoryClean({ dryRun: false, force: false }),
        );
        initialMirrorPath = undefined;
        continue;
    }
  }
}

async function resolveRepositorySelection(
  selectors: readonly string[],
): Promise<CachedRepository[]> {
  const repositories = await listCachedRepositories();
  if (selectors.length === 0) return repositories;

  const selected = new Map<string, CachedRepository>();
  for (const selector of selectors) {
    try {
      const repository = await resolveCachedRepository(selector, repositories);
      if (!repository) {
        throw new OperationalError(`Cached repository not found: ${selector}`);
      }
      selected.set(repository.mirrorPath, repository);
    } catch (error) {
      throw operationalError(error);
    }
  }
  return [...selected.values()];
}

async function requireRepository(selector: string): Promise<CachedRepository> {
  const repositories = await resolveRepositorySelection([selector]);
  const repository = repositories[0];
  if (!repository) {
    throw new OperationalError(`Cached repository not found: ${selector}`);
  }
  return repository;
}

async function confirmDeletion(
  repositories: CachedRepository[],
  force: boolean,
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun || force) return true;
  if (!isInteractive()) {
    throw new OperationalError(
      "Cannot confirm in non-interactive mode. Use --force.",
    );
  }

  const size = formatByteSize(totalSize(repositories));
  return promptConfirm(
    `Delete ${repositories.length} cached repositor${repositories.length === 1 ? "y" : "ies"} (${size})?`,
    false,
  );
}

function printRepositoryInfo(repository: CachedRepository): void {
  printReport({
    title: `Cached repository ${repositoryDisplayName(repository)}`,
    sections: [
      {
        fields: [
          { label: "Health", value: healthSummary(repository) },
          { label: "Remote", value: repository.remote ?? "(missing)" },
          {
            label: "Default branch",
            value: repository.defaultBranch ?? "(unknown)",
          },
          { label: "Size", value: formatByteSize(repository.sizeBytes) },
          {
            label: "Last updated",
            value: formatDate(repository.lastFetchedAt),
          },
          { label: "Mirror", value: repository.mirrorPath },
        ],
      },
      ...(repository.issues.length > 0
        ? [
            {
              title: "Issues",
              entries: repository.issues.map((issue) => ({ title: issue })),
            },
          ]
        : []),
      {
        title: "Worktrees",
        entries:
          repository.worktrees.length > 0
            ? repository.worktrees.map((worktree) => ({
                title: worktree.path,
                details: [
                  {
                    label: "Branch",
                    value: worktree.detached
                      ? "(detached)"
                      : (worktree.branch ?? "(unknown)"),
                  },
                  {
                    label: "State",
                    value:
                      worktree.prunable || !worktree.exists
                        ? "stale"
                        : "active",
                  },
                ],
              }))
            : [{ title: "(none)" }],
      },
    ],
  });
}

function toJson(repository: CachedRepository): Record<string, unknown> {
  return {
    ...repository,
    lastFetchedAt: repository.lastFetchedAt?.toISOString() ?? null,
  };
}

function activeWorktreeCount(repository: CachedRepository): number {
  return repository.worktrees.filter(
    (worktree) => worktree.exists && !worktree.prunable,
  ).length;
}

function totalSize(repositories: CachedRepository[]): number | null {
  const known = repositories
    .map((repository) => repository.sizeBytes)
    .filter((size): size is number => size !== null);
  return known.length === 0 && repositories.length > 0
    ? null
    : known.reduce((total, size) => total + size, 0);
}

function healthSummary(repository: CachedRepository): string {
  if (repository.health === "healthy") return "healthy";
  if (repository.health === "invalid") return "invalid";
  return `needs attention: ${repository.issues.join("; ")}`;
}

function formatDate(date: Date | null): string {
  return date ? date.toLocaleString() : "unknown";
}

function flag(invocation: ParsedInvocation, name: string): boolean {
  return invocation.flags[name] === true;
}

function requiredOperand(operands: readonly string[], index: number): string {
  const operand = operands[index];
  if (operand === undefined) {
    throw new Error(
      "The CLI kernel accepted an invalid repository invocation.",
    );
  }
  return operand;
}

function result(render: RenderModel, exitCode: 0 | 1 = 0): CommandResult {
  return exitCode === 0 ? success(render) : failure(exitCode, render);
}

function statusResult(failed: boolean): CommandResult {
  return failed ? failure(1, { kind: "none" }) : success();
}

function operationalError(error: unknown): OperationalError {
  return error instanceof OperationalError
    ? error
    : new OperationalError(getErrorMessage(error), { cause: error });
}

async function runManagerOperation(
  operation: () => Promise<CommandResult>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof OperationalError) {
      log.error(error.message);
      return;
    }
    throw error;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runWithOptionalSpinner<T>(
  message: string,
  task: () => Promise<T>,
  successMessage: string,
): Promise<T> {
  return isInteractive() ? withSpinner(message, task, successMessage) : task();
}
