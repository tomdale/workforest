import { spawn } from "node:child_process";
import path from "node:path";
import { OperationalError, UsageError } from "./cli/errors.ts";
import {
  failure,
  humanOutput,
  jsonSuccess,
  pathOutput,
  reportOutput,
  success,
} from "./cli/output.ts";
import type { CommandResult, ParsedInvocation } from "./cli/types.ts";
import { getCacheDir, loadWorkspaceConfig } from "./config.ts";
import {
  deleteNodeModulesCache,
  type NodeModulesCacheSummary,
  summarizeNodeModulesCache,
} from "./node-modules-cache.ts";
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
import { detectDefaultBranch } from "./services/worktree.ts";
import {
  renderTerminalLineAnsi,
  type TerminalStyleRole,
  terminalLine,
  terminalSpan,
} from "./terminal/render-model.ts";
import { renderReport } from "./terminal/report.ts";
import { type StatusTone, statusLabel } from "./terminal/status-indicator.ts";
import { terminalSymbol } from "./terminal/theme.ts";
import {
  isInteractive,
  promptConfirm,
  withSpinner,
} from "./ui/prompts/index.ts";
import { S_BAR } from "./ui/prompts/symbols.ts";
import {
  isPathInsideOrEqual,
  resolveWorkforestDirectories,
  type WorkforestDirectories,
} from "./workspace/paths.ts";

export async function runCacheInvocation(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  const operands = [...invocation.beforeDoubleDash];

  switch (invocation.command.leaf.handler) {
    case "cache.list":
      return runCacheList(flag(invocation, "json"));
    case "cache.show":
      return runCacheShow(
        operands[0],
        flag(invocation, "json"),
        flag(invocation, "path"),
      );
    case "cache.sync":
      return runCacheSync(operands, flag(invocation, "json"));
    case "cache.doctor":
      return runCacheDoctor(operands, {
        fix: flag(invocation, "fix"),
        json: flag(invocation, "json"),
      });
    case "cache.delete":
      return runCacheDelete(operands, {
        dryRun: flag(invocation, "dryRun"),
        force: flag(invocation, "force"),
        json: flag(invocation, "json"),
      });
    case "cache.clean":
      return runCacheClean({
        dryRun: flag(invocation, "dryRun"),
        force: flag(invocation, "force"),
        json: flag(invocation, "json"),
      });
    default:
      throw new Error(
        `Unsupported cache handler: ${invocation.command.leaf.handler}`,
      );
  }
}

/** Run fixed Git worktree primitives without applying Workforest lifecycle rules. */
export async function runWorktreeInvocation(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  if (flag(invocation, "json")) {
    throw new UsageError(
      'Flag "--json" is not supported by wf cache worktree.',
    );
  }

  const [selector, ...operands] = invocation.beforeDoubleDash;
  if (!selector) {
    throw new Error("The CLI kernel accepted an invalid worktree invocation.");
  }

  // Resolve the mirror before building the argv: `add` pins an explicit
  // start-point derived from the mirror's default branch. Workforest mirrors are
  // normalized to keep a *dangling* HEAD (the refs/heads target it names is
  // deleted), so a start-point-less `git worktree add` resolves HEAD to a
  // missing ref and fails. `origin/<default>` is the real commit-ish to branch
  // from.
  const repository = await requireRepository(selector);
  const directories = await resolveManagedDirectories();

  let args: readonly string[];
  switch (invocation.command.leaf.handler) {
    case "cache.worktree.list":
      args = ["list"];
      break;
    case "cache.worktree.add": {
      const [worktreePath, branch] = operands;
      if (!worktreePath) {
        throw new Error(
          "The CLI kernel accepted an invalid worktree add invocation.",
        );
      }
      const target = path.resolve(worktreePath);
      assertUnmanagedWorktreePath(target, directories);
      const defaultBranch = await detectDefaultBranch(
        repository.mirrorPath,
        repository.defaultBranch ?? "main",
      );
      const startPoint = `origin/${defaultBranch}`;
      args = branch
        ? ["add", "-b", branch, target, startPoint]
        : ["add", target, startPoint];
      break;
    }
    case "cache.worktree.move": {
      const [worktreePath, newPath] = operands;
      if (!worktreePath || !newPath) {
        throw new Error(
          "The CLI kernel accepted an invalid worktree move invocation.",
        );
      }
      const from = path.resolve(worktreePath);
      const to = path.resolve(newPath);
      assertUnmanagedWorktreePath(from, directories);
      assertUnmanagedWorktreePath(to, directories);
      args = ["move", from, to];
      break;
    }
    case "cache.worktree.remove": {
      const [worktreePath] = operands;
      if (!worktreePath) {
        throw new Error(
          "The CLI kernel accepted an invalid worktree remove invocation.",
        );
      }
      const target = path.resolve(worktreePath);
      assertUnmanagedWorktreePath(target, directories);
      args = ["remove", target];
      break;
    }
    default:
      throw new Error(
        `Unsupported worktree handler: ${invocation.command.leaf.handler}`,
      );
  }

  const exitCode = await runGitWorktree(repository.mirrorPath, args);
  return exitCode === 0 ? success() : failure(exitCode, { kind: "none" });
}

async function resolveManagedDirectories(): Promise<WorkforestDirectories> {
  const { config } = await loadWorkspaceConfig();
  return resolveWorkforestDirectories(config);
}

/**
 * The raw `cache worktree` primitives deliberately bypass Workforest lifecycle
 * rules — they write no metadata and run no setup. Pointed at a path inside a
 * managed directory they would silently desync that worktree or workspace's
 * `workspace.json` from the mirror, so refuse and steer the caller to the
 * lifecycle commands (or a path outside the managed tree).
 */
function assertUnmanagedWorktreePath(
  target: string,
  directories: WorkforestDirectories,
): void {
  const managed = [
    directories.repos,
    directories.workspaces,
    directories.reviews,
  ];
  if (managed.some((directory) => isPathInsideOrEqual(directory, target))) {
    throw new UsageError(
      `Refusing to run a raw cache worktree op inside a managed Workforest directory (${target}). ` +
        `Use 'wf new'/'wf add'/'wf delete' for managed worktrees, or target a path outside ${directories.base}.`,
    );
  }
}

async function runGitWorktree(
  mirrorPath: string,
  args: readonly string[],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["worktree", ...args], {
      cwd: mirrorPath,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== null) {
        resolve(code);
      } else {
        resolve(signal ? 1 : 0);
      }
    });
  });
}

async function runCacheList(json: boolean): Promise<CommandResult> {
  const repositories = await listCachedRepositories();
  const nodeModules = await summarizeNodeModulesCache();
  if (json) {
    return jsonSuccess(repositories.map(toJson));
  }
  if (repositories.length === 0) {
    return success(
      reportOutput(
        renderReport({
          title: "Cached repositories",
          sections: [
            { note: "No cached repositories." },
            nodeModulesSummarySection(nodeModules),
          ],
          footer: cacheListFooter(repositories, nodeModules),
        }),
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
              tone: healthTone(repository),
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
          nodeModulesSummarySection(nodeModules),
        ],
        footer: cacheListFooter(repositories, nodeModules),
      }),
    ),
  );
}

async function runCacheShow(
  selector: string | undefined,
  json: boolean,
  path: boolean,
): Promise<CommandResult> {
  if (json && path) {
    throw new UsageError('Flag "--json" cannot be combined with "--path".');
  }
  if (path) {
    return runCachePath(selector);
  }
  if (!selector) {
    throw new Error("The CLI kernel accepted an invalid cache invocation.");
  }

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

async function runCacheSync(
  operands: readonly string[],
  json: boolean,
): Promise<CommandResult> {
  if (operands.length === 0) {
    const repositories = await listCachedRepositories();
    if (repositories.length === 0) {
      if (json) {
        return jsonSuccess({ messages: [], repositories: [] });
      }
      return success(
        humanOutput(formatMessage("info", "No cached repositories to sync.")),
      );
    }
    return operationResult(await syncRepositoryMessages(repositories), json);
  }

  const cachedRepositories = await listCachedRepositories();
  const selected = new Map<string, CachedRepository>();
  const messages: OperationMessage[] = [];

  for (const operand of operands) {
    let existing: CachedRepository | null;
    try {
      existing = await resolveCachedRepository(operand, cachedRepositories);
    } catch (error) {
      messages.push({
        kind: "error",
        text: `${operand}: ${getErrorMessage(error)}`,
      });
      continue;
    }

    if (existing) {
      selected.set(existing.mirrorPath, existing);
      continue;
    }

    let input: string;
    try {
      input = (await qualifyRepositorySpecifiers([operand]))[0] ?? operand;
    } catch (error) {
      messages.push({
        kind: "error",
        text: `${operand}: ${getErrorMessage(error)}`,
      });
      continue;
    }

    try {
      const repository = await runWithOptionalSpinner(
        `Caching ${operand}`,
        () => addCachedRepository(input),
        `Cached ${operand}`,
      );
      messages.push({
        kind: "success",
        text: `Cached ${repositoryDisplayName(repository)}: ${repository.mirrorPath}`,
      });
    } catch (error) {
      messages.push({
        kind: "error",
        text: `${operand}: ${getErrorMessage(error)}`,
      });
    }
  }

  messages.push(...(await syncRepositoryMessages([...selected.values()])));
  return operationResult(messages, json);
}

async function syncRepositoryMessages(
  repositories: readonly CachedRepository[],
): Promise<OperationMessage[]> {
  const messages: OperationMessage[] = [];
  for (const repository of repositories) {
    const name = repositoryDisplayName(repository);
    try {
      await runWithOptionalSpinner(
        `Updating ${name}`,
        () => updateCachedRepository(repository),
        `Updated ${name}`,
      );
      messages.push({
        kind: "success",
        text: `Updated ${name}`,
      });
    } catch (error) {
      messages.push({
        kind: "error",
        text: `${name}: ${getErrorMessage(error)}`,
      });
    }
  }
  return messages;
}

async function runCacheDoctor(
  selectors: readonly string[],
  options: Readonly<{ fix: boolean; json: boolean }>,
): Promise<CommandResult> {
  let repositories = await resolveRepositorySelection(selectors);
  if (options.fix) {
    await repairRepositories(repositories);
    repositories = await refreshRepositories(repositories);
  }

  return renderCacheHealth(repositories, options.json);
}

function renderCacheHealth(
  repositories: readonly CachedRepository[],
  json: boolean,
): CommandResult {
  const unhealthy = repositories.some(
    (repository) => repository.health !== "healthy",
  );

  if (json) {
    return withExitCode(jsonSuccess(repositories.map(toJson)), unhealthy);
  } else if (repositories.length === 0) {
    return success(
      reportOutput(
        renderReport({
          title: "Repository cache health",
          sections: [{ note: "No cached repositories." }],
        }),
      ),
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
                  tone: healthTone(repository),
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

async function repairRepositories(
  repositories: readonly CachedRepository[],
): Promise<void> {
  for (const repository of repositories) {
    const name = repositoryDisplayName(repository);
    try {
      await runWithOptionalSpinner(
        `Repairing ${name}`,
        () => repairCachedRepository(repository),
        `Repaired ${name}`,
      );
    } catch {
      // `doctor --fix` keeps the same report/JSON shape as `doctor`; failures
      // remain visible through the refreshed repository health record.
    }
  }
}

async function refreshRepositories(
  repositories: readonly CachedRepository[],
): Promise<CachedRepository[]> {
  const refreshed = await listCachedRepositories();
  return Promise.all(
    repositories.map(async (repository) => {
      try {
        return (
          (await resolveCachedRepository(repository.mirrorPath, refreshed)) ??
          repository
        );
      } catch {
        return repository;
      }
    }),
  );
}

async function runCacheDelete(
  selectors: readonly string[],
  options: Readonly<{ dryRun: boolean; force: boolean; json: boolean }>,
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
  return operationResult(messages, options.json);
}

async function runCacheClean(
  options: Readonly<{ dryRun: boolean; force: boolean; json: boolean }>,
): Promise<CommandResult> {
  const repositories = (await listCachedRepositories()).filter(
    (repository) => activeWorktreeCount(repository) === 0,
  );
  const nodeModules = await summarizeNodeModulesCache();
  if (repositories.length === 0 && nodeModules.entryCount === 0) {
    if (options.json) {
      return jsonSuccess({
        dryRun: options.dryRun,
        deleted: [],
        nodeModules: {
          deleted: [],
          totalSizeBytes: 0,
        },
        message: "No unused cached repositories.",
      });
    }
    return success(
      humanOutput(formatMessage("info", "No unused cached repositories.")),
    );
  }
  if (
    !(await confirmDeletion(repositories, options.force, options.dryRun, {
      nodeModules,
    }))
  ) {
    return success();
  }

  try {
    const [results, nodeModulesResult] = await Promise.all([
      cleanCachedRepositories({
        dryRun: options.dryRun,
        force: options.force,
      }),
      deleteNodeModulesCache(options.dryRun),
    ]);
    if (options.json) {
      return jsonSuccess({
        dryRun: options.dryRun,
        deleted: results.map((result) => toJson(result.repository)),
        totalSizeBytes: totalSize(results.map((result) => result.repository)),
        nodeModules: {
          deleted: nodeModulesResult.deleted.map((entry) => ({
            path: entry.entryPath,
            repo: entry.metadata.repo,
            cachedAt: entry.metadata.cachedAt,
            sourcePath: entry.metadata.sourcePath,
            sizeBytes: entry.metadata.sizeBytes,
          })),
          totalSizeBytes: nodeModulesResult.totalSizeBytes,
        },
      });
    }
    const verb = options.dryRun ? "Would delete" : "Deleted";
    const repositorySize = totalSize(
      results.map((result) => result.repository),
    );
    return success(
      humanOutput(
        formatMessage(
          "success",
          `${verb} ${results.length} unused repositor${results.length === 1 ? "y" : "ies"} (${formatByteSize(repositorySize)}) and ${nodeModulesResult.deleted.length} node_modules entr${nodeModulesResult.deleted.length === 1 ? "y" : "ies"} (${formatByteSize(nodeModulesResult.totalSizeBytes)})`,
        ),
      ),
    );
  } catch (error) {
    throw operationalError(error);
  }
}

function nodeModulesSummarySection(nodeModules: NodeModulesCacheSummary) {
  return {
    title: "node_modules pool",
    fields: [
      { label: "Entries", value: String(nodeModules.entryCount) },
      { label: "Repositories", value: String(nodeModules.repositoryCount) },
      { label: "Size", value: formatByteSize(nodeModules.sizeBytes) },
      { label: "Directory", value: nodeModules.path },
    ],
  };
}

function cacheListFooter(
  repositories: CachedRepository[],
  nodeModules: NodeModulesCacheSummary,
): string {
  return [
    `Directory: ${getCacheDir()}`,
    `${repositories.length} repositor${repositories.length === 1 ? "y" : "ies"}, ${formatByteSize(totalSize(repositories))}`,
    `${nodeModules.entryCount} node_modules entr${nodeModules.entryCount === 1 ? "y" : "ies"}, ${formatByteSize(nodeModules.sizeBytes)}`,
  ].join("\n");
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
  extra?: Readonly<{ nodeModules?: NodeModulesCacheSummary }>,
): Promise<boolean> {
  if (dryRun || force) return true;
  if (!isInteractive()) {
    throw new OperationalError(
      "Cannot confirm in non-interactive mode. Use --force.",
    );
  }

  const size = formatByteSize(totalSize(repositories));
  const nodeModules = extra?.nodeModules;
  const nodeModulesText =
    nodeModules && nodeModules.entryCount > 0
      ? ` and ${nodeModules.entryCount} node_modules entr${nodeModules.entryCount === 1 ? "y" : "ies"} (${formatByteSize(nodeModules.sizeBytes)})`
      : "";
  return promptConfirm(
    `Delete ${repositories.length} cached repositor${repositories.length === 1 ? "y" : "ies"} (${size})${nodeModulesText}?`,
    false,
  );
}

function renderRepositoryInfo(repository: CachedRepository): string {
  return renderReport({
    title: `Cached repository ${repositoryDisplayName(repository)}`,
    sections: [
      {
        fields: [
          {
            label: "Health",
            value: statusLabel(
              healthTone(repository),
              healthSummary(repository),
            ),
          },
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
              entries: repository.issues.map((issue) => ({
                title: issue,
                tone: "warning" as const,
              })),
            },
          ]
        : []),
      {
        title: "Worktrees",
        entries:
          repository.worktrees.length > 0
            ? repository.worktrees.map((worktree) => {
                const stale = worktree.prunable || !worktree.exists;
                return {
                  title: worktree.path,
                  tone: stale ? ("cancelled" as const) : ("success" as const),
                  details: [
                    {
                      label: "Branch",
                      value: worktree.detached
                        ? "(detached)"
                        : (worktree.branch ?? "(unknown)"),
                    },
                    { label: "State", value: stale ? "stale" : "active" },
                  ],
                };
              })
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

function healthTone(repository: CachedRepository): StatusTone {
  if (repository.health === "healthy") return "success";
  if (repository.health === "invalid") return "error";
  return "warning";
}

function formatDate(date: Date | null): string {
  return date ? date.toLocaleString() : "unknown";
}

function flag(invocation: ParsedInvocation, name: string): boolean {
  return invocation.flags[name] === true;
}

function operationalError(error: unknown): UsageError | OperationalError {
  return error instanceof UsageError || error instanceof OperationalError
    ? error
    : new OperationalError(getErrorMessage(error), { cause: error });
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

function operationResult(
  messages: readonly OperationMessage[],
  json = false,
): CommandResult {
  if (json) {
    const failed = messages.some((message) => message.kind !== "success");
    return withExitCode(jsonSuccess({ messages }), failed);
  }

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
  const messageRole = statusMessageRole(kind);
  return renderTerminalLineAnsi(
    terminalLine([
      "  ",
      terminalSpan(S_BAR, { role: "muted" }),
      "  ",
      terminalSpan(statusGlyph(kind), { role: statusGlyphRole(kind) }),
      " ",
      messageRole === undefined
        ? message
        : terminalSpan(message, { role: messageRole }),
    ]),
  );
}

function statusGlyph(kind: "error" | "info" | "success" | "warning"): string {
  return {
    error: terminalSymbol.error,
    info: terminalSymbol.info,
    success: terminalSymbol.success,
    warning: terminalSymbol.warning,
  }[kind];
}

function statusGlyphRole(
  kind: "error" | "info" | "success" | "warning",
): TerminalStyleRole {
  return kind === "info" ? "accent" : kind;
}

function statusMessageRole(
  kind: "error" | "info" | "success" | "warning",
): TerminalStyleRole | undefined {
  return kind === "info" ? undefined : kind;
}
