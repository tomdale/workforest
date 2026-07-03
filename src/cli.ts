import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathExists } from "@wf-plugin/core";
import { commandRegistry } from "./cli/commands.ts";
import {
  isArgumentParserError,
  OperationalError,
  UsageError,
} from "./cli/errors.ts";
import {
  applyExitCode,
  errorResult,
  failure,
  jsonSuccess,
  renderCommandResult,
  reportOutput,
  shellOutput,
  success,
} from "./cli/output.ts";
import { parseInvocation } from "./cli/parse-invocation.ts";
import { resolveCommand } from "./cli/resolve-command.ts";
import type {
  CommandResult,
  HelpReference,
  ParsedInvocation,
} from "./cli/types.ts";
import {
  isRepoSlug,
  loadWorkspaceConfig,
  saveWorkspaceConfig,
} from "./config.ts";
import type { Scope } from "./entry/entries-data.ts";
import {
  commandHelp,
  conceptsPage,
  help,
  nestedCommandHelp,
  renderHelp,
  workflowPage,
} from "./help.ts";
import { log } from "./logger.ts";
import {
  qualifyRepositorySpecifiers,
  qualifyTemplateRepositories,
  resolveRepositorySpecifiers,
} from "./repository-specifiers.ts";
import type { ServiceEventSink } from "./services/events.ts";
import {
  normalizeShellName,
  renderShellInit,
  reportShellCdTarget,
  writeShellCdPath,
} from "./shell.ts";
import {
  getTemplateAgentsMdStatus,
  refreshTemplateAgentsMd,
  type TemplateAgentsMdStatus,
} from "./templates/agents-md.ts";
import {
  createTemplate,
  createTemplateVariant,
  deleteTemplate,
  formatTemplateIdentifier,
  getTemplatesDir,
  listTemplates,
  loadTemplate,
  validateTemplateIdentifier,
  validateTemplateName,
} from "./templates/index.ts";
import { createAgentOutputStream } from "./terminal/agent-output.ts";
import { shouldUseFullscreenTui } from "./terminal/capabilities.ts";
import {
  printReport,
  type ReportField,
  type ReportSection,
} from "./terminal/report.ts";
import type {
  RepositorySource,
  TaskMetadata,
  WorkspaceConfig,
  WorkspaceMetadata,
  WorkspaceRepoMetadata,
} from "./types.ts";
import {
  intro,
  isInteractive,
  note,
  outro,
  promptConfirm,
  promptSelect,
  promptText,
} from "./ui/prompts/index.ts";
import { resolveBranchPrefix } from "./utils/branch-prefix.ts";
import { comparablePath, resolveContainedPath } from "./utils/path-safety.ts";
import type { CleanupState } from "./workspace/cleanup.ts";
import { resolveWorkforestContext } from "./workspace/context.ts";
import {
  hasWorkspaceMetadata,
  readWorkspaceMetadata,
} from "./workspace/metadata.ts";
import {
  ADHOC_WORKSPACE_GROUP,
  getWorktreePath,
  isComparablePathInsideOrEqual,
  isPathInsideOrEqual,
  resolveWorkforestDirectories,
} from "./workspace/paths.ts";
import type {
  CreateTasksResult,
  TaskFailure,
  TaskListEntry,
} from "./workspace/tasks.ts";

export { log };

type TemplateAddFileEntry = {
  sourcePath: string;
  targetPath: string;
  relativePath: string;
  type: "directory" | "file";
};

type TemplateAddFileConflictAction = "overwrite" | "diff" | "skip" | "cancel";

type RepositoryTaskCommandContext = {
  parentRepoDir: string;
  repoRootDir: string;
  repoName: string;
  changeName: string;
  repo: RepositorySource;
};

const humanServiceEventSink: ServiceEventSink = (event) => {
  if (event.type === "output") {
    const stream = event.stream === "stdout" ? process.stdout : process.stderr;
    stream.write(event.data);
    return;
  }

  log[event.level === "warning" ? "warn" : event.level](event.message);
};

function renderCleanupState(state: CleanupState, dryRun: boolean): void {
  switch (state.phase) {
    case "init":
    case "remove-dir":
      log.info(state.message);
      break;
    case "worktree":
      if (state.state.status === "log") {
        log[state.state.level](`${state.repo}: ${state.state.message}`);
      } else if (state.state.status === "skipped") {
        log.info(`${state.repo}: ${state.state.reason}`);
      } else if (state.state.status === "failed") {
        log.error(`${state.repo}: ${state.state.error.message}`);
      }
      break;
    case "worktree-complete":
      log.success(`${state.repo}: worktree removed from mirror`);
      break;
    case "remote-branch":
      if (state.status === "checking") {
        log.info(`${state.repo}: checking remote branch ${state.branch}`);
      } else if (state.status === "deleting") {
        log.info(`${state.repo}: deleting remote branch ${state.branch}`);
      } else if (state.status === "deleted") {
        log.success(`${state.repo}: deleted remote branch ${state.branch}`);
      } else if (state.status === "skipped") {
        log.info(`${state.repo}: skipped ${state.branch} - ${state.reason}`);
      } else {
        log.error(
          `${state.repo}: failed to delete ${state.branch} - ${state.reason}`,
        );
      }
      break;
    case "complete": {
      if (dryRun) {
        log.info("Dry-run complete. No changes made.");
        break;
      }
      const branchMessage = state.deletedBranches?.length
        ? `, deleted ${state.deletedBranches.length} remote branch(es)`
        : "";
      log.success(
        `Cleanup complete. Removed ${state.removedRepos.length} worktree(s)${branchMessage}.`,
      );
      break;
    }
  }
}

export async function cli(): Promise<void> {
  const result = await executeCli(process.argv.slice(2));
  renderCommandResult(result);
  applyExitCode(result.exitCode);
}

export async function executeCli(
  argv: readonly string[],
): Promise<CommandResult> {
  const errorOutputMode = requestsJsonOutput(argv) ? "json" : "human";

  try {
    const workerResult = await runPrivateWorkerIfRequested();
    if (workerResult) return workerResult;

    if (argv.length === 0 && shouldUseFullscreenTui()) {
      return runEntryCommand("go");
    }

    const resolution = resolveCommand(commandRegistry, argv);
    if (resolution.kind === "help") {
      return success({
        kind: "text",
        value: await renderHelpReference(
          resolution.help,
          resolution.canonicalPath,
        ),
        stream: "stdout",
      });
    }

    const invocation = parseInvocation(resolution, {
      interactive: isInteractive(),
    });
    rejectLegacyReviewSubcommand(invocation);
    if (invocation.helpRequested) {
      return success({
        kind: "text",
        value: await renderHelpReference(
          invocation.command.help,
          invocation.command.canonicalPath,
        ),
        stream: "stdout",
      });
    }

    return await runInvocation(invocation);
  } catch (error) {
    if (isArgumentParserError(error)) {
      return (
        errorResult(new UsageError(error.message), errorOutputMode) ?? success()
      );
    }
    const result = errorResult(error, errorOutputMode);
    if (result) {
      return result;
    }
    throw error;
  }
}

function rejectLegacyReviewSubcommand(invocation: ParsedInvocation): void {
  if (
    invocation.command.leaf.handler === "review" &&
    invocation.beforeDoubleDash[0] === "checkout"
  ) {
    throw new UsageError("Unknown wf review subcommand: checkout");
  }
}

async function runInvocation(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  switch (invocation.command.leaf.handler) {
    case "review":
      return runReviewInvocation(invocation);
    case "new":
      if (invocation.beforeDoubleDash.length === 0) {
        if (!shouldUseFullscreenTui()) {
          throw new UsageError("wf new requires a name.");
        }
        return runEntryCommand("create", {
          ...(invocation.flags["cloud"] === true ? { target: "cloud" } : {}),
        });
      }
      return runNewInvocation(invocation);
    case "list":
      return runTypedCommand(() => runListCommand(invocation));
    case "status":
      return runTypedCommand(() => runStatusCommand(invocation));
    case "add":
      return runTypedCommand(async () => {
        const { runAddCommand } = await import("./cli/add.ts");
        return runAddCommand(invocation, {
          interactive: isInteractive(),
          onEvent: humanServiceEventSink,
          writeShellCdPath,
        });
      });
    case "switch":
      return runTypedCommand(async () => {
        const { runSwitchCommand } = await import("./cli/switch.ts");
        const scope = await resolveCurrentScope();
        return runSwitchCommand(invocation, {
          interactive: isInteractive(),
          fullscreen: shouldUseFullscreenTui(),
          ...(scope ? { scope } : {}),
          writeShellCdPath,
        });
      });
    case "delete":
      return runTypedCommand(async () => {
        const { runDeleteCommand } = await import("./cli/delete.ts");
        return runDeleteCommand(invocation, {
          interactive: isInteractive(),
          writeShellCdPath,
          onCleanupState: (state) => renderCleanupState(state, false),
        });
      });
    case "ai.status":
      return runTypedCommand(() => runAiStatusCommand(invocation));
    case "migrate.workspaces":
      return runTypedCommand(async () => {
        const { runMigrateWorkspacesCommand } = await import(
          "./cli/migrate.ts"
        );
        return runMigrateWorkspacesCommand(invocation);
      });
    case "shell.init":
      return runShellInitCommand(
        invocation.beforeDoubleDash[0],
        jsonRequested(invocation),
      );
    case "config.show":
      return runConfigShow(jsonRequested(invocation));
    case "config.init":
      if (jsonRequested(invocation)) return unsupportedJson(invocation);
      return runConfigInit();
    case "config.edit":
      if (jsonRequested(invocation)) return unsupportedJson(invocation);
      return runConfigEdit();
    case "skills.list":
    case "skills.get": {
      const { runSkillsCommand } = await import("./skills.ts");
      switch (invocation.command.leaf.handler) {
        case "skills.list":
          return runSkillsCommand({
            command: "list",
            json: invocation.flags["json"] === true,
          });
        case "skills.get":
          return runSkillsCommand({
            command: "get",
            names: invocation.beforeDoubleDash,
            json: invocation.flags["json"] === true,
          });
      }
      throw new Error(
        `Unsupported skills handler: ${invocation.command.leaf.handler}`,
      );
    }
    case "help":
      if (jsonRequested(invocation)) {
        return jsonSuccess({ page: "help", content: await help() });
      }
      return success({
        kind: "text",
        value: await help(),
        stream: "stdout",
      });
    case "help.concepts":
      if (jsonRequested(invocation)) {
        return jsonSuccess({ page: "concepts", content: conceptsPage() });
      }
      return success({
        kind: "text",
        value: conceptsPage(),
        stream: "stdout",
      });
    case "help.workflow":
      if (jsonRequested(invocation)) {
        return jsonSuccess({ page: "workflow", content: workflowPage() });
      }
      return success({
        kind: "text",
        value: workflowPage(),
        stream: "stdout",
      });
    case "version":
      return runVersionCommand(jsonRequested(invocation));
  }

  if (invocation.command.leaf.handler.startsWith("template.")) {
    return runTemplateInvocation(invocation);
  }

  if (invocation.command.leaf.handler.startsWith("cache.")) {
    const { runCacheInvocation, runWorktreeInvocation } = await import(
      "./repository-cli.ts"
    );
    return invocation.command.leaf.handler.startsWith("cache.worktree.")
      ? runWorktreeInvocation(invocation)
      : runCacheInvocation(invocation);
  }

  if (invocation.command.leaf.handler.startsWith("cloud.")) {
    return runTypedCommand(async () => {
      const { runCloudInvocation } = await import("./cloud/cli.ts");
      return runCloudInvocation(invocation);
    });
  }

  if (invocation.command.leaf.handler.startsWith("task.")) {
    return runTaskInvocation(invocation);
  }

  throw new Error(
    `No CLI handler registered for ${invocation.command.leaf.handler}.`,
  );
}

/**
 * Open the universal "go to or create a worktree or workspace" surface. Lazy-imported so the
 * @unblessed runtime never loads on scriptable/JSON paths. `go` (bare `wf`)
 * searches existing changes and can create; `create` (`wf new`) skips the
 * existing-change search and goes straight to naming a new change.
 */
async function runNewInvocation(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  const sourceLess = invocation.beforeDoubleDash.length === 1;
  try {
    return await runTypedCommand(async () => {
      const { runNewCommand } = await import("./cli/new.ts");
      return runNewCommand(invocation, {
        interactive: isInteractive(),
        onEvent: humanServiceEventSink,
        writeShellCdPath,
      });
    });
  } catch (error) {
    if (
      !(
        sourceLess &&
        error instanceof OperationalError &&
        error.message === (await import("./cli/new.ts")).NEW_CONTEXT_ERROR &&
        shouldUseFullscreenTui()
      )
    ) {
      throw error;
    }

    const initialName = invocation.beforeDoubleDash[0];
    if (!initialName) throw error;
    const branchOverride = stringInvocationFlag(invocation, "branch");
    return runEntryCommand("create", {
      initialName,
      ...(invocation.flags["cloud"] === true ? { target: "cloud" } : {}),
      ...(branchOverride ? { branchOverride } : {}),
    });
  }
}

async function runEntryCommand(
  mode: "go" | "create",
  options: {
    initialName?: string;
    branchOverride?: string;
    target?: "local" | "cloud";
  } = {},
): Promise<CommandResult> {
  const { runEntry } = await import("./entry/surface.ts");
  const { buildCreateInput, create } = await import("./workspace/create.ts");
  const scope = await resolveCurrentScope();
  await runEntry(mode, {
    ...(scope ? { scope } : {}),
    ...(options.initialName ? { initialName: options.initialName } : {}),
    ...(options.target ? { initialTarget: options.target } : {}),
    commit: async ({ changeName, sources, target }) => {
      const input = await buildCreateInput({
        changeName,
        sources,
        ...(options.branchOverride
          ? { branchOverride: options.branchOverride }
          : {}),
      });
      if (target === "cloud") {
        const { config } = await loadWorkspaceConfig();
        const { createCloud } = await import("./cloud/provisioning.ts");
        await createCloud(input, {
          interactive: true,
          onEvent: humanServiceEventSink,
          config,
        });
        return;
      }
      await create(input, {
        interactive: true,
        onEvent: humanServiceEventSink,
        writeShellCdPath,
      });
    },
  });
  return success();
}

/**
 * Map the current working directory onto a entry scope so the surface can
 * default to the container the user launched from. Returns undefined outside a
 * Workforest change (e.g. a PR review worktree or an unrelated directory).
 */
async function resolveCurrentScope(): Promise<Scope | undefined> {
  try {
    const { config } = await loadWorkspaceConfig();
    const directories = resolveWorkforestDirectories(config);
    const context = resolveWorkforestContext(process.cwd(), directories);
    switch (context.kind) {
      case "worktree":
        return { kind: "repo", name: context.repoName };
      case "template-workspace":
        return { kind: "template", name: context.groupName };
      case "adhoc-workspace":
        return { kind: "adhoc", name: context.groupName };
      case "workspace-repo":
        return context.groupName === ADHOC_WORKSPACE_GROUP
          ? { kind: "adhoc", name: context.groupName }
          : { kind: "template", name: context.groupName };
      case "nested-task":
        if (context.parentKind === "worktree") {
          return { kind: "repo", name: context.repoName };
        }
        return context.groupName === undefined
          ? undefined
          : context.groupName === ADHOC_WORKSPACE_GROUP
            ? { kind: "adhoc", name: context.groupName }
            : { kind: "template", name: context.groupName };
      default:
        return undefined;
    }
  } catch {
    // Scope is a best-effort convenience; never block the surface on it.
    return undefined;
  }
}

async function runTaskInvocation(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  try {
    switch (invocation.command.leaf.handler) {
      case "task.new":
        return await runTaskStartInvocation(invocation);
      case "task.list":
        return await runTaskListInvocation(invocation);
      case "task.delete":
        return await runTaskDeleteInvocation(invocation);
      default:
        throw new Error(
          `No task handler registered for ${invocation.command.leaf.handler}.`,
        );
    }
  } catch (error) {
    throw operationalError(error);
  }
}

async function runTypedCommand(
  handler: () => Promise<CommandResult>,
): Promise<CommandResult> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof UsageError || error instanceof OperationalError) {
      throw error;
    }
    throw new OperationalError(getErrorMessage(error), { cause: error });
  }
}

function requestsJsonOutput(argv: readonly string[]): boolean {
  if (argv[0] === "cache" && argv[1] === "worktree") return false;
  const delimiter = argv.indexOf("--");
  const flags = delimiter === -1 ? argv : argv.slice(0, delimiter);
  return flags.some(
    (token) => token === "--json" || token.startsWith("--json="),
  );
}

function booleanInvocationFlag(
  invocation: ParsedInvocation,
  name: string,
): boolean {
  return invocation.flags[name] === true;
}

function stringInvocationFlag(
  invocation: ParsedInvocation,
  name: string,
): string | undefined {
  const value = invocation.flags[name];
  return typeof value === "string" ? value : undefined;
}

function jsonRequested(invocation: ParsedInvocation): boolean {
  return booleanInvocationFlag(invocation, "json");
}

function unsupportedJson(invocation: ParsedInvocation): CommandResult {
  throw new UsageError(
    `JSON output is not available for ${formatInvocationCommand(invocation)}.`,
  );
}

function formatInvocationCommand(invocation: ParsedInvocation): string {
  return `wf ${invocation.command.canonicalPath.join(" ")}`;
}

async function runPrivateWorkerIfRequested(): Promise<CommandResult | null> {
  const worker = process.env["WORKFOREST_WORKER"];
  if (!worker) return null;
  if (worker !== "repo-initializer") {
    throw new OperationalError(`Unknown Workforest worker: ${worker}`);
  }

  const workerScope = process.env["WORKFOREST_WORKER_SCOPE"] ?? "workspace";
  const repoName = process.env["WORKFOREST_WORKER_REPO"];
  const runId = process.env["WORKFOREST_WORKER_RUN_ID"];
  if (!repoName || !runId) {
    throw new OperationalError(
      "Repository initialization worker requires WORKFOREST_WORKER_REPO and WORKFOREST_WORKER_RUN_ID.",
    );
  }

  const {
    runRepoInitializationWorker,
    worktreeInitializationScope,
    workspaceInitializationScope,
  } = await import("./workspace/initialization.ts");
  const scope =
    workerScope === "worktree"
      ? worktreeInitializationScope({
          repoRootDir: requiredWorkerEnv("WORKFOREST_WORKER_REPO_ROOT"),
          changeName: requiredWorkerEnv("WORKFOREST_WORKER_CHANGE"),
        })
      : workspaceInitializationScope(
          requiredWorkerEnv("WORKFOREST_WORKER_WORKSPACE"),
        );

  try {
    await runRepoInitializationWorker({ scope, repoName, runId });
    return success();
  } catch (error) {
    throw new OperationalError(getErrorMessage(error), { cause: error });
  }
}

function requiredWorkerEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new OperationalError(
      `Repository initialization worker requires ${name}.`,
    );
  }
  return value;
}

async function renderHelpReference(
  reference: HelpReference,
  pathSegments: readonly string[],
): Promise<string> {
  let rendered: string | null;
  switch (reference.kind) {
    case "root":
      return help();
    case "command":
      rendered = commandHelp(reference.command);
      break;
    case "nested":
      rendered = nestedCommandHelp(reference.command, reference.subcommand);
      break;
  }

  return (
    rendered ??
    renderHelp(`Usage: wf ${pathSegments.join(" ")}

No additional help is available for this internal command.`)
  );
}

async function runShellInitCommand(
  requestedShell: string | undefined,
  json: boolean,
): Promise<CommandResult> {
  requestedShell ??= process.env["SHELL"];
  const shell = normalizeShellName(requestedShell);

  if (!shell) {
    throw new UsageError(
      "Unsupported shell. Use 'wf shell init zsh' or 'wf shell init bash'.",
    );
  }

  const script = renderShellInit(shell);
  return json ? jsonSuccess({ shell, script }) : success(shellOutput(script));
}

async function runConfigInit(): Promise<CommandResult> {
  if (!isInteractive()) {
    throw new OperationalError(
      "Config init requires an interactive terminal.\nUse 'wf config edit' to edit the config file directly.",
    );
  }

  const { path: configPath, config } = await loadWorkspaceConfigForCommand();

  intro("Configure workforest");

  const currentDirectory = config.directory ?? {};
  const directoryBase = await promptText("Directory base", {
    defaultValue: currentDirectory.base ?? "~/Code",
  });
  const directoryRepos = await promptText("Repository changes directory", {
    defaultValue: currentDirectory.repos ?? "Repos",
  });
  const directoryWorkspaces = await promptText("Workspace changes directory", {
    defaultValue: currentDirectory.workspaces ?? "Workspaces",
  });
  const directoryReviews = await promptText("Review checkouts directory", {
    defaultValue: currentDirectory.reviews ?? "Reviews",
  });
  const currentBranchPrefix = config.branchPrefix ?? "";
  const branchPrefix = await promptText(
    'Branch prefix (e.g., "feature/" for feature/name)',
    { defaultValue: currentBranchPrefix },
  );

  const newConfig: WorkspaceConfig = {
    ...(config.vercelLink ? { vercelLink: config.vercelLink } : {}),
    ...(config.ai ? { ai: config.ai } : {}),
    directory: {
      base: directoryBase,
      repos: directoryRepos,
      workspaces: directoryWorkspaces,
      reviews: directoryReviews,
    },
    ...(branchPrefix ? { branchPrefix } : {}),
  };

  note(
    [
      `directory.base: ${directoryBase || "(default)"}`,
      `directory.repos: ${directoryRepos || "(default)"}`,
      `directory.workspaces: ${directoryWorkspaces || "(default)"}`,
      `directory.reviews: ${directoryReviews || "(default)"}`,
      `Branch prefix: "${branchPrefix}"`,
    ].join("\n"),
    "Configuration preview",
  );

  const shouldSave = await promptConfirm("Save configuration?", true);
  if (!shouldSave) {
    outro("Configuration unchanged");
    return success();
  }

  await saveWorkspaceConfigForCommand(configPath, newConfig);
  outro(`Config saved to ${configPath}`);
  return success();
}

async function runConfigShow(json: boolean): Promise<CommandResult> {
  const { path: configPath, config } = await loadWorkspaceConfigForCommand();
  const directory = config.directory ?? {};
  const resolvedDirectories = resolveWorkforestDirectories(config);

  const ownerMappings = Object.entries(
    config.vercelLink?.teamByGitHubOwner ?? {},
  );
  const repoOverrides = Object.entries(config.vercelLink?.repoOverrides ?? {});
  const aiConfig = config.ai;

  if (json) {
    return jsonSuccess({
      path: configPath,
      config,
      resolvedDirectories,
      defaults: {
        directory: {
          base: directory.base ?? "~/Code",
          repos: directory.repos ?? "Repos",
          workspaces: directory.workspaces ?? "Workspaces",
          reviews: directory.reviews ?? "Reviews",
        },
        branchPrefix: config.branchPrefix ?? "",
      },
    });
  }

  printReport({
    title: "Workspace configuration",
    sections: [
      {
        fields: [
          {
            label: "directory.base",
            value: directory.base ?? "~/Code",
          },
          {
            label: "directory.repos",
            value: directory.repos ?? "Repos",
          },
          {
            label: "directory.workspaces",
            value: directory.workspaces ?? "Workspaces",
          },
          {
            label: "directory.reviews",
            value: directory.reviews ?? "Reviews",
          },
          {
            label: "Branch prefix",
            value: `"${config.branchPrefix ?? ""}"`,
          },
        ],
      },
      {
        title: "Examples",
        fields: [
          { label: "directory.base", value: "~/Code" },
          { label: "directory.repos", value: "Repos" },
          {
            label: "directory.workspaces",
            value: "Workspaces",
          },
          {
            label: "directory.reviews",
            value: "Reviews",
          },
          {
            label: "Branch prefix",
            value: '"tom/" creates tom/my-feature',
          },
        ],
      },
      {
        title: "Resolved directories",
        fields: [
          { label: "Repos", value: resolvedDirectories.repos },
          { label: "Workspaces", value: resolvedDirectories.workspaces },
          { label: "Reviews", value: resolvedDirectories.reviews },
        ],
      },
      ...(config.vercelLink
        ? [
            {
              title: "Vercel auto-link",
              fields: [
                {
                  label: "GitHub owners",
                  value:
                    ownerMappings.length > 0
                      ? ownerMappings
                          .map(([owner, team]) => `${owner} -> ${team}`)
                          .join(", ")
                      : "(none)",
                },
                {
                  label: "Repository overrides",
                  value:
                    repoOverrides.length > 0
                      ? repoOverrides
                          .map(([repo, override]) => {
                            if (override.disabled) return `${repo}: disabled`;
                            if (override.team)
                              return `${repo}: ${override.team}`;
                            return `${repo}: no-op`;
                          })
                          .join(", ")
                      : "(none)",
                },
              ],
            },
          ]
        : []),
      ...(aiConfig
        ? [
            {
              title: "AI",
              fields: [
                {
                  label: "Provider",
                  value: aiConfig.provider ?? "(auto)",
                },
                {
                  label: "Model",
                  value: aiConfig.model ?? "(provider default)",
                },
                {
                  label: "Timeout",
                  value:
                    aiConfig.timeoutMs === undefined
                      ? "120000ms"
                      : `${aiConfig.timeoutMs}ms`,
                },
                {
                  label: "Disabled",
                  value: aiConfig.disabled ? "yes" : "no",
                },
              ],
            },
          ]
        : []),
    ],
    footer: `Config: ${configPath}`,
  });
  return success();
}

async function runConfigEdit(): Promise<CommandResult> {
  const { path: configPath } = await loadWorkspaceConfigForCommand();

  // Get editor from environment
  const editor = process.env["EDITOR"] || process.env["VISUAL"] || "vi";

  log.info(`Opening ${configPath} in ${editor}...`);

  const child = spawn(editor, [configPath], {
    stdio: "inherit",
  });

  await new Promise<void>((resolve, reject) => {
    child.on("close", (code) => {
      if (code === 0) {
        log.success("Config file closed.");
        resolve();
      } else {
        reject(new OperationalError(`Editor exited with code ${code}`));
      }
    });
    child.on("error", (error) => {
      reject(new OperationalError(`Could not open editor: ${error.message}`));
    });
  });
  return success();
}

async function loadWorkspaceConfigForCommand(): Promise<
  Awaited<ReturnType<typeof loadWorkspaceConfig>>
> {
  try {
    return await loadWorkspaceConfig();
  } catch (error) {
    throw new OperationalError(getErrorMessage(error), { cause: error });
  }
}

async function saveWorkspaceConfigForCommand(
  configPath: string,
  config: WorkspaceConfig,
): Promise<void> {
  try {
    await saveWorkspaceConfig(configPath, config);
  } catch (error) {
    throw new OperationalError(getErrorMessage(error), { cause: error });
  }
}

async function runVersionCommand(json: boolean): Promise<CommandResult> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = path.join(__dirname, "..", "package.json");
  const packageJson = JSON.parse(
    await fs.readFile(packageJsonPath, "utf8"),
  ) as { version: string };
  if (json) {
    return jsonSuccess({ version: packageJson.version });
  }
  return success({
    kind: "text",
    value: `workforest ${packageJson.version}`,
    stream: "stdout",
  });
}

async function runAiStatusCommand(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  const { getAiStatus, renderAiStatus } = await import(
    "./services/ai/index.ts"
  );
  const status = await getAiStatus();
  return booleanInvocationFlag(invocation, "json")
    ? jsonSuccess(status)
    : success(reportOutput(renderAiStatus(status)));
}

async function runListCommand(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  const { config } = await loadWorkspaceConfig();
  const { collectInventory, renderList } = await import(
    "./workspace/inventory.ts"
  );
  const repoFilter = stringInvocationFlag(invocation, "repo");
  const groupFilter = stringInvocationFlag(invocation, "group");
  const inventory = await collectInventory(config, {
    ...(repoFilter ? { repo: repoFilter } : {}),
    ...(groupFilter ? { group: groupFilter } : {}),
  });

  return booleanInvocationFlag(invocation, "json")
    ? jsonSuccess(inventory)
    : success(
        reportOutput(
          renderList(inventory, {
            paths: booleanInvocationFlag(invocation, "paths"),
          }),
        ),
      );
}

async function runStatusCommand(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  if (
    booleanInvocationFlag(invocation, "watch") &&
    booleanInvocationFlag(invocation, "json")
  ) {
    throw new UsageError('Flag "--watch" cannot be combined with "--json".');
  }

  const { config } = await loadWorkspaceConfig();
  const selector = invocation.beforeDoubleDash[0];
  const { resolveSelector } = await import("./workspace/selectors.ts");
  const resolution = await resolveSelector(config, selector);

  if (resolution.kind === "outside") {
    throw new OperationalError(
      [
        "Not in a Workforest worktree or workspace.",
        "Run: wf list",
        "Or create explicitly: wf new <name> <repo|@template>",
      ].join("\n"),
    );
  }
  if (resolution.kind === "missing") {
    throw new UsageError(`Unknown selector: ${resolution.selector}`);
  }
  if (resolution.kind === "ambiguous") {
    throw new UsageError(
      [
        `Ambiguous selector "${resolution.selector}".`,
        "Matches:",
        ...resolution.matches.map((match) => `  ${match}`),
        resolution.hint ?? "Use <group>/<name>.",
      ].join("\n"),
    );
  }

  const { buildStatus, initializationScope, renderStatus } = await import(
    "./workspace/status.ts"
  );
  const status = await buildStatus(resolution.entry);

  if (booleanInvocationFlag(invocation, "watch")) {
    if (!status.initialization || status.initialization.repos.length === 0) {
      return success(
        reportOutput(
          renderStatus(status, {
            note: "No initialization is recorded for this worktree or workspace; showing the static report.",
          }),
        ),
      );
    }

    if (!isInteractive()) {
      return success(
        reportOutput(
          renderStatus(status, {
            note: "Initialization watcher requires an interactive terminal; showing the static report.",
          }),
        ),
      );
    }

    const { renderInitializationStatus } = await import(
      "./ui/initialization-status.ts"
    );
    await renderInitializationStatus(
      initializationScope(resolution.entry),
      status.initialization.repos.map((state) => state.repo),
    );
    return success();
  }

  return booleanInvocationFlag(invocation, "json")
    ? jsonSuccess(status)
    : success(reportOutput(renderStatus(status)));
}

async function runTaskStartInvocation(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  const repo = stringFlag(invocation, "repo");
  const json = jsonRequested(invocation);
  const workspaceDir = await detectWorkspaceFromCwd();
  if (workspaceDir) {
    return runTaskStart(
      {
        slugs: [...invocation.beforeDoubleDash],
        repo,
        dryRun: booleanFlag(invocation, "dryRun"),
        force: booleanFlag(invocation, "force"),
        json,
      },
      workspaceDir,
    );
  }

  const context = await resolveRepositoryTaskCommandContext(repo);
  if (context) {
    return runRepositoryTaskStart({
      slugs: [...invocation.beforeDoubleDash],
      context,
      dryRun: booleanFlag(invocation, "dryRun"),
      force: booleanFlag(invocation, "force"),
      json,
    });
  }

  throw new OperationalError(
    "Run wf task new from inside a workspace repo or worktree. A task is a nested worktree inside an existing worktree or workspace, and --repo selects which workspace repository to branch from — it does not name a workspace to create one in.",
  );
}

async function runTaskListInvocation(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  const repo = stringFlag(invocation, "repo");
  return runTaskList({
    repo,
    json: jsonRequested(invocation),
  });
}

async function runTaskDeleteInvocation(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  return runTaskDelete({
    names: [...invocation.beforeDoubleDash],
    repo: stringFlag(invocation, "repo"),
    dryRun: booleanFlag(invocation, "dryRun"),
    force: booleanFlag(invocation, "force"),
    json: jsonRequested(invocation),
  });
}

function booleanFlag(invocation: ParsedInvocation, name: string): boolean {
  return invocation.flags[name] === true;
}

function stringFlag(
  invocation: ParsedInvocation,
  name: string,
): string | undefined {
  const value = invocation.flags[name];
  return typeof value === "string" ? value : undefined;
}

async function runReviewInvocation(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  if (invocation.command.leaf.handler !== "review") {
    throw new Error(
      `Unsupported review handler: ${invocation.command.leaf.handler}`,
    );
  }

  const json = jsonRequested(invocation);
  const dispatch = await resolveReviewDispatch(invocation.beforeDoubleDash);
  return dispatch.kind === "workspace"
    ? runReviewWorkspace(dispatch.target, json)
    : runReviewCheckout(dispatch.target, json);
}

type ReviewDispatch =
  | Readonly<{
      kind: "workspace";
      target: { owner: string; repo: string };
    }>
  | Readonly<{
      kind: "checkout";
      target: { owner: string; repo: string; prNumber: number };
    }>;

async function resolveReviewDispatch(
  targetArgs: readonly string[],
): Promise<ReviewDispatch> {
  let resolvedTargetArgs: string[];
  try {
    resolvedTargetArgs = await qualifyReviewRepositorySpecifier(targetArgs);
  } catch (error) {
    throw reviewTargetUsageError(targetArgs, error);
  }

  const { parseReviewRepoTarget, resolveReviewTarget } = await import(
    "./review.ts"
  );
  const context = await resolveCurrentReviewWorkspaceContext();

  if (resolvedTargetArgs.length === 1) {
    try {
      return {
        kind: "checkout",
        target: resolveReviewTarget(resolvedTargetArgs, context ?? undefined),
      };
    } catch (checkoutError) {
      try {
        return {
          kind: "workspace",
          target: parseReviewRepoTarget(resolvedTargetArgs),
        };
      } catch {
        throw reviewTargetUsageError(targetArgs, checkoutError);
      }
    }
  }

  if (resolvedTargetArgs.length === 2) {
    try {
      return {
        kind: "checkout",
        target: resolveReviewTarget(resolvedTargetArgs, context ?? undefined),
      };
    } catch (error) {
      throw reviewTargetUsageError(targetArgs, error);
    }
  }

  throw reviewTargetUsageError(targetArgs);
}

function reviewTargetUsageError(
  targetArgs: readonly string[],
  cause?: unknown,
): UsageError {
  const target = targetArgs.length > 0 ? targetArgs.join(" ") : "(missing)";
  const detail = cause ? ` ${getErrorMessage(cause)}` : "";
  return new UsageError(
    `Invalid review target "${target}". Accepted forms: wf review <owner>/<repo>, wf review <cached-repo>, wf review <owner>/<repo>#<number>, wf review <owner>/<repo> <number>, wf review https://github.com/<owner>/<repo>/pull/<number>, or inside a review workspace wf review <number>.${detail}`,
  );
}

async function runReviewWorkspace(
  target: { owner: string; repo: string },
  json: boolean,
): Promise<CommandResult> {
  try {
    const { ensureReviewWorkspace } = await import("./review.ts");
    const reviewsRoot = await resolveReviewsDir();
    const workspace = await ensureReviewWorkspace({
      target,
      reviewsRoot,
      interactive: !json && isInteractive(),
      ...(json ? {} : { onEvent: humanServiceEventSink }),
    });

    if (json) {
      return jsonSuccess({
        target,
        path: workspace.path,
      });
    }

    log.success(`Review workspace ready: ${workspace.path}`);
    await reportShellCdTarget(workspace.path);
    return success();
  } catch (error) {
    throw toOperationalError(error);
  }
}

async function runReviewCheckout(
  target: { owner: string; repo: string; prNumber: number },
  json: boolean,
): Promise<CommandResult> {
  try {
    const { createReviewWorktree } = await import("./review.ts");
    const reviewsRoot = await resolveReviewsDir();
    const metadata = await createReviewWorktree({
      target,
      reviewsRoot,
      interactive: !json && isInteractive(),
      ...(json ? {} : { onEvent: humanServiceEventSink }),
    });

    if (json) {
      return jsonSuccess({
        target,
        metadata,
        path: metadata.path,
      });
    }

    log.success(`Review worktree ready: ${metadata.path}`);
    await reportShellCdTarget(metadata.path);
    return success();
  } catch (error) {
    throw toOperationalError(error);
  }
}

async function qualifyReviewRepositorySpecifier(
  targetArgs: readonly string[],
): Promise<string[]> {
  if (targetArgs.length === 2) {
    const [repoSpecifier, prNumber] = targetArgs;
    if (repoSpecifier && prNumber && !isRepoSlug(repoSpecifier)) {
      const [qualified] = await qualifyRepositorySpecifiers([repoSpecifier]);
      return [qualified ?? repoSpecifier, prNumber];
    }
    return [...targetArgs];
  }

  if (targetArgs.length !== 1) {
    return [...targetArgs];
  }

  const target = targetArgs[0] ?? "";
  if (
    isRepoSlug(target) ||
    /^#?[1-9][0-9]*$/.test(target) ||
    /^(?:https?:\/\/|github\.com\/)/i.test(target)
  ) {
    return [target];
  }

  const compact = target.match(/^([^#]+)(#.+)$/);
  if (compact?.[1] && compact[2]) {
    if (isRepoSlug(compact[1])) {
      return [target];
    }
    const [qualified] = await qualifyRepositorySpecifiers([compact[1]]);
    return [`${qualified ?? compact[1]}${compact[2]}`];
  }

  const [qualified] = await qualifyRepositorySpecifiers([target]);
  return [qualified ?? target];
}

async function resolveCurrentReviewWorkspaceContext(): Promise<{
  owner: string;
  repo: string;
} | null> {
  const workspaceDir = await detectWorkspaceFromCwd();
  if (!workspaceDir) return null;

  const metadata = await readWorkspaceMetadata(workspaceDir);
  if (metadata?.workspace.type !== "review" || !metadata.workspace.review) {
    return null;
  }

  return metadata.workspace.review;
}

async function resolveReviewsDir(): Promise<string> {
  const { config } = await loadWorkspaceConfig();
  return resolveWorkforestDirectories(config).reviews;
}

async function resolveRepositoryTaskCommandContext(
  repoFlag: string | undefined,
): Promise<RepositoryTaskCommandContext | null> {
  const { config } = await loadWorkspaceConfig();
  const directories = await comparableWorkforestDirectories(
    resolveWorkforestDirectories(config),
  );
  const context = resolveWorkforestContext(
    await comparablePath(process.cwd()),
    directories,
  );
  const repositoryContext =
    context.kind === "worktree"
      ? {
          repoName: context.repoName,
          changeName: context.changeName,
        }
      : context.kind === "nested-task" && context.parentKind === "worktree"
        ? {
            repoName: context.repoName,
            changeName: context.changeName,
          }
        : null;

  if (!repositoryContext) {
    return null;
  }

  if (repoFlag && repoFlag !== repositoryContext.repoName) {
    throw new UsageError(
      `Current worktree is ${repositoryContext.repoName}/${repositoryContext.changeName}; omit --repo or use --repo ${repositoryContext.repoName}.`,
    );
  }

  const [repo] = await resolveRepositorySpecifiers([
    repositoryContext.repoName,
  ]);
  if (!repo) {
    throw new Error(`Unknown repository "${repositoryContext.repoName}".`);
  }

  const parentRepoDir = getWorktreePath(
    directories,
    repositoryContext.repoName,
    repositoryContext.changeName,
  );

  return {
    parentRepoDir,
    repoRootDir: path.dirname(parentRepoDir),
    repoName: repositoryContext.repoName,
    changeName: repositoryContext.changeName,
    repo,
  };
}

async function comparableWorkforestDirectories(
  directories: ReturnType<typeof resolveWorkforestDirectories>,
): Promise<ReturnType<typeof resolveWorkforestDirectories>> {
  return {
    base: await comparablePath(directories.base),
    repos: await comparablePath(directories.repos),
    workspaces: await comparablePath(directories.workspaces),
    reviews: await comparablePath(directories.reviews),
  };
}

async function runTaskStart(
  {
    slugs,
    repo,
    dryRun,
    force,
    json,
  }: {
    slugs: string[];
    repo: string | undefined;
    dryRun: boolean;
    force: boolean;
    json: boolean;
  },
  workspaceDir: string,
): Promise<CommandResult> {
  try {
    const metadata = await readWorkspaceMetadata(workspaceDir);
    if (!metadata) {
      throw new Error(`Could not read workspace metadata from ${workspaceDir}`);
    }

    const parentRepo = resolveWorkspaceRepoForWorktreeCommand({
      workspaceDir,
      metadata,
      repoName: repo,
      cwd: process.cwd(),
      allowTask: true,
    });

    const template = metadata.workspace.template_id
      ? await loadTemplate(
          formatTemplateIdentifier({
            parent: metadata.workspace.template_id,
            variant: metadata.workspace.template_variant,
          }),
        )
      : null;
    const { config: workspaceConfig } = await loadWorkspaceConfig();
    const branchPrefix = resolveBranchPrefix(
      workspaceConfig.branchPrefix,
      template?.config.branchPrefix,
    );

    const { createTasks } = await import("./workspace/tasks.ts");
    const result = await createTasks({
      workspaceDir,
      parentRepo,
      slugs,
      ...(branchPrefix !== undefined ? { branchPrefix } : {}),
      dryRun,
      force,
      interactive: !json && isInteractive(),
      ...(template?.config.disableInitializers !== undefined
        ? { disabledInitializers: template.config.disableInitializers }
        : {}),
      ...(json ? {} : { onEvent: humanServiceEventSink }),
    });

    const failed = taskStartFailed(result);
    if (json) {
      return withExitCode(
        jsonSuccess({
          dryRun,
          created: result.created,
          failures: taskFailuresJson(result.failures),
        }),
        failed,
      );
    }

    if (dryRun) {
      showDryRunReport({
        sections: [
          {
            entries: result.created.map((worktree) => ({
              title: worktree.slug,
              details: [
                { label: "Repository", value: worktree.parentRepo },
                { label: "Branch", value: worktree.branch },
                { label: "Target", value: worktree.path },
              ],
            })),
          },
        ],
      });
      return success();
    }

    for (const worktree of result.created) {
      const setup =
        worktree.setupStatus === "ready"
          ? "ready"
          : `setup failed${worktree.setupLog ? ` (log: ${worktree.setupLog})` : ""}`;
      log.success(`${worktree.slug}: ${worktree.path} (${setup})`);
    }

    for (const failure of result.failures) {
      log.error(`${failure.slug}: ${failure.error.message}`);
    }

    await reportSingleCreatedTaskTarget(result, failed);

    if (failed) {
      return failure(1, { kind: "none" });
    }
    return success();
  } catch (error) {
    throw operationalError(error);
  }
}

async function runRepositoryTaskStart({
  slugs,
  context,
  dryRun,
  force,
  json,
}: {
  slugs: string[];
  context: RepositoryTaskCommandContext;
  dryRun: boolean;
  force: boolean;
  json: boolean;
}): Promise<CommandResult> {
  try {
    const { config } = await loadWorkspaceConfig();
    const branchPrefix = resolveBranchPrefix(config.branchPrefix, undefined);
    const { createRepositoryTasks } = await import("./workspace/tasks.ts");
    const result = await createRepositoryTasks({
      parentRepoDir: context.parentRepoDir,
      repo: context.repo,
      changeName: context.changeName,
      slugs,
      ...(branchPrefix !== undefined ? { branchPrefix } : {}),
      dryRun,
      force,
      interactive: !json && isInteractive(),
      ...(json ? {} : { onEvent: humanServiceEventSink }),
    });

    const failed = taskStartFailed(result);
    if (json) {
      return withExitCode(
        jsonSuccess({
          dryRun,
          changeName: context.changeName,
          created: result.created,
          failures: taskFailuresJson(result.failures),
        }),
        failed,
      );
    }

    if (dryRun) {
      showDryRunReport({
        sections: [
          {
            entries: result.created.map((worktree) => ({
              title: worktree.slug,
              details: [
                { label: "Repository", value: worktree.parentRepo },
                { label: "Change", value: context.changeName },
                { label: "Branch", value: worktree.branch },
                { label: "Target", value: worktree.path },
              ],
            })),
          },
        ],
      });
      return success();
    }

    for (const worktree of result.created) {
      const setup =
        worktree.setupStatus === "ready"
          ? "ready"
          : `setup failed${worktree.setupLog ? ` (log: ${worktree.setupLog})` : ""}`;
      log.success(`${worktree.slug}: ${worktree.path} (${setup})`);
    }

    for (const failure of result.failures) {
      log.error(`${failure.slug}: ${failure.error.message}`);
    }

    await reportSingleCreatedTaskTarget(result, failed);

    if (failed) {
      return failure(1, { kind: "none" });
    }
    return success();
  } catch (error) {
    throw operationalError(error);
  }
}

function taskStartFailed(result: CreateTasksResult): boolean {
  return (
    result.failures.length > 0 ||
    result.created.some((worktree) => worktree.setupStatus === "failed")
  );
}

async function reportSingleCreatedTaskTarget(
  result: CreateTasksResult,
  commandFailed: boolean,
): Promise<void> {
  if (result.created.length !== 1 || result.failures.length > 0) {
    return;
  }

  const target = result.created[0]?.path;
  if (!target) {
    return;
  }

  if (commandFailed) {
    await reportShellCdTarget(target, { mode: "manual" });
    return;
  }

  await reportShellCdTarget(target);
}

async function runTaskList({
  repo,
  json,
}: {
  repo?: string | undefined;
  json: boolean;
}): Promise<CommandResult> {
  const workspaceDir = await detectWorkspaceFromCwd();
  if (!workspaceDir) {
    const context = await resolveRepositoryTaskCommandContext(repo);
    if (!context) {
      throw new OperationalError(
        "Not inside a Workforest worktree or workspace.",
      );
    }
    return runRepositoryTaskList(context, json);
  }

  try {
    const metadata = await readWorkspaceMetadata(workspaceDir);
    if (!metadata) {
      throw new Error(`Could not read workspace metadata from ${workspaceDir}`);
    }

    const parentRepoName =
      repo ??
      resolveWorkspaceRepoNameFromCwd({
        workspaceDir,
        metadata,
        cwd: process.cwd(),
        allowTask: true,
      });

    const { listTasks } = await import("./workspace/tasks.ts");
    const entries = await listTasks(workspaceDir, parentRepoName);

    if (json) {
      return jsonSuccess({
        workspaceDir,
        repo: parentRepoName ?? null,
        tasks: entries,
      });
    }

    if (entries.length === 0) {
      log.info("No tasks found.");
      return success();
    }

    printReport({
      title: "Tasks",
      sections: taskListReportSections(entries),
      footer: [
        `Workspace: ${workspaceDir}`,
        `${entries.length} task${entries.length === 1 ? "" : "s"}`,
      ].join("\n"),
    });
    return success();
  } catch (error) {
    throw operationalError(error);
  }
}

async function runRepositoryTaskList(
  context: RepositoryTaskCommandContext,
  json: boolean,
): Promise<CommandResult> {
  try {
    const { listRepositoryTasks } = await import("./workspace/tasks.ts");
    const entries = await listRepositoryTasks({
      parentRepoDir: context.parentRepoDir,
      repoName: context.repoName,
      changeName: context.changeName,
    });

    if (json) {
      return jsonSuccess({
        worktree: {
          repo: context.repoName,
          changeName: context.changeName,
          path: context.parentRepoDir,
        },
        tasks: entries,
      });
    }

    if (entries.length === 0) {
      log.info("No tasks found.");
      return success();
    }

    printReport({
      title: "Tasks",
      sections: taskListReportSections(entries, {
        changeName: context.changeName,
      }),
      footer: [
        `Repository change: ${context.repoName}/${context.changeName}`,
        `${entries.length} task${entries.length === 1 ? "" : "s"}`,
      ].join("\n"),
    });
    return success();
  } catch (error) {
    throw operationalError(error);
  }
}

function taskListReportSections(
  entries: readonly TaskListEntry[],
  options: { changeName?: string } = {},
): ReportSection[] {
  const grouped = new Map<string, TaskListEntry[]>();
  for (const entry of entries) {
    const group = grouped.get(entry.parent_repo) ?? [];
    group.push(entry);
    grouped.set(entry.parent_repo, group);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([repoName, tasks]) => ({
      title: options.changeName
        ? `${repoName}/${options.changeName}`
        : repoName,
      entries: tasks
        .slice()
        .sort((left, right) => left.slug.localeCompare(right.slug))
        .map((entry) => ({
          title: entry.slug,
          tone:
            entry.state === "ready"
              ? ("success" as const)
              : entry.state === "failed"
                ? ("error" as const)
                : ("cancelled" as const),
          details: [
            { label: "Branch", value: entry.branch },
            { label: "Status", value: entry.state },
            {
              label: "Merged",
              value:
                entry.merged === null ? "unknown" : entry.merged ? "yes" : "no",
            },
            { label: "Path", value: entry.absolutePath },
          ],
        })),
    }));
}

function taskFailuresJson(failures: readonly TaskFailure[]) {
  return failures.map((failure) => ({
    slug: failure.slug,
    error: failure.error.message,
  }));
}

function withExitCode(result: CommandResult, failed: boolean): CommandResult {
  return failed ? { ...result, exitCode: 1 } : result;
}

async function runTaskDelete({
  names,
  repo,
  dryRun,
  force,
  json,
}: {
  names: string[];
  repo?: string | undefined;
  dryRun: boolean;
  force: boolean;
  json: boolean;
}): Promise<CommandResult> {
  const workspaceDir = await detectWorkspaceFromCwd();
  if (!workspaceDir) {
    const context = await resolveRepositoryTaskCommandContext(repo);
    if (!context) {
      throw new OperationalError(
        "Not inside a Workforest worktree or workspace.",
      );
    }
    return runRepositoryTaskDelete({
      names,
      context,
      dryRun,
      force,
      json,
    });
  }

  try {
    const metadata = await readWorkspaceMetadata(workspaceDir);
    if (!metadata) {
      throw new Error(`Could not read workspace metadata from ${workspaceDir}`);
    }

    const parentRepoName =
      repo ??
      resolveWorkspaceRepoNameFromCwd({
        workspaceDir,
        metadata,
        cwd: process.cwd(),
        allowTask: true,
      });

    const { deleteTasks } = await import("./workspace/tasks.ts");
    const invocationCwd = process.cwd();
    const result = await deleteTasks({
      workspaceDir,
      slugs: names,
      dryRun,
      force,
      ...(parentRepoName ? { parentRepoName } : {}),
    });

    const cdTarget = await workspaceTaskRemovalCdTarget(
      result.removed,
      workspaceDir,
      invocationCwd,
    );
    if (json) {
      return jsonSuccess({
        dryRun,
        removed: result.removed,
      });
    }

    if (dryRun) {
      showDryRunReport({
        sections: [
          {
            entries: result.removed.map((entry) => ({
              title: entry.slug,
              details: [
                { label: "Repository", value: entry.parent_repo },
                { label: "Branch", value: entry.branch },
                {
                  label: "Path",
                  value: resolveContainedPath(workspaceDir, entry.path),
                },
              ],
            })),
          },
        ],
      });
    } else {
      for (const entry of result.removed) {
        log.success(`Removed ${entry.slug}`);
      }
      await writeTaskRemovalCdTarget(cdTarget);
    }
    return success();
  } catch (error) {
    throw operationalError(error);
  }
}

async function runRepositoryTaskDelete({
  names,
  context,
  dryRun,
  force,
  json,
}: {
  names: string[];
  context: RepositoryTaskCommandContext;
  dryRun: boolean;
  force: boolean;
  json: boolean;
}): Promise<CommandResult> {
  try {
    const { deleteRepositoryTasks } = await import("./workspace/tasks.ts");
    const invocationCwd = process.cwd();
    const result = await deleteRepositoryTasks({
      parentRepoDir: context.parentRepoDir,
      repo: context.repo,
      repoName: context.repoName,
      changeName: context.changeName,
      slugs: names,
      dryRun,
      force,
    });

    const cdTarget = await repositoryTaskRemovalCdTarget(
      result.removed,
      context,
      invocationCwd,
    );
    if (json) {
      return jsonSuccess({
        dryRun,
        changeName: context.changeName,
        removed: result.removed,
      });
    }

    if (dryRun) {
      showDryRunReport({
        sections: [
          {
            entries: result.removed.map((entry) => ({
              title: entry.slug,
              details: [
                { label: "Repository", value: entry.parent_repo },
                { label: "Change", value: context.changeName },
                { label: "Branch", value: entry.branch },
                {
                  label: "Path",
                  value: resolveContainedPath(context.repoRootDir, entry.path),
                },
              ],
            })),
          },
        ],
      });
    } else {
      for (const entry of result.removed) {
        log.success(`Removed ${entry.slug}`);
      }
      await writeTaskRemovalCdTarget(cdTarget);
    }
    return success();
  } catch (error) {
    throw operationalError(error);
  }
}

async function workspaceTaskRemovalCdTarget(
  removed: readonly Pick<TaskMetadata, "parent_repo" | "path">[],
  workspaceDir: string,
  invocationCwd: string,
): Promise<string | undefined> {
  for (const entry of removed) {
    const taskDir = resolveContainedPath(workspaceDir, entry.path);
    if (await isComparablePathInsideOrEqual(taskDir, invocationCwd)) {
      return resolveContainedPath(workspaceDir, entry.parent_repo);
    }
  }
  return undefined;
}

async function repositoryTaskRemovalCdTarget(
  removed: readonly Pick<TaskMetadata, "path">[],
  context: RepositoryTaskCommandContext,
  invocationCwd: string,
): Promise<string | undefined> {
  for (const entry of removed) {
    const taskDir = resolveContainedPath(context.repoRootDir, entry.path);
    if (await isComparablePathInsideOrEqual(taskDir, invocationCwd)) {
      return context.parentRepoDir;
    }
  }
  return undefined;
}

async function writeTaskRemovalCdTarget(
  target: string | undefined,
): Promise<void> {
  if (!target) return;
  await reportShellCdTarget(target);
}

async function runTemplateInvocation(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  const json = jsonRequested(invocation);
  switch (invocation.command.leaf.handler) {
    case "template.list":
      return runTemplateList(json);
    case "template.open":
      return runTemplateOpen(
        await resolveTemplateOperand(invocation, json),
        json,
      );
    case "template.show":
      return runTemplateShow(
        await resolveTemplateOperand(invocation, json),
        json,
      );
    case "template.suggest": {
      if (json) return unsupportedJson(invocation);
      const { runTemplateSuggestCommand } = await import(
        "./cli/template-suggest.ts"
      );
      return runTemplateSuggestCommand({ interactive: isInteractive() });
    }
    case "template.new":
      return runTemplateNew(invocation, json);
    case "template.variant.new":
      return runTemplateVariantNew(invocation, json);
    case "template.edit":
      if (json) return unsupportedJson(invocation);
      return runTemplateEdit(await resolveTemplateOperand(invocation, json));
    case "template.add-file":
      return runTemplateAddFile(invocation, json);
    case "template.agents-md.status":
      return runTemplateAgentsMdStatus(
        await resolveTemplateOperand(invocation, json),
        json,
      );
    case "template.agents-md.refresh":
      return runTemplateAgentsMdRefresh(
        await resolveTemplateOperand(invocation, json),
        invocation.flags["force"] === true,
        json,
      );
    case "template.copy":
      return runTemplateCopy(
        invocation.beforeDoubleDash[0] ?? "",
        invocation.beforeDoubleDash[1] ?? "",
        json,
      );
    case "template.delete":
      return runTemplateDelete(
        await resolveTemplateOperand(invocation, json),
        invocation.flags["force"] === true,
        json,
      );
    default:
      throw new Error(
        `No template handler registered for ${invocation.command.leaf.handler}.`,
      );
  }
}

async function resolveTemplateOperand(
  invocation: ParsedInvocation,
  json: boolean,
): Promise<string> {
  const explicitTemplateId = invocation.beforeDoubleDash[0];
  const useParent = invocation.flags["parent"] === true;

  if (explicitTemplateId) {
    if (useParent) {
      throw new UsageError(
        'Flag "--parent" can only be used when <template> is omitted.',
      );
    }
    return explicitTemplateId;
  }

  const commandName = invocation.command.canonicalPath.join(" ");
  const workspaceDir = await detectWorkspaceFromCwd();
  if (!workspaceDir) {
    throw new UsageError(`wf ${commandName} requires <template>.`);
  }

  const metadata = await readWorkspaceMetadata(workspaceDir);
  if (!metadata?.workspace.template_id) {
    throw new OperationalError(
      "Current workspace was not created from a template.",
    );
  }

  const parent = metadata.workspace.template_id;
  const variant = metadata.workspace.template_variant;
  if (variant && !useParent) {
    const templateId = formatTemplateIdentifier({ parent, variant });
    if (!json) {
      log.warn(
        `Inferred template variant "${templateId}" from the current workspace. Use --parent to target "${parent}".`,
      );
    }
    return templateId;
  }

  return parent;
}

async function requireTemplate(templateId: string) {
  const template = await loadTemplate(templateId);
  if (!template)
    throw new OperationalError(`Template "${templateId}" not found.`);
  return template;
}

async function runTemplateAgentsMdStatus(
  templateId: string,
  json: boolean,
): Promise<CommandResult> {
  const template = await requireTemplate(templateId);
  const guidance = await getTemplateAgentsMdStatus(template);
  if (json) return jsonSuccess({ guidance });
  printReport({
    title: `AGENTS.md guidance for ${template.id}`,
    sections: [
      {
        fields: [
          { label: "State", value: guidance.state },
          ...(guidance.manifest
            ? [
                { label: "Generated", value: guidance.manifest.generatedAt },
                { label: "Expires", value: guidance.manifest.expiresAt },
                { label: "Artifact", value: guidance.manifest.artifact },
              ]
            : []),
        ],
      },
    ],
    ...(guidance.state === "fresh"
      ? {}
      : { footer: `Refresh: wf template agents-md refresh ${template.id}` }),
  });
  return templateSuccess();
}

async function runTemplateAgentsMdRefresh(
  templateId: string,
  force: boolean,
  json: boolean,
): Promise<CommandResult> {
  const template = await requireTemplate(templateId);
  const repos = await resolveRepositorySpecifiers(template.config.repos);
  const stream = json ? null : createAgentOutputStream();
  let guidance: TemplateAgentsMdStatus;
  try {
    guidance = await refreshTemplateAgentsMd(template, repos, {
      force,
      ...(stream
        ? {
            onProgress: (message: string) => {
              stream.finishLine();
              log.info(message);
              if (message.startsWith("Generating focused guidance")) {
                process.stdout.write("\n");
              }
            },
            onEvent: stream.writeEvent,
          }
        : {}),
    });
  } catch (error) {
    throw new OperationalError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  } finally {
    stream?.finishLine();
  }
  if (json) return jsonSuccess({ action: "refreshed", guidance });
  log.success(`Refreshed AGENTS.md guidance for "${template.id}".`);
  log.info(`Artifact: ${guidance.artifactPath}`);
  return templateSuccess();
}

function templateSuccess(): CommandResult {
  return success();
}

function templateFailure(): CommandResult {
  return failure(1, { kind: "none" });
}

function templateJson(
  template: NonNullable<Awaited<ReturnType<typeof loadTemplate>>>,
): Record<string, unknown> {
  return {
    id: template.id,
    path: template.path,
    directory: template.directory,
    parentId: template.parentId,
    variantId: template.variantId ?? null,
    parentPath: template.parentPath ?? null,
    config: template.config,
  };
}

async function runTemplateList(json: boolean): Promise<CommandResult> {
  const templates = await listTemplates();
  const guidanceStates = new Map(
    await Promise.all(
      templates.map(
        async (template) =>
          [
            template.id,
            (await getTemplateAgentsMdStatus(template)).state,
          ] as const,
      ),
    ),
  );

  if (json) {
    return jsonSuccess({
      templates: templates.map((template) => ({
        ...templateJson(template),
        guidance: guidanceStates.get(template.id),
      })),
      templatesDir: getTemplatesDir(),
    });
  }

  if (templates.length === 0) {
    printReport({
      title: "Templates",
      sections: [{ note: "No templates configured." }],
      footer: `Directory: ${getTemplatesDir()}`,
    });
    return templateSuccess();
  }

  printReport({
    title: "Templates",
    sections: [
      {
        entries: templates.map((template) => ({
          title: template.id,
          ...(template.config.description
            ? { description: template.config.description }
            : {}),
          details: [
            {
              label: "Repositories",
              value: template.config.repos.join(", "),
            },
            {
              label: "AGENTS.md",
              value: guidanceStates.get(template.id) ?? "disabled",
            },
          ],
        })),
      },
    ],
    footer: [
      `Directory: ${getTemplatesDir()}`,
      `${templates.length} template${templates.length === 1 ? "" : "s"}`,
    ].join("\n"),
  });
  return templateSuccess();
}

async function runTemplateOpen(
  templateId: string,
  json: boolean,
): Promise<CommandResult> {
  const template = await loadTemplate(templateId);
  if (!template) {
    if (json) {
      throw new OperationalError(`Template "${templateId}" not found.`);
    }
    log.error(`Template "${templateId}" not found.`);
    const templates = await listTemplates();
    if (templates.length > 0) {
      log.info(`Available: ${templates.map((t) => t.id).join(", ")}`);
    }
    return templateFailure();
  }

  const templateDir = path.dirname(template.path);
  if (json) {
    return jsonSuccess({
      template: templateJson(template),
      path: templateDir,
    });
  }

  await reportShellCdTarget(templateDir);
  return templateSuccess();
}

async function runTemplateShow(
  templateId: string,
  json: boolean,
): Promise<CommandResult> {
  const template = await loadTemplate(templateId);
  if (!template) {
    if (json) {
      throw new OperationalError(`Template "${templateId}" not found.`);
    }
    log.error(`Template "${templateId}" not found.`);
    const templates = await listTemplates();
    if (templates.length > 0) {
      log.info(`Available: ${templates.map((t) => t.id).join(", ")}`);
    }
    return templateFailure();
  }

  let workspaceBranchPrefix: string | undefined;
  try {
    ({
      config: { branchPrefix: workspaceBranchPrefix },
    } = await loadWorkspaceConfig());
  } catch {
    workspaceBranchPrefix = undefined;
  }
  const branchPrefixSummary =
    template.config.branchPrefix === undefined
      ? workspaceBranchPrefix
        ? `inherits global (${workspaceBranchPrefix})`
        : "inherits global (none)"
      : template.config.branchPrefix === ""
        ? "disabled for this template"
        : template.config.branchPrefix;
  const filesDir = path.join(path.dirname(template.path), "files");
  const hasFiles = await pathExists(filesDir);
  const guidance = await getTemplateAgentsMdStatus(template);
  const variants =
    template.variantId === undefined
      ? (await listTemplates()).filter(
          (candidate) =>
            candidate.parentId === template.id && candidate.variantId,
        )
      : [];

  if (json) {
    return jsonSuccess({
      template: templateJson(template),
      branchPrefixSummary,
      filesDir: hasFiles ? filesDir : null,
      guidance,
      variants: variants.map(templateJson),
    });
  }

  printReport({
    title: `Template ${template.id}`,
    sections: [
      {
        fields: [
          ...(template.config.description
            ? [{ label: "Description", value: template.config.description }]
            : []),
          { label: "Branch prefix", value: branchPrefixSummary },
          { label: "AGENTS.md", value: guidance.state },
          ...(hasFiles ? [{ label: "Files", value: filesDir }] : []),
        ],
      },
      {
        title: "Repositories",
        entries: template.config.repos.map((repo) => ({ title: repo })),
      },
      ...(template.config.hooks && template.config.hooks.length > 0
        ? [
            {
              title: "Hooks",
              entries: template.config.hooks.map((hook) => ({
                title: hook.name,
                details: [
                  { label: "Command", value: hook.run },
                  ...(hook.in
                    ? [{ label: "Runs in", value: String(hook.in) }]
                    : []),
                ],
              })),
            },
          ]
        : []),
      ...(variants.length > 0
        ? [
            {
              title: "Variants",
              entries: variants.map((variant) => ({
                title: variant.id,
                ...(variant.config.description
                  ? { description: variant.config.description }
                  : {}),
              })),
            },
          ]
        : []),
    ],
    footer: `Config: ${template.path}`,
  });
  return templateSuccess();
}

async function runTemplateVariantNew(
  invocation: ParsedInvocation,
  json: boolean,
): Promise<CommandResult> {
  const operands = invocation.beforeDoubleDash;
  let parentId: string | undefined;
  let variantId: string | undefined;

  if (operands.length >= 2) {
    parentId = operands[0];
    variantId = operands[1];
  } else {
    variantId = operands[0];
    const workspaceDir = await detectWorkspaceFromCwd();
    if (workspaceDir) {
      const metadata = await readWorkspaceMetadata(workspaceDir);
      parentId = metadata?.workspace.template_id;
    }
  }

  if (!parentId || !variantId) {
    if (json) {
      throw new UsageError("Usage: wf template variant new <parent> <variant>");
    }
    log.error("Usage: wf template variant new <parent> <variant>");
    return templateFailure();
  }

  validateTemplateName(parentId);
  validateTemplateName(variantId);
  const canonicalId = formatTemplateIdentifier({
    parent: parentId,
    variant: variantId,
  });
  if (await loadTemplate(canonicalId)) {
    if (json) {
      throw new OperationalError(`Template "${canonicalId}" already exists.`);
    }
    log.error(`Template "${canonicalId}" already exists.`);
    return templateFailure();
  }

  const description =
    typeof invocation.flags["description"] === "string"
      ? invocation.flags["description"].trim()
      : isInteractive()
        ? (
            await promptText("Description", { placeholder: "(optional)" })
          ).trim()
        : "";
  await createTemplateVariant(parentId, variantId, {
    ...(description ? { description } : {}),
  });
  const created = await loadTemplate(canonicalId);
  if (json) {
    return jsonSuccess({
      action: "created",
      template: created ? templateJson(created) : { id: canonicalId },
    });
  }
  log.success(`Template variant "${canonicalId}" created.`);
  log.info(
    `Location: ${getTemplatesDir()}/${parentId}/variants/${variantId}/template.jsonc`,
  );
  return templateSuccess();
}

async function runTemplateNew(
  invocation: ParsedInvocation,
  json: boolean,
): Promise<CommandResult> {
  let templateId = invocation.beforeDoubleDash[0];
  let repos = invocation.beforeDoubleDash.slice(1);

  if (!templateId) {
    templateId = await promptText("Template name", {
      validate: (input) => {
        try {
          validateTemplateName(input.trim());
          return null;
        } catch (error) {
          return getErrorMessage(error);
        }
      },
    });
  }

  // Check if template already exists
  const existing = await loadTemplate(templateId);
  if (existing) {
    if (json) {
      throw new OperationalError(`Template "${templateId}" already exists.`);
    }
    log.error(`Template "${templateId}" already exists.`);
    return templateFailure();
  }

  // If no repos provided via args, prompt for them
  if (repos.length === 0) {
    const reposInput = await promptText(
      "Repositories (cached name, org/repo, or git URL; comma-separated)",
      {
        validate: (input) => {
          if (!input.trim()) {
            return "At least one repository is required";
          }
          return null;
        },
      },
    );

    repos = reposInput
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
  }

  try {
    repos = await qualifyRepositorySpecifiers(repos);
  } catch (error) {
    if (json) throw operationalError(error);
    log.error(getErrorMessage(error));
    return templateFailure();
  }

  // Get description from flag or prompt
  let description =
    typeof invocation.flags["description"] === "string"
      ? invocation.flags["description"]
      : undefined;
  if (description === undefined && isInteractive()) {
    description = await promptText("Description", {
      placeholder: "(optional)",
    });
  }

  const trimmedDescription = description?.trim();
  await createTemplate(templateId, {
    repos,
    ...(trimmedDescription && { description: trimmedDescription }),
  });

  const created = await loadTemplate(templateId);
  if (json) {
    return jsonSuccess({
      action: "created",
      template: created ? templateJson(created) : { id: templateId, repos },
    });
  }

  log.success(`Template "${templateId}" created.`);
  log.info(`Location: ${getTemplatesDir()}/${templateId}/template.jsonc`);
  return templateSuccess();
}

async function runTemplateDelete(
  templateId: string,
  force: boolean,
  json: boolean,
): Promise<CommandResult> {
  validateTemplateIdentifier(templateId);
  const template = await loadTemplate(templateId);
  if (!template) {
    if (json) {
      throw new OperationalError(`Template "${templateId}" not found.`);
    }
    log.error(`Template "${templateId}" not found.`);
    return templateFailure();
  }

  // Confirm deletion unless --force is passed
  if (!force) {
    if (json) {
      throw new OperationalError(
        "Cannot confirm deletion in JSON mode. Use --force.",
      );
    }
    if (!isInteractive()) {
      log.error(
        "Cannot confirm deletion in non-interactive mode. Use --force.",
      );
      return templateFailure();
    }

    const confirmed = await promptConfirm(`Delete template "${templateId}"?`);
    if (!confirmed) {
      log.info("Deletion cancelled.");
      return templateSuccess();
    }
  }

  await deleteTemplate(templateId);
  if (json) {
    return jsonSuccess({
      action: "deleted",
      template: templateJson(template),
    });
  }
  log.success(`Template "${templateId}" deleted.`);
  return templateSuccess();
}

async function runTemplateEdit(templateId: string): Promise<CommandResult> {
  validateTemplateIdentifier(templateId);
  if (!isInteractive()) {
    log.error("Template editing requires an interactive terminal.");
    return templateFailure();
  }

  const template = await loadTemplate(templateId);
  if (!template) {
    log.error(`Template "${templateId}" not found.`);
    const templates = await listTemplates();
    if (templates.length > 0) {
      log.info(`Available: ${templates.map((t) => t.id).join(", ")}`);
    }
    return templateFailure();
  }

  const { config: workspaceConfig } = await loadWorkspaceConfig();
  const { renderTemplateEditor } = await import("./ui/index.ts");

  await renderTemplateEditor({
    templateId,
    initialConfig: template.config,
    workspaceConfig,
    onSave: async (config) => {
      const qualifiedConfig = await qualifyTemplateRepositories(config);
      if (template.variantId) {
        await createTemplateVariant(
          template.parentId,
          template.variantId,
          qualifiedConfig,
        );
      } else {
        await createTemplate(templateId, qualifiedConfig);
      }
      log.success(`Template "${templateId}" saved.`);
    },
  });
  return templateSuccess();
}

async function runTemplateAddFile(
  invocation: ParsedInvocation,
  json: boolean,
): Promise<CommandResult> {
  let sourceInputs = [...invocation.beforeDoubleDash];
  const workspaceDir = await detectWorkspaceFromCwd();
  let templateId =
    typeof invocation.flags["template"] === "string"
      ? invocation.flags["template"]
      : undefined;
  let resolvedTemplate: Awaited<ReturnType<typeof loadTemplate>> | null = null;
  if (!workspaceDir && !templateId) {
    templateId = sourceInputs[0];
    sourceInputs = sourceInputs.slice(1);
    if (!templateId || sourceInputs.length === 0) {
      if (json) {
        throw new UsageError(
          "Usage: workforest template add-file <template> <path...>",
        );
      }
      log.error("Usage: workforest template add-file <template> <path...>");
      return templateFailure();
    }
  }

  const sourceRoot = workspaceDir ?? process.cwd();

  if (!templateId) {
    if (!workspaceDir) {
      if (json) throw new OperationalError("Not inside a workspace.");
      log.error("Not inside a workspace.");
      return templateFailure();
    }

    const firstInput = sourceInputs[0];
    if (!firstInput) {
      if (json) {
        throw new UsageError(
          "Usage: workforest template add-file [--template <name>] <path...>",
        );
      }
      log.error(
        "Usage: workforest template add-file [--template <name>] <path...>",
      );
      return templateFailure();
    }

    let candidateTemplate: Awaited<ReturnType<typeof loadTemplate>> = null;
    try {
      validateTemplateIdentifier(firstInput);
      candidateTemplate = await loadTemplate(firstInput);
    } catch {
      // The first argument is a workspace-relative source path, not a template.
    }
    const candidatePath = path.resolve(firstInput);
    const candidateExists = await pathExists(candidatePath);

    if (candidateTemplate && candidateExists) {
      log.error(
        `Ambiguous add-file argument "${firstInput}": it matches both a template and an existing file or directory.`,
      );
      return templateFailure();
    }

    if (candidateTemplate) {
      templateId = firstInput;
      resolvedTemplate = candidateTemplate;
      sourceInputs = sourceInputs.slice(1);
      if (sourceInputs.length === 0) {
        if (json) {
          throw new UsageError(
            "Usage: workforest template add-file <template> <path...>",
          );
        }
        log.error("Usage: workforest template add-file <template> <path...>");
        return templateFailure();
      }
    } else if (!candidateExists) {
      if (json) {
        throw new OperationalError(
          `Could not resolve add-file argument "${firstInput}" as either a template or an existing file or directory.`,
        );
      }
      log.error(
        `Could not resolve add-file argument "${firstInput}" as either a template or an existing file or directory.`,
      );
      return templateFailure();
    }
  }

  if (!templateId) {
    if (!workspaceDir) {
      if (json) throw new OperationalError("Not inside a workspace.");
      log.error("Not inside a workspace.");
      return templateFailure();
    }

    let metadata: WorkspaceMetadata | null;
    try {
      metadata = await readWorkspaceMetadata(workspaceDir);
    } catch (error) {
      if (json) throw operationalError(error);
      log.error(getErrorMessage(error));
      return templateFailure();
    }

    if (!metadata?.workspace.template_id) {
      if (json) {
        throw new OperationalError(
          "Current workspace was not created from a template.",
        );
      }
      log.error("Current workspace was not created from a template.");
      return templateFailure();
    }

    templateId = formatTemplateIdentifier({
      parent: metadata.workspace.template_id,
      variant: metadata.workspace.template_variant,
    });
  }

  const template = resolvedTemplate ?? (await loadTemplate(templateId));
  if (!template) {
    if (json) {
      throw new OperationalError(`Template "${templateId}" not found.`);
    }
    log.error(`Template "${templateId}" not found.`);
    return templateFailure();
  }

  const entries: TemplateAddFileEntry[] = [];
  for (const sourceInput of sourceInputs) {
    const resolved = await resolveTemplateAddFileEntries({
      sourceInput,
      sourceRoot,
      templatePath: template.path,
      quiet: json,
    });
    if (!resolved) {
      if (json) {
        throw new OperationalError(
          `Could not resolve template file entry: ${sourceInput}`,
        );
      }
      return templateFailure();
    }
    entries.push(...resolved);
  }

  const totalFileCount = entries.filter(
    (entry) => entry.type === "file",
  ).length;
  const skippedTargetPaths = new Set<string>();
  let copiedCount = 0;
  let skippedCount = 0;

  for (const entry of entries) {
    if (entry.type === "directory") {
      if (await pathExists(entry.targetPath)) {
        const targetStat = await fs.stat(entry.targetPath);
        if (!targetStat.isDirectory()) {
          if (json) {
            throw new OperationalError(
              `Template path already exists: ${entry.targetPath}`,
            );
          }
          log.error(`Template path already exists: ${entry.targetPath}`);
          return templateFailure();
        }
      }
      continue;
    }

    if (await pathExists(entry.targetPath)) {
      const targetStat = await fs.stat(entry.targetPath);
      if (!targetStat.isFile()) {
        if (json) {
          throw new OperationalError(
            `Template path already exists: ${entry.targetPath}`,
          );
        }
        log.error(`Template path already exists: ${entry.targetPath}`);
        return templateFailure();
      }

      const diff = await runNoIndexDiff(entry.targetPath, entry.sourcePath);
      if (!diff) {
        skippedTargetPaths.add(entry.targetPath);
        continue;
      }

      const action = await resolveTemplateAddFileConflict(
        entry,
        totalFileCount,
        diff,
        json,
      );

      if (action === "cancel") {
        log.info("Cancelled.");
        return templateFailure();
      }

      if (action === "skip") {
        skippedTargetPaths.add(entry.targetPath);
      }
    }
  }

  for (const entry of entries) {
    if (entry.type === "directory") {
      await fs.mkdir(entry.targetPath, { recursive: true });
      continue;
    }

    if (skippedTargetPaths.has(entry.targetPath)) {
      skippedCount += 1;
    } else {
      await fs.mkdir(path.dirname(entry.targetPath), { recursive: true });
      await fs.copyFile(entry.sourcePath, entry.targetPath);
      copiedCount += 1;
    }
  }

  const suffix =
    skippedCount > 0 ? ` (${copiedCount} copied, ${skippedCount} skipped)` : "";
  const sourceSummary =
    sourceInputs.length === 1
      ? entries[0]?.relativePath
      : `${sourceInputs.length} paths`;
  if (json) {
    return jsonSuccess({
      action: "added-files",
      template: templateJson(template),
      copiedCount,
      skippedCount,
      entries: entries.map(
        ({ sourcePath, targetPath, relativePath, type }) => ({
          sourcePath,
          targetPath,
          relativePath,
          type,
          skipped: skippedTargetPaths.has(targetPath),
        }),
      ),
    });
  }
  log.success(`Added ${sourceSummary} to template "${template.id}".${suffix}`);
  return templateSuccess();
}

async function resolveTemplateAddFileEntries({
  sourceInput,
  sourceRoot,
  templatePath,
  quiet = false,
}: {
  sourceInput: string;
  sourceRoot: string;
  templatePath: string;
  quiet?: boolean;
}): Promise<TemplateAddFileEntry[] | null> {
  const sourcePath = path.resolve(sourceInput);
  const relativePath = path.relative(sourceRoot, sourcePath);

  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    if (!quiet) log.error(`File must be inside ${sourceRoot}: ${sourcePath}`);
    return null;
  }

  let sourceStat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    sourceStat = await fs.stat(sourcePath);
  } catch {
    if (!quiet) log.error(`File not found: ${sourcePath}`);
    return null;
  }

  if (!sourceStat.isFile() && !sourceStat.isDirectory()) {
    if (!quiet) log.error(`Not a file or directory: ${sourcePath}`);
    return null;
  }

  const targetPath = resolveContainedPath(
    path.dirname(templatePath),
    "files",
    relativePath,
  );

  return sourceStat.isDirectory()
    ? collectTemplateAddFileDirectoryEntries(
        sourcePath,
        targetPath,
        relativePath,
      )
    : [
        {
          sourcePath,
          targetPath,
          relativePath,
          type: "file" as const,
        },
      ];
}

async function collectTemplateAddFileDirectoryEntries(
  sourceDir: string,
  targetDir: string,
  sourceRelativePath: string,
): Promise<TemplateAddFileEntry[]> {
  const entries: TemplateAddFileEntry[] = [
    {
      sourcePath: sourceDir,
      targetPath: targetDir,
      relativePath: sourceRelativePath,
      type: "directory",
    },
  ];

  async function walk(currentSourceDir: string, currentTargetDir: string) {
    const children = await fs.readdir(currentSourceDir, {
      withFileTypes: true,
    });

    for (const child of children) {
      const childSourcePath = resolveContainedPath(
        currentSourceDir,
        child.name,
      );
      const childTargetPath = resolveContainedPath(
        currentTargetDir,
        child.name,
      );
      const childRelativePath = path.join(
        sourceRelativePath,
        path.relative(sourceDir, childSourcePath),
      );

      if (child.isDirectory()) {
        entries.push({
          sourcePath: childSourcePath,
          targetPath: childTargetPath,
          relativePath: childRelativePath,
          type: "directory",
        });
        await walk(childSourcePath, childTargetPath);
      } else if (child.isFile()) {
        entries.push({
          sourcePath: childSourcePath,
          targetPath: childTargetPath,
          relativePath: childRelativePath,
          type: "file",
        });
      } else {
        log.warn(`Skipping unsupported path: ${childSourcePath}`);
      }
    }
  }

  await walk(sourceDir, targetDir);
  return entries;
}

async function resolveTemplateAddFileConflict(
  entry: TemplateAddFileEntry,
  totalFileCount: number,
  diff: string,
  json: boolean,
): Promise<Exclude<TemplateAddFileConflictAction, "diff">> {
  if (!isInteractive()) {
    if (json) {
      throw new OperationalError(
        `Template file already exists: ${entry.targetPath}`,
      );
    }
    log.error(`Template file already exists: ${entry.targetPath}`);
    return "cancel";
  }

  log.warn(`Template file already exists: ${entry.relativePath}`);

  while (true) {
    const action = await promptSelect<TemplateAddFileConflictAction>(
      "Choose how to handle the existing template file",
      {
        options: [
          {
            label: "Overwrite",
            value: "overwrite",
            description: "Replace the template file with the workspace file",
          },
          {
            label: "Show diff",
            value: "diff",
            description: "Compare the template file with the workspace file",
          },
          {
            label: "Skip",
            value: "skip",
            description: "Leave the template file unchanged",
          },
          ...(totalFileCount > 1
            ? [
                {
                  label: "Cancel",
                  value: "cancel" as const,
                  description: "Stop adding files",
                },
              ]
            : []),
        ],
      },
    );

    if (action === "diff") {
      showTemplateAddFileDiff(diff);
      continue;
    }

    return action;
  }
}

function showTemplateAddFileDiff(diff: string): void {
  console.log(diff);
}

function runNoIndexDiff(oldPath: string, newPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["diff", "--no-index", "--", oldPath, newPath]);

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code === 0 || code === 1) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `git diff exited with code ${code}`));
      }
    });
  });
}

async function runTemplateCopy(
  sourceId: string,
  destId: string,
  json: boolean,
): Promise<CommandResult> {
  validateTemplateName(sourceId);
  validateTemplateName(destId);
  // Load source template
  const sourceTemplate = await loadTemplate(sourceId);
  if (!sourceTemplate) {
    if (json) {
      throw new OperationalError(`Source template "${sourceId}" not found.`);
    }
    log.error(`Source template "${sourceId}" not found.`);
    const templates = await listTemplates();
    if (templates.length > 0) {
      log.info(`Available: ${templates.map((t) => t.id).join(", ")}`);
    }
    return templateFailure();
  }

  // Check destination doesn't exist
  const destTemplate = await loadTemplate(destId);
  if (destTemplate) {
    if (json) {
      throw new OperationalError(`Template "${destId}" already exists.`);
    }
    log.error(`Template "${destId}" already exists.`);
    return templateFailure();
  }

  // Create the copy
  await createTemplate(destId, sourceTemplate.config);
  const copied = await loadTemplate(destId);
  if (json) {
    return jsonSuccess({
      action: "copied",
      source: templateJson(sourceTemplate),
      template: copied ? templateJson(copied) : { id: destId },
    });
  }
  log.success(`Template "${sourceId}" copied to "${destId}".`);
  return templateSuccess();
}

function operationalError(error: unknown): UsageError | OperationalError {
  return error instanceof UsageError || error instanceof OperationalError
    ? error
    : new OperationalError(getErrorMessage(error), {
        cause: error,
      });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toOperationalError(error: unknown): OperationalError {
  return error instanceof OperationalError
    ? error
    : new OperationalError(getErrorMessage(error), { cause: error });
}

/**
 * Detect if the current working directory is inside a workforest workspace.
 * Walks up the directory tree looking for .workforest metadata.
 * Returns the workspace directory path if found, null otherwise.
 */
async function detectWorkspaceFromCwd(): Promise<string | null> {
  let dir = process.cwd();

  while (dir !== path.dirname(dir)) {
    try {
      if (await hasWorkspaceMetadata(dir)) {
        return dir;
      }
    } catch {
      // Unreadable metadata, continue up
    }

    dir = path.dirname(dir);
  }
  return null;
}

function resolveWorkspaceRepoForWorktreeCommand({
  workspaceDir,
  metadata,
  repoName,
  cwd,
  allowTask,
}: {
  workspaceDir: string;
  metadata: WorkspaceMetadata;
  repoName: string | undefined;
  cwd: string;
  allowTask: boolean;
}): WorkspaceRepoMetadata {
  if (repoName) {
    const repo = metadata.repos.find(
      (candidate) => candidate.name === repoName,
    );
    if (!repo) {
      throw new Error(`Workspace does not contain repository "${repoName}".`);
    }
    return repo;
  }

  const resolvedRepoName = resolveWorkspaceRepoNameFromCwd({
    workspaceDir,
    metadata,
    cwd,
    allowTask,
  });

  if (!resolvedRepoName) {
    throw new Error(
      "Run this command from inside a workspace repo, or pass --repo <repoName>.",
    );
  }

  const repo = metadata.repos.find(
    (candidate) => candidate.name === resolvedRepoName,
  );
  if (!repo) {
    throw new Error(
      `Workspace does not contain repository "${resolvedRepoName}".`,
    );
  }
  return repo;
}

function resolveWorkspaceRepoNameFromCwd({
  workspaceDir,
  metadata,
  cwd,
  allowTask,
}: {
  workspaceDir: string;
  metadata: WorkspaceMetadata;
  cwd: string;
  allowTask: boolean;
}): string | undefined {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedCwd = path.resolve(cwd);

  for (const repo of metadata.repos) {
    const repoDir = resolveContainedPath(resolvedWorkspaceDir, repo.name);
    if (isPathInsideOrEqual(repoDir, resolvedCwd)) {
      return repo.name;
    }
  }

  if (
    metadata.workspace.type === "review" &&
    metadata.repos.length === 1 &&
    isPathInsideOrEqual(resolvedWorkspaceDir, resolvedCwd)
  ) {
    return metadata.repos[0]?.name;
  }

  if (allowTask) {
    for (const entry of metadata.tasks ?? []) {
      const worktreeDir = resolveContainedPath(
        resolvedWorkspaceDir,
        entry.path,
      );
      if (isPathInsideOrEqual(worktreeDir, resolvedCwd)) {
        return entry.parent_repo;
      }
    }
  }

  return undefined;
}

function showDryRunReport({
  fields = [],
  sections = [],
}: {
  fields?: ReportField[];
  sections?: ReportSection[];
}): void {
  printReport({
    title: "Dry run preview",
    sections: [...(fields.length > 0 ? [{ fields }] : []), ...sections],
    footer: "No changes made",
  });
}
