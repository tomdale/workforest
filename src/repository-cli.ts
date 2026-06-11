import { OperationalError } from "./cli/errors.ts";
import {
  failure,
  humanOutput,
  jsonSuccess,
  pathOutput,
  renderCommandResult,
  reportOutput,
  success,
} from "./cli/output.ts";
import type { CommandResult, ParsedInvocation } from "./cli/types.ts";
import { getCacheDir } from "./config.ts";
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
import { renderReport } from "./terminal/report.ts";
import { terminalColor, terminalSymbol } from "./terminal/theme.ts";
import {
  isInteractive,
  promptConfirm,
  promptText,
  withSpinner,
} from "./ui/prompts/index.ts";

export async function runCacheInvocation(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  const operands = [...invocation.beforeDoubleDash];

  switch (invocation.command.leaf.handler) {
    case "cache.manage":
      return runCacheManagerCommand();
    case "cache.list":
      return runCacheList(flag(invocation, "json"));
    case "cache.info":
      return runCacheInfo(
        requiredOperand(operands, 0),
        flag(invocation, "json"),
      );
    case "cache.path":
      return runCachePath(operands[0]);
    case "cache.add":
      return runCacheAdd(operands);
    case "cache.update":
      return runCacheUpdate(operands);
    case "cache.doctor":
      return runCacheDoctor(operands, flag(invocation, "json"));
    case "cache.repair":
      return runCacheRepair(operands);
    case "cache.delete":
      return runCacheDelete(operands, {
        dryRun: flag(invocation, "dryRun"),
        force: flag(invocation, "force"),
      });
    case "cache.prune":
      return runCachePrune({
        dryRun: flag(invocation, "dryRun"),
        force: flag(invocation, "force"),
      });
    default:
      throw new Error(
        `Unsupported cache handler: ${invocation.command.leaf.handler}`,
      );
  }
}

async function runCacheList(json: boolean): Promise<CommandResult> {
  const repositories = await listCachedRepositories();
  if (json) {
    return jsonSuccess(repositories.map(toJson));
  }
  if (repositories.length === 0) {
    return success(
      humanOutput(
        [
          formatMessage("info", "No cached repositories."),
          formatMessage("info", `Cache directory: ${getCacheDir()}`),
        ].join("\n"),
      ),
    );
  }

  return success(
    reportOutput(
      renderReport({
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
      }),
    ),
  );
}

async function runCacheInfo(
  selector: string,
  json: boolean,
): Promise<CommandResult> {
  const repository = await requireRepository(selector);
  if (json) {
    return jsonSuccess(toJson(repository));
  }

  return success(reportOutput(renderRepositoryInfo(repository)));
}

async function runCachePath(
  selector: string | undefined,
): Promise<CommandResult> {
  const value = selector
    ? (await requireRepository(selector)).mirrorPath
    : getCacheDir();
  return success(pathOutput(value));
}

async function runCacheAdd(
  operands: readonly string[],
): Promise<CommandResult> {
  let inputs: string[];
  try {
    inputs = await qualifyRepositorySpecifiers(operands);
  } catch (error) {
    throw operationalError(error);
  }

  const messages: OperationMessage[] = [];
  for (const [index, input] of inputs.entries()) {
    const displayInput = operands[index] ?? input;
    try {
      const repository = await runWithOptionalSpinner(
        `Caching ${displayInput}`,
        () => addCachedRepository(input),
        `Cached ${displayInput}`,
      );
      messages.push({
        kind: "success",
        text: `${repositoryDisplayName(repository)}: ${repository.mirrorPath}`,
      });
    } catch (error) {
      messages.push({
        kind: "error",
        text: `${displayInput}: ${getErrorMessage(error)}`,
      });
    }
  }
  return operationResult(messages);
}

async function runCacheUpdate(
  selectors: readonly string[],
): Promise<CommandResult> {
  const repositories = await resolveRepositorySelection(selectors);
  if (repositories.length === 0) {
    return success(
      humanOutput(formatMessage("info", "No cached repositories to update.")),
    );
  }

  const messages: OperationMessage[] = [];
  for (const repository of repositories) {
    const name = repositoryDisplayName(repository);
    try {
      await runWithOptionalSpinner(
        `Updating ${name}`,
        () => updateCachedRepository(repository),
        `Updated ${name}`,
      );
    } catch (error) {
      messages.push({
        kind: "error",
        text: `${name}: ${getErrorMessage(error)}`,
      });
    }
  }
  return operationResult(messages);
}

async function runCacheDoctor(
  selectors: readonly string[],
  json: boolean,
): Promise<CommandResult> {
  const repositories = await resolveRepositorySelection(selectors);
  const unhealthy = repositories.some(
    (repository) => repository.health !== "healthy",
  );

  if (json) {
    return withExitCode(jsonSuccess(repositories.map(toJson)), unhealthy);
  } else if (repositories.length === 0) {
    return success(
      humanOutput(formatMessage("info", "No cached repositories.")),
    );
  } else {
    return withExitCode(
      success(
        reportOutput(
          renderReport({
            title: "Repository cache health",
            sections: [
              {
                entries: repositories.map((repository) => ({
                  title: repositoryDisplayName(repository),
                  description: healthSummary(repository),
                  details:
                    repository.issues.length > 0
                      ? [
                          {
                            label: "Issues",
                            value: repository.issues.join("; "),
                          },
                        ]
                      : [{ label: "Issues", value: "none" }],
                })),
              },
            ],
            footer: `${repositories.filter((repository) => repository.health !== "healthy").length} need attention`,
          }),
        ),
      ),
      unhealthy,
    );
  }
}

async function runCacheRepair(
  selectors: readonly string[],
): Promise<CommandResult> {
  const repositories = await resolveRepositorySelection(selectors);
  if (repositories.length === 0) {
    return success(
      humanOutput(formatMessage("info", "No cached repositories to repair.")),
    );
  }

  const messages: OperationMessage[] = [];
  for (const repository of repositories) {
    const name = repositoryDisplayName(repository);
    try {
      const repaired = await runWithOptionalSpinner(
        `Repairing ${name}`,
        () => repairCachedRepository(repository),
        `Repaired ${name}`,
      );
      if (repaired.health !== "healthy") {
        messages.push({
          kind: "warning",
          text: `${name}: ${repaired.issues.join("; ")}`,
        });
      }
    } catch (error) {
      messages.push({
        kind: "error",
        text: `${name}: ${getErrorMessage(error)}`,
      });
    }
  }
  return operationResult(messages);
}

async function runCacheDelete(
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

  const messages: OperationMessage[] = [];
  for (const repository of repositories) {
    try {
      await deleteCachedRepository(repository, {
        dryRun: options.dryRun,
        force: options.force,
      });
      const verb = options.dryRun ? "Would delete" : "Deleted";
      messages.push({
        kind: "success",
        text: `${verb} ${repositoryDisplayName(repository)}`,
      });
    } catch (error) {
      messages.push({ kind: "error", text: getErrorMessage(error) });
    }
  }
  return operationResult(messages);
}

async function runCachePrune(
  options: Readonly<{ dryRun: boolean; force: boolean }>,
): Promise<CommandResult> {
  const repositories = (await listCachedRepositories()).filter(
    (repository) => activeWorktreeCount(repository) === 0,
  );
  if (repositories.length === 0) {
    return success(
      humanOutput(formatMessage("info", "No unused cached repositories.")),
    );
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
    return success(
      humanOutput(
        formatMessage(
          "success",
          `${verb} ${results.length} unused repositor${results.length === 1 ? "y" : "ies"} (${formatByteSize(totalSize(results.map((result) => result.repository)))})`,
        ),
      ),
    );
  } catch (error) {
    throw operationalError(error);
  }
}

async function runCacheManagerCommand(): Promise<CommandResult> {
  const { shouldUseRepositoryManager } = await import(
    "./ui/repository-manager.ts"
  );
  if (!shouldUseRepositoryManager()) {
    return runCacheList(false);
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
        await runManagerOperation(() => runCacheAdd([input]));
        initialMirrorPath = (await resolveCachedRepository(input))?.mirrorPath;
        continue;
      }
      case "info": {
        const repository = repositories.find(
          (candidate) => candidate.mirrorPath === action.mirrorPath,
        );
        return repository
          ? success(reportOutput(renderRepositoryInfo(repository)))
          : success();
      }
      case "update":
        initialMirrorPath = action.mirrorPath;
        await runManagerOperation(() => runCacheUpdate([action.mirrorPath]));
        continue;
      case "repair":
        initialMirrorPath = action.mirrorPath;
        await runManagerOperation(() => runCacheRepair([action.mirrorPath]));
        continue;
      case "delete":
        await runManagerOperation(() =>
          runCacheDelete([action.mirrorPath], {
            dryRun: false,
            force: false,
          }),
        );
        initialMirrorPath = undefined;
        continue;
      case "prune":
        await runManagerOperation(() =>
          runCachePrune({ dryRun: false, force: false }),
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

function renderRepositoryInfo(repository: CachedRepository): string {
  return renderReport({
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
    throw new Error("The CLI kernel accepted an invalid cache invocation.");
  }
  return operand;
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
    renderCommandResult(await operation());
  } catch (error) {
    if (error instanceof OperationalError) {
      renderCommandResult(
        failure(
          1,
          humanOutput(formatMessage("error", error.message), {
            stream: "stderr",
          }),
        ),
      );
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

type OperationMessage = Readonly<{
  kind: "error" | "success" | "warning";
  text: string;
}>;

function operationResult(messages: readonly OperationMessage[]): CommandResult {
  if (messages.length === 0) {
    return success();
  }

  const failed = messages.some((message) => message.kind !== "success");
  const output = humanOutput(
    messages
      .map((message) => formatMessage(message.kind, message.text))
      .join("\n"),
    failed ? { stream: "stderr" } : {},
  );
  return failed ? failure(1, output) : success(output);
}

function withExitCode(result: CommandResult, failed: boolean): CommandResult {
  return failed ? { ...result, exitCode: 1 } : result;
}

function formatMessage(
  kind: "error" | "info" | "success" | "warning",
  message: string,
): string {
  const symbol = {
    error: terminalColor.error(terminalSymbol.error),
    info: terminalColor.accent(terminalSymbol.info),
    success: terminalColor.success(terminalSymbol.success),
    warning: terminalColor.warning(terminalSymbol.warning),
  }[kind];
  return `${symbol} ${message}`;
}
