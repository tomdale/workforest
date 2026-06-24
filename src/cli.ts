import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  humanOutput,
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
import {
  commandHelp,
  conceptsPage,
  help,
  nestedCommandHelp,
  renderHelp,
  workflowPage,
} from "./help.ts";
import { log } from "./logger.ts";
import { RegisteredRepositoryNameCollisionError } from "./repositories.ts";
import {
  qualifyRepositorySpecifiers,
  qualifyTemplateRepositories,
  resolveRepositoryOrTemplateSpecifiers,
  resolveRepositorySpecifiers,
} from "./repository-specifiers.ts";
import type { ServiceEventSink } from "./services/events.ts";
import {
  isShellAutoCdEnabled,
  normalizeShellName,
  renderShellInit,
  resolveCleanupCdTarget,
  writeShellCdPath,
} from "./shell.ts";
import {
  createTemplate,
  deleteTemplate,
  getTemplatesDir,
  listTemplates,
  loadTemplate,
  validateTemplateName,
} from "./templates/index.ts";
import {
  printReport,
  type ReportField,
  type ReportSection,
  renderReport,
} from "./terminal/report.ts";
import type {
  RepoConfig,
  WorkspaceConfig,
  WorkspaceMetadata,
  WorkspaceRepoMetadata,
} from "./types.ts";
import {
  CancelError,
  cancel,
  intro,
  isInteractive,
  note,
  outro,
  promptConfirm,
  promptFuzzySelect,
  promptLog,
  promptSelect,
  promptText,
  withSpinner,
} from "./ui/prompts/index.ts";
import {
  buildBranchName,
  inferBranchPrefix,
  resolveBranchPrefix,
} from "./utils/branch-prefix.ts";
import { pathExists } from "./utils/fs.ts";
import {
  resolveContainedPath,
  validateResourceName,
} from "./utils/path-safety.ts";
import { generateSlugFromDescription, isSlug } from "./utils/slug.ts";
import {
  type CleanupPreview,
  type CleanupState,
  cleanupWorkspace,
  previewCleanup,
  validateWorkspace,
} from "./workspace/cleanup.ts";
import { stampWorkspace } from "./workspace/index.ts";
import {
  getMetadataPath,
  hasWorkspaceMetadata,
  readWorkspaceMetadata,
} from "./workspace/metadata.ts";

export { log };

type TemplateAddFileEntry = {
  sourcePath: string;
  targetPath: string;
  relativePath: string;
  type: "directory" | "file";
};

type TemplateAddFileConflictAction = "overwrite" | "diff" | "skip" | "cancel";

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

async function runInvocation(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  switch (invocation.command.leaf.handler) {
    case "review.open":
    case "review.checkout":
      return runReviewInvocation(invocation);
    case "workspace.create":
      return runTypedCommand(() => runWorkspaceCreateCommand(invocation));
    case "workspace.status":
      return runTypedCommand(() => runStatusCommand(invocation));
    case "workspace.delete":
    case "clean":
      return runTypedCommand(() => runCleanCommand(invocation));
    case "workspace.open":
      return runTypedCommand(() => runWorkspaceOpenCommand(invocation));
    case "workspace.add":
      return runTypedCommand(() => runAddCommand(invocation));
    case "workspace.list":
      return runTypedCommand(runListCommand);
    case "change.list":
      return runTypedCommand(() => runChangeListCommand(invocation));
    case "change.status":
      return runTypedCommand(() => runChangeStatusCommand(invocation));
    case "shell.init":
      return runShellInitCommand(invocation.beforeDoubleDash[0]);
    case "config.show":
      return runConfigShow();
    case "config.init":
      return runConfigInit();
    case "config.edit":
      return runConfigEdit();
    case "skills.list":
    case "skills.get":
    case "skills.path": {
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
            all: invocation.flags["all"] === true,
            full: invocation.flags["full"] === true,
            json: invocation.flags["json"] === true,
          });
        case "skills.path":
          return runSkillsCommand({
            command: "path",
            name: invocation.beforeDoubleDash[0],
            json: invocation.flags["json"] === true,
          });
      }
      throw new Error(
        `Unsupported skills handler: ${invocation.command.leaf.handler}`,
      );
    }
    case "help":
      return success({
        kind: "text",
        value: await help(),
        stream: "stdout",
      });
    case "help.concepts":
      return success({
        kind: "text",
        value: conceptsPage(),
        stream: "stdout",
      });
    case "help.workflow":
      return success({
        kind: "text",
        value: workflowPage(),
        stream: "stdout",
      });
    case "version":
      return runVersionCommand();
  }

  if (invocation.command.leaf.handler.startsWith("template.")) {
    return runTemplateInvocation(invocation);
  }

  if (invocation.command.leaf.handler.startsWith("cache.")) {
    const { runCacheInvocation } = await import("./repository-cli.ts");
    return runCacheInvocation(invocation);
  }

  if (invocation.command.leaf.handler.startsWith("worktree.")) {
    return runWorktreeInvocation(invocation);
  }

  if (invocation.command.leaf.handler.startsWith("task.")) {
    return runTaskInvocation(invocation);
  }

  throw new Error(
    `No CLI handler registered for ${invocation.command.leaf.handler}.`,
  );
}

async function runWorktreeInvocation(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  try {
    switch (invocation.command.leaf.handler) {
      case "worktree.create":
        return await runWorktreeCreateInvocation(invocation);
      case "worktree.list":
        return await runWorktreeListInvocation(invocation);
      case "worktree.delete":
        return await runWorktreeDeleteInvocation(invocation);
      default:
        throw new Error(
          `No worktree handler registered for ${invocation.command.leaf.handler}.`,
        );
    }
  } catch (error) {
    throw operationalError(error);
  }
}

async function runTaskInvocation(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  try {
    switch (invocation.command.leaf.handler) {
      case "task.create":
        return await runTaskCreateInvocation(invocation);
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

function commandFailure(error?: unknown): CommandResult {
  return failure(
    1,
    error === undefined
      ? { kind: "none" }
      : humanOutput(getErrorMessage(error), { stream: "stderr" }),
  );
}

function requestsJsonOutput(argv: readonly string[]): boolean {
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

async function runPrivateWorkerIfRequested(): Promise<CommandResult | null> {
  const worker = process.env["WORKFOREST_WORKER"];
  if (!worker) return null;
  if (worker !== "repo-initializer") {
    throw new OperationalError(`Unknown Workforest worker: ${worker}`);
  }

  const workspaceDir = process.env["WORKFOREST_WORKER_WORKSPACE"];
  const repoName = process.env["WORKFOREST_WORKER_REPO"];
  const runId = process.env["WORKFOREST_WORKER_RUN_ID"];
  if (!workspaceDir || !repoName || !runId) {
    throw new OperationalError(
      "Repository initialization worker requires WORKFOREST_WORKER_WORKSPACE, WORKFOREST_WORKER_REPO, and WORKFOREST_WORKER_RUN_ID.",
    );
  }

  const { runRepoInitializationWorker } = await import(
    "./workspace/initialization.ts"
  );
  try {
    await runRepoInitializationWorker({ workspaceDir, repoName, runId });
    return success();
  } catch (error) {
    throw new OperationalError(getErrorMessage(error), { cause: error });
  }
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

async function runStatusCommand(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  const workspaceFlag = stringInvocationFlag(invocation, "workspace");
  const workspaceDir = workspaceFlag
    ? path.resolve(expandHome(workspaceFlag))
    : await detectWorkspaceFromCwd();
  if (!workspaceDir) {
    throw new OperationalError(
      "Run wf workspace status from inside a workforest workspace.",
    );
  }

  const {
    cancelRepoInitializations,
    finalizeWorkspaceInitialization,
    readRepoInitializationStates,
    readWorkspaceInitializationState,
    retryRepoInitializations,
  } = await import("./workspace/initialization.ts");
  const states = await readRepoInitializationStates(workspaceDir);
  if (states.length === 0) {
    return booleanInvocationFlag(invocation, "json")
      ? jsonSuccess({ workspace: null, repos: [] })
      : success(
          humanOutput(
            "This workspace has no recorded background initialization.",
          ),
        );
  }
  await finalizeWorkspaceInitialization(workspaceDir);

  if (invocation.command.leaf.handler === "status.cancel") {
    const requested = invocation.beforeDoubleDash;
    const repoNames =
      requested.length > 0
        ? requested
        : states
            .filter(
              (state) =>
                state.status === "queued" || state.status === "running",
            )
            .map((state) => state.repo);
    if (repoNames.length === 0) {
      log.info("No running repository initializers to cancel.");
      return success();
    }
    try {
      const cancelled = await cancelRepoInitializations(
        workspaceDir,
        repoNames,
      );
      for (const state of cancelled) {
        log.success(`${state.repo}: initialization cancelled`);
      }
    } catch (error) {
      throw new OperationalError(getErrorMessage(error), { cause: error });
    }
    return success();
  }

  if (invocation.command.leaf.handler === "status.retry") {
    const requested = invocation.beforeDoubleDash;
    const repoNames =
      requested.length > 0
        ? requested
        : states
            .filter(
              (state) =>
                state.status === "failed" || state.status === "cancelled",
            )
            .map((state) => state.repo);
    if (repoNames.length === 0) {
      log.info("No failed or cancelled repository initializers to retry.");
      return success();
    }
    try {
      const retried = await retryRepoInitializations(workspaceDir, repoNames);
      for (const state of retried) {
        log.success(
          `${state.repo}: initialization retry started (attempt ${state.attempt})`,
        );
      }
    } catch (error) {
      throw new OperationalError(getErrorMessage(error), { cause: error });
    }
    return success();
  }

  const workspaceState = await readWorkspaceInitializationState(workspaceDir);
  if (booleanInvocationFlag(invocation, "json")) {
    return jsonSuccess({
      workspace: workspaceState,
      repos: states,
    });
  }

  const { shouldUseGrid } = await import("./ui/grid-consumer.ts");
  if (isInteractive() && shouldUseGrid(states.length)) {
    const { renderInitializationStatus } = await import(
      "./ui/initialization-status.ts"
    );
    await renderInitializationStatus(
      workspaceDir,
      states.map((state) => state.repo),
    );
    return success();
  }

  return success(
    reportOutput(
      renderReport({
        title: "Repository initialization",
        sections: [
          {
            fields: [
              {
                label: "Workspace",
                value: workspaceState?.status ?? "unknown",
              },
              ...(workspaceState?.message
                ? [{ label: "Summary", value: workspaceState.message }]
                : []),
              ...(workspaceState?.error
                ? [{ label: "Error", value: workspaceState.error }]
                : []),
              ...(workspaceState?.current_hook
                ? [{ label: "Hook", value: workspaceState.current_hook }]
                : []),
              ...(workspaceState?.warnings?.length
                ? [
                    {
                      label: "Warnings",
                      value: workspaceState.warnings.join("\n"),
                    },
                  ]
                : []),
            ],
          },
          {
            entries: states.map((state) => ({
              title: state.repo,
              description: state.status,
              details: [
                ...(state.step ? [{ label: "Step", value: state.step }] : []),
                ...(state.message
                  ? [{ label: "Message", value: state.message }]
                  : []),
                { label: "Attempt", value: String(state.attempt) },
              ],
            })),
          },
        ],
        footer: `Workspace: ${workspaceDir}`,
      }),
    ),
  );
}

async function runShellInitCommand(
  requestedShell: string | undefined,
): Promise<CommandResult> {
  requestedShell ??= process.env["SHELL"];
  const shell = normalizeShellName(requestedShell);

  if (!shell) {
    throw new UsageError(
      "Unsupported shell. Use 'wf shell init zsh' or 'wf shell init bash'.",
    );
  }

  return success(shellOutput(renderShellInit(shell)));
}

async function runConfigInit(): Promise<CommandResult> {
  if (!isInteractive()) {
    throw new OperationalError(
      "Config init requires an interactive terminal.\nUse 'wf config edit' to edit the config file directly.",
    );
  }

  const { path: configPath, config } = await loadWorkspaceConfigForCommand();

  intro("Configure workforest");

  // Default directory
  const currentDefaultDir = config.defaultDir ?? "";
  const defaultDir = await promptText(
    "Default workspace directory (where workspaces are created)",
    { defaultValue: currentDefaultDir || "~/Code/workspaces" },
  );

  // Reviews directory
  const currentReviewsDir = config.reviewsDir ?? "";
  const reviewsDir = await promptText(
    "Reviews directory (where PR review worktrees are created)",
    { defaultValue: currentReviewsDir || deriveDefaultReviewsDir(defaultDir) },
  );

  // Directory prefix
  const currentDirPrefix = config.dirPrefix ?? "";
  const dirPrefix = await promptText(
    'Directory prefix (e.g., "wf-" for wf-feature-name)',
    { defaultValue: currentDirPrefix },
  );

  // Branch prefix
  const currentBranchPrefix = config.branchPrefix ?? "";
  const branchPrefix = await promptText(
    'Branch prefix (e.g., "feature/" for feature/name)',
    { defaultValue: currentBranchPrefix },
  );

  const newConfig: WorkspaceConfig = {
    ...(config.vercelLink ? { vercelLink: config.vercelLink } : {}),
    ...(defaultDir ? { defaultDir } : {}),
    ...(reviewsDir ? { reviewsDir } : {}),
    ...(dirPrefix ? { dirPrefix } : {}),
    ...(branchPrefix ? { branchPrefix } : {}),
  };

  note(
    [
      `Default directory: ${defaultDir || "(not set)"}`,
      `Reviews directory: ${reviewsDir || "(not set)"}`,
      `Directory prefix: "${dirPrefix}"`,
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

async function runConfigShow(): Promise<CommandResult> {
  const { path: configPath, config } = await loadWorkspaceConfigForCommand();

  const ownerMappings = Object.entries(
    config.vercelLink?.teamByGitHubOwner ?? {},
  );
  const repoOverrides = Object.entries(config.vercelLink?.repoOverrides ?? {});

  printReport({
    title: "Workspace configuration",
    sections: [
      {
        fields: [
          {
            label: "Default directory",
            value:
              config.defaultDir ??
              "(not set; required for workspaces and default worktree paths)",
          },
          {
            label: "Reviews directory",
            value: config.reviewsDir ?? "(not set; prompts on first review)",
          },
          {
            label: "Directory prefix",
            value: `"${config.dirPrefix ?? ""}"`,
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
          { label: "Default directory", value: "~/Code/workspaces" },
          { label: "Reviews directory", value: "~/Code/reviews" },
          {
            label: "Directory prefix",
            value: '"wf-" creates wf-my-feature',
          },
          {
            label: "Branch prefix",
            value: '"tom/" creates tom/my-feature',
          },
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

async function runVersionCommand(): Promise<CommandResult> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = path.join(__dirname, "..", "package.json");
  const packageJson = JSON.parse(
    await fs.readFile(packageJsonPath, "utf8"),
  ) as { version: string };
  return success({
    kind: "text",
    value: `workforest ${packageJson.version}`,
    stream: "stdout",
  });
}

async function runListCommand(): Promise<CommandResult> {
  const { config } = await loadWorkspaceConfig();

  if (!config.defaultDir) {
    log.error(
      "No defaultDir configured. Set it in your config to list workspaces.",
    );
    log.info("Run: wf config edit");
    return commandFailure();
  }

  const workspaceRoot = path.resolve(expandHome(config.defaultDir));

  // Check if directory exists
  let entries: string[];
  try {
    entries = await fs.readdir(workspaceRoot);
  } catch {
    return commandFailure(`Directory not found: ${workspaceRoot}`);
  }

  // Find workspaces (directories with .workforest metadata)
  const workspaces: Array<{
    name: string;
    path: string;
    description?: string;
    template?: string;
    created?: string;
    branch?: string;
    repos: number;
  }> = [];

  for (const entry of entries) {
    const entryPath = path.join(workspaceRoot, entry);
    const stat = await fs.stat(entryPath);
    if (!stat.isDirectory()) continue;

    try {
      const metadata = await readWorkspaceMetadata(entryPath);
      if (metadata) {
        workspaces.push({
          name: entry,
          path: entryPath,
          created: metadata.workspace.created_at,
          repos: metadata.repos.length,
          ...(metadata.workspace.description
            ? { description: metadata.workspace.description }
            : {}),
          ...(metadata.workspace.template_id
            ? { template: metadata.workspace.template_id }
            : {}),
          ...(metadata.repos[0]?.feature_branch
            ? { branch: metadata.repos[0].feature_branch }
            : {}),
        });
      }
    } catch {
      // Skip workspaces with unreadable metadata (e.g., legacy TOML format)
    }
  }

  if (workspaces.length === 0) {
    log.info(`No workspaces found in ${workspaceRoot}`);
    return success();
  }

  printReport({
    title: "Workspaces",
    sections: [
      {
        entries: workspaces.map((workspace) => ({
          title: workspace.name,
          ...(workspace.description
            ? { description: workspace.description }
            : {}),
          details: [
            {
              label: "Repositories",
              value: String(workspace.repos),
            },
            ...(workspace.template
              ? [{ label: "Template", value: workspace.template }]
              : []),
            ...(workspace.branch
              ? [{ label: "Branch", value: workspace.branch }]
              : []),
            {
              label: "Created",
              value: workspace.created
                ? new Date(workspace.created).toLocaleDateString()
                : "unknown",
            },
          ],
        })),
      },
    ],
    footer: [
      `Directory: ${workspaceRoot}`,
      `${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}`,
    ].join("\n"),
  });
  return success();
}

async function runChangeListCommand(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  const { config } = await loadWorkspaceConfig();
  const { collectChangeInventory, renderChangeList } = await import(
    "./workspace/change-inventory.ts"
  );
  const repoFilter = stringInvocationFlag(invocation, "repo");
  const groupFilter = stringInvocationFlag(invocation, "group");
  const inventory = await collectChangeInventory(config, {
    ...(repoFilter ? { repo: repoFilter } : {}),
    ...(groupFilter ? { group: groupFilter } : {}),
  });

  return booleanInvocationFlag(invocation, "json")
    ? jsonSuccess(inventory)
    : success(
        reportOutput(
          renderChangeList(inventory, {
            paths: booleanInvocationFlag(invocation, "paths"),
          }),
        ),
      );
}

async function runChangeStatusCommand(
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
  const { resolveChangeSelector } = await import("./workspace/selectors.ts");
  const resolution = await resolveChangeSelector(config, selector);

  if (resolution.kind === "outside") {
    throw new OperationalError(
      [
        "Not in a Workforest change.",
        "Run: wf list",
        "Or start explicitly: wf start <change> <repo|@template>",
      ].join("\n"),
    );
  }
  if (resolution.kind === "missing") {
    throw new UsageError(`Unknown change selector: ${resolution.selector}`);
  }
  if (resolution.kind === "ambiguous") {
    throw new UsageError(
      [
        `Ambiguous change selector "${resolution.selector}".`,
        "Matches:",
        ...resolution.matches.map((match) => `  ${match}`),
        "Use <group>/<change>.",
      ].join("\n"),
    );
  }

  const { buildChangeStatus, renderChangeStatus } = await import(
    "./workspace/status.ts"
  );
  const status = await buildChangeStatus(resolution.entry);

  if (booleanInvocationFlag(invocation, "watch")) {
    if (!status.initialization || status.initialization.repos.length === 0) {
      return success(
        reportOutput(
          renderChangeStatus(status, {
            note: "No initialization is recorded for this change; showing the static report.",
          }),
        ),
      );
    }

    if (!isInteractive()) {
      return success(
        reportOutput(
          renderChangeStatus(status, {
            note: "Initialization watcher requires an interactive terminal; showing the static report.",
          }),
        ),
      );
    }

    const { renderInitializationStatus } = await import(
      "./ui/initialization-status.ts"
    );
    await renderInitializationStatus(
      resolution.entry.path,
      status.initialization.repos.map((state) => state.repo),
    );
    return success();
  }

  return booleanInvocationFlag(invocation, "json")
    ? jsonSuccess(status)
    : success(reportOutput(renderChangeStatus(status)));
}

async function runWorktreeCreateInvocation(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  return runStandaloneWorktreeCreate({
    operands: [...invocation.beforeDoubleDash],
    dir: stringFlag(invocation, "dir"),
    dryRun: booleanFlag(invocation, "dryRun"),
  });
}

async function runWorktreeListInvocation(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  return runStandaloneWorktreeList(invocation.beforeDoubleDash[0]);
}

async function runWorktreeDeleteInvocation(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  return runStandaloneWorktreeRemove({
    target: invocation.beforeDoubleDash[0] ?? "",
    dryRun: booleanFlag(invocation, "dryRun"),
    force: booleanFlag(invocation, "force"),
  });
}

async function runTaskCreateInvocation(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  const workspaceDir = await detectWorkspaceFromCwd();
  if (!workspaceDir) {
    throw new OperationalError(
      "Run wf task create from inside a workspace. A task is a temporary worktree inside an existing workspace, and --repo selects which of the workspace's repositories to branch from — it does not name a workspace to create one in.\nFor a worktree outside a workspace, use: wf worktree create <repository> <name>",
    );
  }

  return runTaskCreate(
    {
      slugs: [...invocation.beforeDoubleDash],
      repo: stringFlag(invocation, "repo"),
      dryRun: booleanFlag(invocation, "dryRun"),
      force: booleanFlag(invocation, "force"),
    },
    workspaceDir,
  );
}

async function runTaskListInvocation(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  return runTaskList({
    repo: stringFlag(invocation, "repo"),
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
  switch (invocation.command.leaf.handler) {
    case "review.open":
      return runReviewOpen(invocation.beforeDoubleDash[0] ?? "");
    case "review.checkout":
      return runReviewCheckout(invocation.beforeDoubleDash);
    default:
      throw new Error(
        `Unsupported review handler: ${invocation.command.leaf.handler}`,
      );
  }
}

async function runReviewOpen(repoInput: string): Promise<CommandResult> {
  try {
    const [qualifiedRepo] = await qualifyReviewRepositorySpecifier([repoInput]);
    const { ensureReviewWorkspace, parseReviewRepoTarget } = await import(
      "./review.ts"
    );
    const target = parseReviewRepoTarget([qualifiedRepo ?? repoInput]);
    const reviewsDir = await resolveReviewsDir();
    const workspace = await ensureReviewWorkspace({
      target,
      reviewsDir,
      onEvent: humanServiceEventSink,
    });

    await writeShellCdPath(workspace.path);
    log.success(`Review workspace ready: ${workspace.path}`);
    if (!isShellAutoCdEnabled()) {
      log.info(`Run: cd ${workspace.path}`);
    }
    return success();
  } catch (error) {
    throw toOperationalError(error);
  }
}

async function runReviewCheckout(
  targetArgs: readonly string[],
): Promise<CommandResult> {
  try {
    const resolvedTargetArgs =
      await qualifyReviewRepositorySpecifier(targetArgs);
    const { createReviewWorktree, resolveReviewTarget } = await import(
      "./review.ts"
    );
    const context = await resolveCurrentReviewWorkspaceContext();
    const target = resolveReviewTarget(
      resolvedTargetArgs,
      context ?? undefined,
    );
    const reviewsDir = await resolveReviewsDir();
    const metadata = await createReviewWorktree({
      target,
      reviewsDir,
      onEvent: humanServiceEventSink,
    });

    await writeShellCdPath(metadata.path);
    log.success(`Review worktree ready: ${metadata.path}`);
    if (!isShellAutoCdEnabled()) {
      log.info(`Run: cd ${metadata.path}`);
    }
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
  const { path: configPath, config } = await loadWorkspaceConfig();
  if (config.reviewsDir) {
    return path.resolve(expandHome(config.reviewsDir));
  }

  const defaultValue = deriveDefaultReviewsDir(config.defaultDir);
  if (!isInteractive()) {
    throw new Error(
      `No reviewsDir configured. Run 'wf config init' or set reviewsDir in ${configPath}. Suggested value: ${defaultValue}`,
    );
  }

  const reviewsDir = await promptText("Reviews directory", {
    defaultValue,
    validate: (input) =>
      input.trim().length > 0 ? null : "Reviews directory is required",
  });
  await saveWorkspaceConfig(configPath, { ...config, reviewsDir });
  log.success(`Saved reviewsDir to ${configPath}`);
  return path.resolve(expandHome(reviewsDir));
}

function deriveDefaultReviewsDir(defaultDir: string | undefined): string {
  if (!defaultDir) {
    return "~/Code/reviews";
  }

  const expanded = expandHome(defaultDir);
  const parent = path.dirname(expanded);
  const derived = path.join(parent, "reviews");
  const home = os.homedir();
  return derived === home
    ? "~"
    : derived.startsWith(`${home}${path.sep}`)
      ? `~/${path.relative(home, derived)}`
      : derived;
}

async function runStandaloneWorktreeCreate({
  operands,
  dir,
  dryRun,
}: {
  operands: string[];
  dir: string | undefined;
  dryRun: boolean;
}): Promise<CommandResult> {
  const [repoInput, slug] = operands;
  if (!repoInput || !slug) {
    throw new UsageError(
      "wf worktree create requires a repository and worktree slug.",
    );
  }

  if (!isSlug(slug)) {
    throw new OperationalError(
      `Invalid slug "${slug}". Slugs must be lowercase words separated by hyphens.`,
    );
  }

  try {
    const repos = await resolveRepositorySpecifiers([repoInput]);
    if (repos.length !== 1) {
      throw new Error("Exactly one repository is required.");
    }

    const resolvedRepo = repos[0];
    if (!resolvedRepo) {
      throw new Error("Exactly one repository is required.");
    }

    const { config, path: configPath } = await loadWorkspaceConfig();
    const branchName = buildBranchName(slug, config.branchPrefix);
    const targetDir = dir
      ? path.resolve(expandHome(dir))
      : defaultStandaloneWorktreePath({
          config,
          configPath,
          repoName: resolvedRepo.name,
          slug,
        });

    if (dryRun) {
      showDryRunReport({
        fields: [
          { label: "Repository", value: resolvedRepo.name },
          { label: "Remote", value: resolvedRepo.remote },
          { label: "Branch", value: branchName },
          { label: "Target", value: targetDir },
        ],
      });
      return success();
    }

    const { createSingleWorktree } = await import("./worktree.ts");
    await createSingleWorktree({
      repo: resolvedRepo,
      branchName,
      targetDir,
    });
    await writeShellCdPath(targetDir);
    log.success(`Worktree ready: ${targetDir}`);
    if (!isShellAutoCdEnabled()) {
      log.info(`Run: cd ${targetDir}`);
    }
    return success();
  } catch (error) {
    throw operationalError(error);
  }
}

function defaultStandaloneWorktreePath({
  config,
  configPath,
  repoName,
  slug,
}: {
  config: WorkspaceConfig;
  configPath: string;
  repoName: string;
  slug: string;
}): string {
  if (!config.defaultDir) {
    throw new Error(
      `No defaultDir configured. Set defaultDir in ${configPath}, or pass --dir to choose a target path.`,
    );
  }

  return path.resolve(expandHome(config.defaultDir), repoName, slug);
}

async function runStandaloneWorktreeList(
  repositorySelector: string | undefined,
): Promise<CommandResult> {
  try {
    const { listCachedRepositories, resolveCachedRepository } = await import(
      "./repositories.ts"
    );
    const repositories = await listCachedRepositories();
    const selected = repositorySelector
      ? [await resolveCachedRepository(repositorySelector, repositories)]
      : repositories;
    if (repositorySelector && !selected[0]) {
      throw new Error(`Cached repository not found: ${repositorySelector}`);
    }

    const entries = selected.flatMap((repository) =>
      repository
        ? repository.worktrees.map((worktree) => ({
            repository: repository.slug ?? repository.name,
            ...worktree,
          }))
        : [],
    );
    if (entries.length === 0) {
      log.info("No standalone worktrees found.");
      return success();
    }

    printReport({
      title: "Standalone worktrees",
      sections: [
        {
          entries: entries.map((entry) => ({
            title: entry.path,
            description: entry.repository,
            details: [
              {
                label: "Branch",
                value: entry.detached
                  ? "detached"
                  : (entry.branch ?? "unknown"),
              },
              { label: "Exists", value: entry.exists ? "yes" : "no" },
              ...(entry.prunable ? [{ label: "Prunable", value: "yes" }] : []),
            ],
          })),
        },
      ],
    });
    return success();
  } catch (error) {
    throw operationalError(error);
  }
}

async function runStandaloneWorktreeRemove({
  target,
  dryRun,
  force,
  skipConfirmation = false,
}: {
  target: string;
  dryRun: boolean;
  force: boolean;
  skipConfirmation?: boolean;
}): Promise<CommandResult> {
  const targetDir = path.resolve(expandHome(target));

  try {
    const { removeStandaloneWorktree } = await import("./worktree.ts");
    if (!skipConfirmation) {
      const confirmed = await confirmDelete({
        dryRun,
        force,
        description: "standalone worktree",
        targetPath: targetDir,
      });
      if (!confirmed) return success();
    }

    const result = await removeStandaloneWorktree({
      targetDir,
      dryRun,
      force,
    });
    if (result.dryRun) {
      showDryRunReport({
        fields: [
          { label: "Worktree", value: result.path },
          ...(result.branch ? [{ label: "Branch", value: result.branch }] : []),
        ],
      });
    } else {
      log.success(`Deleted worktree: ${result.path}`);
      await writeShellCdPath(path.dirname(result.path));
    }
    return success();
  } catch (error) {
    throw operationalError(error);
  }
}

async function runTaskCreate(
  {
    slugs,
    repo,
    dryRun,
    force,
  }: {
    slugs: string[];
    repo: string | undefined;
    dryRun: boolean;
    force: boolean;
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
      ? await loadTemplate(metadata.workspace.template_id)
      : null;
    const { config: workspaceConfig } = await loadWorkspaceConfig();
    const branchPrefix = resolveBranchPrefix(
      workspaceConfig.branchPrefix,
      template?.config.branchPrefix,
    );

    const { createTasks } = await import("./workspace/tasks.ts");
    const sourceRepoDir = resolveWorktreeSourceDirFromCwd({
      workspaceDir,
      metadata,
      parentRepoName: parentRepo.name,
      cwd: process.cwd(),
    });
    const result = await createTasks({
      workspaceDir,
      parentRepo,
      ...(sourceRepoDir ? { sourceRepoDir } : {}),
      slugs,
      ...(branchPrefix !== undefined ? { branchPrefix } : {}),
      dryRun,
      force,
      ...(template?.config.disableInitializers !== undefined
        ? { disabledInitializers: template.config.disableInitializers }
        : {}),
      onEvent: humanServiceEventSink,
    });

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

    if (result.created.length === 1 && result.failures.length === 0) {
      const target = result.created[0]?.path;
      if (target) {
        await writeShellCdPath(target);
        if (!isShellAutoCdEnabled()) {
          log.info(`Run: cd ${target}`);
        }
      }
    }

    if (
      result.failures.length > 0 ||
      result.created.some((w) => w.setupStatus === "failed")
    ) {
      return failure(1, { kind: "none" });
    }
    return success();
  } catch (error) {
    throw operationalError(error);
  }
}

async function runTaskList({
  repo,
}: {
  repo?: string | undefined;
}): Promise<CommandResult> {
  const workspaceDir = await detectWorkspaceFromCwd();
  if (!workspaceDir) {
    throw new OperationalError("Not inside a workspace.");
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

    if (entries.length === 0) {
      log.info("No tasks found.");
      return success();
    }

    printReport({
      title: "Tasks",
      sections: [
        {
          entries: entries.map((entry) => ({
            title: entry.slug,
            details: [
              { label: "Repository", value: entry.parent_repo },
              { label: "Branch", value: entry.branch },
              { label: "Status", value: entry.state },
              {
                label: "Merged",
                value:
                  entry.merged === null
                    ? "unknown"
                    : entry.merged
                      ? "yes"
                      : "no",
              },
              { label: "Path", value: entry.absolutePath },
            ],
          })),
        },
      ],
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

async function runTaskDelete({
  names,
  repo,
  dryRun,
  force,
  skipConfirmation = false,
}: {
  names: string[];
  repo?: string | undefined;
  dryRun: boolean;
  force: boolean;
  skipConfirmation?: boolean;
}): Promise<CommandResult> {
  const workspaceDir = await detectWorkspaceFromCwd();
  if (!workspaceDir) {
    throw new OperationalError("Not inside a workspace.");
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
    if (!skipConfirmation) {
      const confirmed = await confirmDelete({
        dryRun,
        force,
        description:
          names.length === 1 ? `task "${names[0]}"` : `${names.length} tasks`,
        targetPath: workspaceDir,
      });
      if (!confirmed) return success();
    }

    const result = await deleteTasks({
      workspaceDir,
      slugs: names,
      dryRun,
      force,
      ...(parentRepoName ? { parentRepoName } : {}),
    });

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
    }
    return success();
  } catch (error) {
    throw operationalError(error);
  }
}

async function runWorkspaceOpenCommand(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  const interactive = isInteractive();
  let workspaceDir: string | null = null;

  try {
    const workspaceName = invocation.beforeDoubleDash[0];
    if (booleanInvocationFlag(invocation, "search")) {
      if (!interactive) {
        throw new OperationalError(
          "wf workspace open --search requires an interactive terminal.",
        );
      }
      const selected = await selectWorkspaceFuzzy("Find workspace");
      if (selected === undefined) {
        return commandFailure();
      }
      if (selected === null) {
        cancel("Cancelled");
        return success();
      }
      workspaceDir = selected;
    } else if (workspaceName) {
      workspaceDir = await resolveWorkspaceByName(workspaceName);
      if (!workspaceDir) {
        return commandFailure();
      }
    } else if (interactive) {
      workspaceDir = await selectWorkspaceInteractive(
        "Select workspace to open",
      );
      if (!workspaceDir) {
        cancel("Cancelled");
        return success();
      }
    } else {
      throw new UsageError(
        "Missing workspace name. Usage: wf workspace open <name>",
      );
    }

    await writeShellCdPath(workspaceDir);

    if (!isShellAutoCdEnabled()) {
      const message = `Run: cd ${workspaceDir}`;
      if (interactive) {
        promptLog.info(message);
      } else {
        log.info(message);
      }
    }
    return success();
  } catch (error) {
    if (error instanceof UsageError) {
      throw error;
    }
    return commandFailure(error);
  }
}

async function runTemplateInvocation(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  switch (invocation.command.leaf.handler) {
    case "template.manage":
      return runTemplateManagerCommand();
    case "template.list":
      return runTemplateList();
    case "template.open":
      return runTemplateOpen(invocation.beforeDoubleDash[0] ?? "");
    case "template.show":
      return runTemplateShow(invocation.beforeDoubleDash[0] ?? "");
    case "template.new":
      return runTemplateNew(invocation);
    case "template.edit":
      return runTemplateEdit(invocation.beforeDoubleDash[0] ?? "");
    case "template.add-file":
      return runTemplateAddFile(invocation);
    case "template.copy":
      return runTemplateCopy(
        invocation.beforeDoubleDash[0] ?? "",
        invocation.beforeDoubleDash[1] ?? "",
      );
    case "template.delete":
      return runTemplateDelete(
        invocation.beforeDoubleDash[0] ?? "",
        invocation.flags["force"] === true,
      );
    default:
      throw new Error(
        `No template handler registered for ${invocation.command.leaf.handler}.`,
      );
  }
}

function templateSuccess(): CommandResult {
  return success();
}

function templateFailure(): CommandResult {
  return failure(1, { kind: "none" });
}

async function runTemplateManagerCommand(): Promise<CommandResult> {
  const { shouldUseTemplateManager } = await import("./ui/template-manager.ts");

  if (!shouldUseTemplateManager()) {
    return runTemplateList();
  }

  let initialTemplateId: string | undefined;

  while (true) {
    const templates = await listTemplates();
    let workspaceConfig: WorkspaceConfig | undefined;
    try {
      ({ config: workspaceConfig } = await loadWorkspaceConfig());
    } catch {
      workspaceConfig = undefined;
    }

    const { runTemplateManager } = await import("./ui/template-manager.ts");
    const action = await runTemplateManager({
      templates,
      templatesDir: getTemplatesDir(),
      ...(workspaceConfig ? { workspaceConfig } : {}),
      ...(initialTemplateId ? { initialTemplateId } : {}),
    });

    switch (action.type) {
      case "quit":
        return templateSuccess();
      case "reload":
        continue;
      case "create": {
        const templateId = await wizardCreateTemplate();
        initialTemplateId = templateId ?? initialTemplateId;
        if (templateId) {
          promptLog.success(`Template "${templateId}" saved.`);
        }
        continue;
      }
      case "edit": {
        initialTemplateId = action.templateId;
        const templateId = await wizardEditTemplateById(action.templateId);
        if (templateId) {
          promptLog.success(`Template "${templateId}" saved.`);
        }
        continue;
      }
      case "copy": {
        initialTemplateId =
          (await wizardCloneTemplateById(action.templateId)) ??
          action.templateId;
        continue;
      }
      case "delete":
        initialTemplateId = undefined;
        if (
          (await runTemplateDelete(action.templateId, false)).exitCode !== 0
        ) {
          return templateFailure();
        }
        continue;
      case "show":
        return runTemplateOpen(action.templateId);
    }
  }
}

async function runTemplateList(): Promise<CommandResult> {
  const templates = await listTemplates();

  if (templates.length === 0) {
    log.info("No templates configured.");
    log.info(`Templates directory: ${getTemplatesDir()}`);
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

async function runTemplateOpen(templateId: string): Promise<CommandResult> {
  const template = await loadTemplate(templateId);
  if (!template) {
    log.error(`Template "${templateId}" not found.`);
    const templates = await listTemplates();
    if (templates.length > 0) {
      log.info(`Available: ${templates.map((t) => t.id).join(", ")}`);
    }
    return templateFailure();
  }

  const templateDir = path.dirname(template.path);
  await writeShellCdPath(templateDir);

  if (!isShellAutoCdEnabled()) {
    log.info(`Run: cd ${templateDir}`);
  }
  return templateSuccess();
}

async function runTemplateShow(templateId: string): Promise<CommandResult> {
  const template = await loadTemplate(templateId);
  if (!template) {
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

  printReport({
    title: `Template ${template.id}`,
    sections: [
      {
        fields: [
          ...(template.config.description
            ? [{ label: "Description", value: template.config.description }]
            : []),
          { label: "Branch prefix", value: branchPrefixSummary },
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
    ],
    footer: `Config: ${template.path}`,
  });
  return templateSuccess();
}

async function runTemplateNew(
  invocation: ParsedInvocation,
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

  log.success(`Template "${templateId}" created.`);
  log.info(`Location: ${getTemplatesDir()}/${templateId}/template.jsonc`);
  return templateSuccess();
}

async function runTemplateDelete(
  templateId: string,
  force: boolean,
): Promise<CommandResult> {
  const template = await loadTemplate(templateId);
  if (!template) {
    log.error(`Template "${templateId}" not found.`);
    return templateFailure();
  }

  // Confirm deletion unless --force is passed
  if (!force) {
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
  log.success(`Template "${templateId}" deleted.`);
  return templateSuccess();
}

async function runTemplateEdit(templateId: string): Promise<CommandResult> {
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
      await createTemplate(
        templateId,
        await qualifyTemplateRepositories(config),
      );
      log.success(`Template "${templateId}" saved.`);
    },
  });
  return templateSuccess();
}

async function runTemplateAddFile(
  invocation: ParsedInvocation,
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
      log.error("Usage: workforest template add-file <template> <path...>");
      return templateFailure();
    }
  }

  const sourceRoot = workspaceDir ?? process.cwd();

  if (!templateId) {
    if (!workspaceDir) {
      log.error("Not inside a workspace.");
      return templateFailure();
    }

    const firstInput = sourceInputs[0];
    if (!firstInput) {
      log.error(
        "Usage: workforest template add-file [--template <name>] <path...>",
      );
      return templateFailure();
    }

    let candidateTemplate: Awaited<ReturnType<typeof loadTemplate>> = null;
    try {
      validateTemplateName(firstInput);
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
        log.error("Usage: workforest template add-file <template> <path...>");
        return templateFailure();
      }
    } else if (!candidateExists) {
      log.error(
        `Could not resolve add-file argument "${firstInput}" as either a template or an existing file or directory.`,
      );
      return templateFailure();
    }
  }

  if (!templateId) {
    if (!workspaceDir) {
      log.error("Not inside a workspace.");
      return templateFailure();
    }

    let metadata: WorkspaceMetadata | null;
    try {
      metadata = await readWorkspaceMetadata(workspaceDir);
    } catch (error) {
      log.error(getErrorMessage(error));
      return templateFailure();
    }

    if (!metadata?.workspace.template_id) {
      log.error("Current workspace was not created from a template.");
      return templateFailure();
    }

    templateId = metadata.workspace.template_id;
  }

  const template = resolvedTemplate ?? (await loadTemplate(templateId));
  if (!template) {
    log.error(`Template "${templateId}" not found.`);
    return templateFailure();
  }

  const entries: TemplateAddFileEntry[] = [];
  for (const sourceInput of sourceInputs) {
    const resolved = await resolveTemplateAddFileEntries({
      sourceInput,
      sourceRoot,
      templatePath: template.path,
    });
    if (!resolved) {
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
          log.error(`Template path already exists: ${entry.targetPath}`);
          return templateFailure();
        }
      }
      continue;
    }

    if (await pathExists(entry.targetPath)) {
      const targetStat = await fs.stat(entry.targetPath);
      if (!targetStat.isFile()) {
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
  log.success(`Added ${sourceSummary} to template "${template.id}".${suffix}`);
  return templateSuccess();
}

async function resolveTemplateAddFileEntries({
  sourceInput,
  sourceRoot,
  templatePath,
}: {
  sourceInput: string;
  sourceRoot: string;
  templatePath: string;
}): Promise<TemplateAddFileEntry[] | null> {
  const sourcePath = path.resolve(sourceInput);
  const relativePath = path.relative(sourceRoot, sourcePath);

  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    log.error(`File must be inside ${sourceRoot}: ${sourcePath}`);
    return null;
  }

  let sourceStat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    sourceStat = await fs.stat(sourcePath);
  } catch {
    log.error(`File not found: ${sourcePath}`);
    return null;
  }

  if (!sourceStat.isFile() && !sourceStat.isDirectory()) {
    log.error(`Not a file or directory: ${sourcePath}`);
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
): Promise<Exclude<TemplateAddFileConflictAction, "diff">> {
  if (!isInteractive()) {
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
): Promise<CommandResult> {
  // Load source template
  const sourceTemplate = await loadTemplate(sourceId);
  if (!sourceTemplate) {
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
    log.error(`Template "${destId}" already exists.`);
    return templateFailure();
  }

  // Create the copy
  await createTemplate(destId, sourceTemplate.config);
  log.success(`Template "${sourceId}" copied to "${destId}".`);
  return templateSuccess();
}

async function runCleanCommand(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  const interactive = isInteractive();
  const initialCwd = process.cwd();
  const workspaceOperand = invocation.beforeDoubleDash[0];
  if (!workspaceOperand) {
    throw new UsageError("wf workspace delete requires a workspace.");
  }
  const directPath = path.resolve(expandHome(workspaceOperand));
  const workspaceDir = (await hasWorkspaceMetadata(directPath))
    ? directPath
    : ((await resolveWorkspaceByName(workspaceOperand)) ?? directPath);
  const isInsideWorkspace = isPathInsideOrEqual(initialCwd, workspaceDir);

  const dryRun = booleanInvocationFlag(invocation, "dryRun");
  const force = booleanInvocationFlag(invocation, "force");
  const keepMirrors = !booleanInvocationFlag(invocation, "deleteMirrors");
  let deleteRemoteBranches = booleanInvocationFlag(
    invocation,
    "deleteRemoteBranches",
  );

  // Validate workspace first
  try {
    await validateWorkspace(workspaceDir);
  } catch (error) {
    return commandFailure(error);
  }

  // Get preview with remote branch check (always check to potentially prompt)
  const preview = await previewCleanup(workspaceDir, {
    checkRemoteBranches: true,
  });

  // Show preview
  if (interactive) {
    showCleanupPreview(preview);

    if (isInsideWorkspace) {
      promptLog.warn("You are inside the workspace being deleted");
    }
  } else {
    printReport({
      title: "Cleanup preview",
      sections: [
        {
          fields: [
            { label: "Directory", value: preview.workspaceDir },
            { label: "Repositories", value: preview.repos.join(", ") },
            ...(preview.tasks?.length
              ? [
                  {
                    label: "Tasks",
                    value: preview.tasks.join(", "),
                  },
                ]
              : []),
          ],
        },
      ],
    });
    if (isInsideWorkspace) {
      log.warn("You are inside the workspace being deleted");
    }
  }

  // Confirm unless --force or --dry-run
  if (!force && !dryRun) {
    const confirmed = await confirmDelete({
      dryRun,
      force,
      description: "workspace",
      targetPath: preview.workspaceDir,
    });
    if (!confirmed) return success();
  }

  if (!force && !dryRun && preview.remoteBranches?.length) {
    const branchCount = preview.remoteBranches.length;
    const branchList = preview.remoteBranches
      .map((b) => `${b.repo}: ${b.branch}`)
      .join(", ");

    if (deleteRemoteBranches) {
      deleteRemoteBranches = await confirmDelete({
        dryRun,
        force,
        description: `${branchCount} merged remote branch${branchCount !== 1 ? "es" : ""} (${branchList})`,
      });
    } else {
      deleteRemoteBranches = await promptConfirm(
        `Delete ${branchCount} merged remote branch${branchCount !== 1 ? "es" : ""} (${branchList})?`,
        false,
      );
    }
  }

  await cleanupWorkspace(workspaceDir, {
    dryRun,
    force,
    keepMirrors,
    deleteRemoteBranches,
    onState: (state) => renderCleanupState(state, dryRun),
  });

  // Post-cleanup message if user was inside the workspace
  if (isInsideWorkspace && !dryRun) {
    const parentDir =
      resolveCleanupCdTarget(initialCwd, workspaceDir) ??
      path.dirname(path.resolve(workspaceDir));
    await writeShellCdPath(parentDir);
    if (!isShellAutoCdEnabled() && interactive) {
      promptLog.info(`Workspace deleted. Run: cd ${parentDir}`);
    } else if (!isShellAutoCdEnabled()) {
      log.info(`Workspace deleted. Run: cd ${parentDir}`);
    }
  }
  return success();
}

async function confirmDelete({
  dryRun,
  force,
  description,
  targetPath,
}: {
  dryRun: boolean;
  force: boolean;
  description: string;
  targetPath?: string;
}): Promise<boolean> {
  if (dryRun || force) {
    return true;
  }

  if (!isInteractive()) {
    throw new OperationalError(
      "Cannot confirm in non-interactive mode. Use --force.",
    );
  }

  const suffix = targetPath ? ` at ${targetPath}` : "";
  return promptConfirm(`Delete ${description}${suffix}?`, false);
}

function operationalError(error: unknown): UsageError | OperationalError {
  return error instanceof UsageError || error instanceof OperationalError
    ? error
    : new OperationalError(getErrorMessage(error), {
        cause: error,
      });
}

async function runWorkspaceCreateCommand(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  const like = stringInvocationFlag(invocation, "like");
  if (like !== undefined) {
    if (like !== "current") {
      throw new UsageError(
        `Unsupported --like value "${like}". Expected "current".`,
      );
    }
    return runWorkspaceCreateLikeCurrent(invocation);
  }

  return runNewCommand(invocation);
}

async function runNewCommand(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  const interactive = isInteractive();
  let selections = [...invocation.beforeDoubleDash];
  let featureName: string | undefined;
  let description: string | undefined;
  let templateBranchPrefix: string | undefined;

  // Load config
  let config: WorkspaceConfig;
  try {
    ({ config } = await loadWorkspaceConfig());
  } catch (error) {
    if (interactive) cancel("Configuration error");
    return commandFailure(error);
  }

  if (!invocation.hadDoubleDash) {
    const { shouldUseGrid } = await import("./ui/grid-consumer.ts");
    if (shouldUseGrid()) {
      const { runNewWizard } = await import("./ui/new-wizard.ts");
      const templates = await listTemplates();
      let wizardResult: Awaited<ReturnType<typeof runNewWizard>>;
      try {
        wizardResult = await runNewWizard({
          config,
          templates,
          handleTemplateManagement,
        });
      } catch (error) {
        if (error instanceof CancelError) {
          cancel("Cancelled");
          return success();
        }
        throw error;
      }
      selections = wizardResult.templateId
        ? [wizardResult.templateId]
        : wizardResult.repoSlugs;
      featureName = wizardResult.featureName;
      description = wizardResult.description;
      templateBranchPrefix = wizardResult.templateBranchPrefix;
    } else {
      // Fallback: existing sequential prompts
      intro("Create a new workspace");
      const selected = await promptForTemplateOrRepos();
      if (!selected) return success();
      selections = selected;
    }
  } else {
    const workText = invocation.afterDoubleDash.join(" ").trim();
    if (!workText) {
      throw new UsageError('Missing name or description after "--".');
    }

    if (selections.length === 0) {
      throw new UsageError('Missing template or repositories before "--".');
    }

    if (isSlug(workText)) {
      featureName = workText;
    } else {
      description = workText;
      if (interactive) {
        const generated = await withSpinner(
          "Generating feature name...",
          () => generateSlugFromDescription(workText),
          "Feature name ready",
        );
        featureName = generated ?? sanitizeToSlug(workText);
      } else {
        const generated = await generateSlugFromDescription(workText);
        featureName = generated ?? sanitizeToSlug(workText);
      }
    }
  }

  // Resolve to repos
  let repos: RepoConfig[];
  let templateId: string | undefined;

  try {
    const resolved = await resolveRepositoryOrTemplateSpecifiers(selections);
    repos = resolved.repos;
    templateId = resolved.templateId;
    if (templateBranchPrefix === undefined) {
      templateBranchPrefix = resolved.templateBranchPrefix;
    }
  } catch (error) {
    if (interactive) cancel("Failed to resolve repositories");
    if (error instanceof RegisteredRepositoryNameCollisionError) {
      log.warn(getErrorMessage(error));
      return commandFailure();
    }
    return commandFailure(error);
  }

  // Get feature name (skip if delimiter or wizard already provided it)
  if (!featureName) {
    if (!interactive) {
      throw new UsageError("Missing name or description.");
    }

    const result = await promptForFeatureName();
    if (!result) return success();
    featureName = result.featureName;
    description = result.description;
  }

  // Build paths
  const workspaceRoot = config.defaultDir
    ? path.resolve(expandHome(config.defaultDir))
    : process.cwd();
  const prefix = config.dirPrefix ?? "";
  const workspaceName = validateResourceName(
    `${prefix}${featureName}`,
    "Workspace name",
  );
  const workspaceDir = resolveContainedPath(workspaceRoot, workspaceName);
  const branchName = buildBranchName(
    featureName,
    resolveBranchPrefix(config.branchPrefix, templateBranchPrefix),
  );

  // Dry-run mode
  if (booleanInvocationFlag(invocation, "dryRun")) {
    if (interactive) {
      note(
        [
          `Directory: ${workspaceDir}`,
          `Feature: ${featureName}`,
          description ? `Description: ${description}` : null,
          `Branch: ${branchName}`,
          templateId ? `Template: ${templateId}` : null,
          "",
          "Repositories:",
          ...repos.map((r) => `  • ${r.name}`),
        ]
          .filter(Boolean)
          .join("\n"),
        "Dry run preview",
      );
      outro("No changes made");
    } else {
      showDryRunReport({
        fields: [
          { label: "Directory", value: workspaceDir },
          { label: "Feature", value: featureName },
          ...(description
            ? [{ label: "Description", value: description }]
            : []),
          { label: "Branch", value: branchName },
          ...(templateId ? [{ label: "Template", value: templateId }] : []),
        ],
        sections: [repositoryReportSection("Repositories", repos)],
      });
    }
    return success();
  }

  // Stamp workspace
  const options = {
    featureName,
    branchName,
    workspaceDir,
    repos,
    ...(description && { description }),
    ...(templateId && { templateId }),
    onEvent: humanServiceEventSink,
  };

  if (interactive) {
    const { printRepoSetupFailures, stampWorkspaceInteractive } = await import(
      "./workspace/index.ts"
    );
    const result = await stampWorkspaceInteractive(options);
    printRepoSetupFailures(result.setupFailures);
    await writeShellCdPath(workspaceDir);
    outro("Happy shipping!");
  } else {
    await stampWorkspace(options);
    await writeShellCdPath(workspaceDir);
    log.info("Happy shipping!");
  }
  return success();
}

async function runAddCommand(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  const interactive = isInteractive();
  let selections = [...invocation.beforeDoubleDash];

  if (selections.length === 0) {
    if (!interactive) {
      throw new UsageError("No repositories specified.");
    }

    const repos = await promptText("Repositories to add", {
      placeholder: "cached name, org/repo, or git URL; comma-separated",
      validate: (input) => {
        if (!input.trim()) return "At least one repository is required";
        return null;
      },
    });

    selections = repos
      .split(",")
      .map((repo) => repo.trim())
      .filter(Boolean);
  }

  const workspaceFlag = stringInvocationFlag(invocation, "workspace");
  const workspaceDir = workspaceFlag
    ? path.resolve(expandHome(workspaceFlag))
    : await detectWorkspaceFromCwd();

  if (!workspaceDir) {
    return commandFailure(
      "Not inside a workspace. Run this command from a workspace or pass --workspace <dir>.",
    );
  }

  let metadata: Awaited<ReturnType<typeof readWorkspaceMetadata>>;
  try {
    metadata = await readWorkspaceMetadata(workspaceDir);
  } catch (error) {
    return commandFailure(error);
  }

  if (!metadata) {
    return commandFailure(
      `Could not read workspace metadata from ${workspaceDir}`,
    );
  }

  let repos: RepoConfig[];
  try {
    repos = await resolveRepositorySpecifiers(selections);
  } catch (error) {
    return commandFailure(error);
  }

  const branchName =
    metadata.repos.find((repo) => repo.feature_branch)?.feature_branch ??
    metadata.workspace.feature_name;

  if (booleanInvocationFlag(invocation, "dryRun")) {
    if (interactive) {
      note(
        [
          `Workspace: ${workspaceDir}`,
          `Branch: ${branchName}`,
          "",
          "Repositories to add:",
          ...repos.map((repo) => `  • ${repo.name}`),
        ].join("\n"),
        "Dry run preview",
      );
      outro("No changes made");
    } else {
      showDryRunReport({
        fields: [
          { label: "Workspace", value: workspaceDir },
          { label: "Branch", value: branchName },
        ],
        sections: [repositoryReportSection("Repositories to add", repos)],
      });
    }
    return success();
  }

  const template = metadata.workspace.template_id
    ? await loadTemplate(metadata.workspace.template_id)
    : null;

  try {
    const { addReposToWorkspace } = await import("./workspace/index.ts");
    const result = await addReposToWorkspace({
      workspaceDir,
      repos,
      branchName,
      ...(template?.config.disableInitializers !== undefined
        ? { disabledInitializers: template.config.disableInitializers }
        : {}),
      onEvent: humanServiceEventSink,
    });

    if (result.addedRepos.length > 0) {
      log.success(
        `Added ${result.addedRepos.length} repos to ${path.basename(workspaceDir)}.`,
      );
    }

    if (result.failedRepos.length > 0) {
      log.error(
        `Failed to add ${result.failedRepos.length} repo${result.failedRepos.length === 1 ? "" : "s"}.`,
      );
      return commandFailure();
    }

    if (interactive) {
      outro("Workspace updated");
    }
    return success();
  } catch (error) {
    return commandFailure(error);
  }
}

async function runWorkspaceCreateLikeCurrent(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  const interactive = isInteractive();

  // Must be inside a workspace
  const sourceDir = await detectWorkspaceFromCwd();
  if (!sourceDir) {
    return commandFailure(
      "Not inside a workspace. Run this command from within an existing workspace.",
    );
  }

  const metadata = await readWorkspaceMetadata(sourceDir);
  if (!metadata) {
    return commandFailure(
      `Could not read workspace metadata from ${sourceDir}`,
    );
  }

  let featureName: string;
  let description: string | undefined;
  const input = invocation.afterDoubleDash.join(" ").trim();
  if (isSlug(input)) {
    featureName = input;
  } else {
    description = input;
    if (interactive) {
      const generated = await withSpinner(
        "Generating feature name...",
        () => generateSlugFromDescription(input),
        "Feature name ready",
      );
      featureName = generated ?? sanitizeToSlug(input);
    } else {
      const generated = await generateSlugFromDescription(input);
      featureName = generated ?? sanitizeToSlug(input);
    }
  }

  // Reconstruct RepoConfig[] from metadata
  const repos: RepoConfig[] = metadata.repos.map((r) => ({
    name: r.name,
    remote: r.remote,
    defaultBranch: r.default_branch,
  }));

  // Infer prefixes from the source workspace
  const branchPrefix = inferBranchPrefix(
    metadata.repos[0]?.feature_branch,
    metadata.workspace.feature_name,
  );
  const dirPrefix = inferDirPrefix(sourceDir, metadata.workspace.feature_name);
  const branchName = buildBranchName(featureName, branchPrefix);

  // Build new workspace as a sibling of the source
  const workspaceName = validateResourceName(
    `${dirPrefix}${featureName}`,
    "Workspace name",
  );
  const workspaceDir = resolveContainedPath(
    path.dirname(sourceDir),
    workspaceName,
  );

  const templateId = metadata.workspace.template_id;

  // Dry-run mode
  if (booleanInvocationFlag(invocation, "dryRun")) {
    if (interactive) {
      note(
        [
          `Source:    ${path.basename(sourceDir)}`,
          `Directory: ${workspaceDir}`,
          `Feature: ${featureName}`,
          description ? `Description: ${description}` : null,
          `Branch: ${branchName}`,
          templateId ? `Template: ${templateId}` : null,
          "",
          "Repositories:",
          ...repos.map((r) => `  • ${r.name}`),
        ]
          .filter(Boolean)
          .join("\n"),
        "Dry run preview",
      );
      outro("No changes made");
    } else {
      showDryRunReport({
        fields: [
          { label: "Source workspace", value: path.basename(sourceDir) },
          { label: "Directory", value: workspaceDir },
          { label: "Feature", value: featureName },
          ...(description
            ? [{ label: "Description", value: description }]
            : []),
          { label: "Branch", value: branchName },
          ...(templateId ? [{ label: "Template", value: templateId }] : []),
        ],
        sections: [repositoryReportSection("Repositories", repos)],
      });
    }
    return success();
  }

  // Stamp workspace
  const options = {
    featureName,
    branchName,
    workspaceDir,
    repos,
    ...(description && { description }),
    ...(templateId && { templateId }),
    onEvent: humanServiceEventSink,
  };

  if (interactive) {
    const { stampWorkspaceInteractive } = await import("./workspace/index.ts");
    await stampWorkspaceInteractive(options);
    await writeShellCdPath(workspaceDir);
    outro("Happy shipping!");
  } else {
    await stampWorkspace(options);
    await writeShellCdPath(workspaceDir);
    log.info("Happy shipping!");
  }
  return success();
}

/**
 * Extract the directory prefix by comparing the directory name to feature_name.
 * E.g. dir "wf-fix-auth" with name "fix-auth" → prefix "wf-".
 */
function inferDirPrefix(workspaceDir: string, featureName: string): string {
  const dirName = path.basename(workspaceDir);
  if (dirName.endsWith(featureName)) {
    return dirName.slice(0, -featureName.length);
  }
  return "";
}

/**
 * Simple slug sanitization for fallback when AI generation fails.
 */
function sanitizeToSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

type FeatureNameResult = {
  featureName: string;
  description?: string;
};

/**
 * Prompt user for feature name interactively.
 * Detects if input is a slug or prose, and generates slug if needed.
 */
async function promptForFeatureName(): Promise<FeatureNameResult | null> {
  try {
    promptLog.info("Used for the directory, branch, and worktree names.");
    const input = await promptText("What are you working on?", {
      placeholder: "describe your task, or enter a slug like fix-auth-bug",
      validate: (value) => {
        if (!value.trim()) return "Please describe what you're working on";
        return null;
      },
      throwOnCancel: true,
    });

    const trimmed = input.trim();

    // If it's already a slug, use it directly with confirmation
    if (isSlug(trimmed)) {
      promptLog.info(`Using "${trimmed}" as feature name`);
      return { featureName: trimmed };
    }

    // It's prose - generate a slug with spinner
    const generated = await withSpinner(
      "Generating feature name...",
      () => generateSlugFromDescription(trimmed),
      "Feature name ready",
    );

    const featureName = generated ?? sanitizeToSlug(trimmed);
    promptLog.info(`Using "${featureName}" as feature name`);

    return {
      featureName,
      description: trimmed,
    };
  } catch (e) {
    if (e instanceof CancelError) {
      cancel("Cancelled");
      return null;
    }
    throw e;
  }
}

/**
 * Get terminal width with fallback.
 */
function getTerminalWidth(): number {
  return process.stdout.columns ?? 80;
}

/**
 * Extract a display-friendly `org/repo` name from various git URL formats.
 *
 * Supported formats:
 * - `org/repo` (shorthand) → `org/repo`
 * - `git@github.com:org/repo.git` → `org/repo`
 * - `https://github.com/org/repo.git` → `org/repo`
 * - `ssh://git@github.com/org/repo.git` → `org/repo`
 */
function getRepoDisplayName(repo: string): string {
  const trimmed = repo.trim();

  // Already shorthand format (org/repo without special chars at start)
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    return trimmed;
  }

  // SSH format: git@host:path/to/repo.git
  const sshMatch = trimmed.match(/^[\w-]+@[\w.-]+:(.+)$/);
  if (sshMatch?.[1]) {
    const path = sshMatch[1].replace(/\.git$/i, "");
    const parts = path.split("/");
    if (parts.length >= 2) {
      return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    }
    return parts[parts.length - 1] ?? trimmed;
  }

  // URL formats: https://, http://, ssh://, git://
  const urlMatch = trimmed.match(/^(?:https?|ssh|git):\/\/[^/]+\/(.+)$/);
  if (urlMatch?.[1]) {
    const path = urlMatch[1].replace(/\.git$/i, "");
    const parts = path.split("/");
    if (parts.length >= 2) {
      return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    }
    return parts[parts.length - 1] ?? trimmed;
  }

  return trimmed;
}

/**
 * Format repository names with intelligent truncation.
 *
 * Returns a string like "org/repo1, org/repo2" or "org/repo1, 2 more"
 * if the full list doesn't fit within maxWidth.
 */
function formatRepoNames(repos: string[], maxWidth: number): string {
  if (repos.length === 0) {
    return "0 repos";
  }

  const displayNames = repos.map(getRepoDisplayName);
  const minWidth = 20;

  // Fall back to count only if very narrow
  if (maxWidth < minWidth) {
    return `${repos.length} repo${repos.length !== 1 ? "s" : ""}`;
  }

  // Try to fit all names
  const fullList = displayNames.join(", ");
  if (fullList.length <= maxWidth) {
    return fullList;
  }

  // Progressively truncate with ", N more"
  for (let shown = displayNames.length - 1; shown >= 1; shown--) {
    const remaining = displayNames.length - shown;
    const partial = displayNames.slice(0, shown).join(", ");
    const suffix = `, ${remaining} more`;
    const result = partial + suffix;
    if (result.length <= maxWidth) {
      return result;
    }
  }

  // Nothing fits, fall back to count
  return `${repos.length} repo${repos.length !== 1 ? "s" : ""}`;
}

/**
 * Format a template hint showing description and repository names.
 */
function formatTemplateHint(
  template: Awaited<ReturnType<typeof loadTemplate>>,
  labelWidth = 0,
): string {
  if (!template) return "";

  const terminalWidth = getTerminalWidth();
  // Account for prompt overhead: "? message" prefix, spacing, and cursor
  const promptOverhead = 6;
  const separatorWidth = 3; // " | "

  const description = template.config.description ?? "";
  const descriptionWidth = description
    ? description.length + separatorWidth
    : 0;

  // Available width for repo names
  const availableWidth =
    terminalWidth -
    promptOverhead -
    labelWidth -
    descriptionWidth -
    separatorWidth;

  const repoNames = formatRepoNames(template.config.repos, availableWidth);

  if (description) {
    return `${description} | ${repoNames}`;
  }
  return repoNames;
}

/**
 * Interactive flow to create a new template.
 * Returns the new template ID if successful, null if cancelled.
 */
async function wizardCreateTemplate(): Promise<string | null> {
  try {
    const templateId = await promptText("Template name", {
      placeholder: "my-template",
      validate: (input) => {
        try {
          validateTemplateName(input.trim());
          return null;
        } catch (error) {
          return getErrorMessage(error);
        }
      },
      throwOnCancel: true,
    });

    // Check if template already exists
    const existing = await loadTemplate(templateId);
    if (existing) {
      promptLog.error(`Template "${templateId}" already exists.`);
      return null;
    }

    const { config: workspaceConfig } = await loadWorkspaceConfig();
    const { renderTemplateEditor } = await import("./ui/index.ts");

    let savedTemplateId: string | null = null;

    await renderTemplateEditor({
      templateId,
      initialConfig: { repos: [] },
      workspaceConfig,
      onSave: async (config) => {
        await createTemplate(
          templateId,
          await qualifyTemplateRepositories(config),
        );
        savedTemplateId = templateId;
      },
    });

    return savedTemplateId;
  } catch (e) {
    if (e instanceof CancelError) return null;
    throw e;
  }
}

/**
 * Interactive flow to edit an existing template.
 * Returns the template ID if saved, null if cancelled.
 */
async function wizardEditTemplate(
  templates: Awaited<ReturnType<typeof listTemplates>>,
): Promise<string | null> {
  if (templates.length === 0) {
    promptLog.warn("No templates to edit.");
    return null;
  }

  try {
    const selection = await promptSelect("Select template to edit", {
      options: templates.map((t) => ({
        value: t.id,
        label: t.id,
        description: formatTemplateHint(t, t.id.length),
      })),
      throwOnCancel: true,
    });

    const template = await loadTemplate(selection);
    if (!template) {
      promptLog.error(`Template "${selection}" not found.`);
      return null;
    }

    return wizardEditLoadedTemplate(template);
  } catch (e) {
    if (e instanceof CancelError) return null;
    throw e;
  }
}

async function wizardEditTemplateById(
  templateId: string,
): Promise<string | null> {
  const template = await loadTemplate(templateId);
  if (!template) {
    promptLog.error(`Template "${templateId}" not found.`);
    return null;
  }

  return wizardEditLoadedTemplate(template);
}

async function wizardEditLoadedTemplate(
  template: NonNullable<Awaited<ReturnType<typeof loadTemplate>>>,
): Promise<string | null> {
  const { config: workspaceConfig } = await loadWorkspaceConfig();
  const { renderTemplateEditor } = await import("./ui/index.ts");

  let savedTemplateId: string | null = null;

  await renderTemplateEditor({
    templateId: template.id,
    initialConfig: template.config,
    workspaceConfig,
    onSave: async (config) => {
      await createTemplate(
        template.id,
        await qualifyTemplateRepositories(config),
      );
      savedTemplateId = template.id;
    },
  });

  return savedTemplateId;
}

/**
 * Interactive flow to clone an existing template.
 * Returns the new template ID if successful, null if cancelled.
 */
async function wizardCloneTemplate(
  templates: Awaited<ReturnType<typeof listTemplates>>,
): Promise<string | null> {
  if (templates.length === 0) {
    promptLog.warn("No templates to clone.");
    return null;
  }

  try {
    const sourceSelection = await promptSelect("Select template to clone", {
      options: templates.map((t) => ({
        value: t.id,
        label: t.id,
        description: formatTemplateHint(t, t.id.length),
      })),
      throwOnCancel: true,
    });

    const sourceTemplate = await loadTemplate(sourceSelection);
    if (!sourceTemplate) {
      promptLog.error(`Template "${sourceSelection}" not found.`);
      return null;
    }

    return wizardCloneLoadedTemplate(sourceTemplate);
  } catch (e) {
    if (e instanceof CancelError) return null;
    throw e;
  }
}

async function wizardCloneTemplateById(
  templateId: string,
): Promise<string | null> {
  const sourceTemplate = await loadTemplate(templateId);
  if (!sourceTemplate) {
    promptLog.error(`Template "${templateId}" not found.`);
    return null;
  }

  return wizardCloneLoadedTemplate(sourceTemplate);
}

async function wizardCloneLoadedTemplate(
  sourceTemplate: NonNullable<Awaited<ReturnType<typeof loadTemplate>>>,
): Promise<string | null> {
  const newTemplateId = await promptText("New template name", {
    placeholder: `${sourceTemplate.id}-copy`,
    validate: (input) => {
      try {
        validateTemplateName(input);
        return null;
      } catch (error) {
        return getErrorMessage(error);
      }
    },
    throwOnCancel: true,
  });

  // Check if new template already exists
  const existing = await loadTemplate(newTemplateId);
  if (existing) {
    promptLog.error(`Template "${newTemplateId}" already exists.`);
    return null;
  }

  const { config: workspaceConfig } = await loadWorkspaceConfig();
  const { renderTemplateEditor } = await import("./ui/index.ts");

  let savedTemplateId: string | null = null;

  await renderTemplateEditor({
    templateId: newTemplateId,
    initialConfig: sourceTemplate.config,
    workspaceConfig,
    onSave: async (config) => {
      await createTemplate(
        newTemplateId,
        await qualifyTemplateRepositories(config),
      );
      savedTemplateId = newTemplateId;
    },
  });

  return savedTemplateId;
}

type ManageAction = "create" | "edit" | "clone" | "back";

/**
 * Show template management submenu.
 * Returns the action taken, or null if cancelled.
 */
async function handleTemplateManagement(
  templates: Awaited<ReturnType<typeof listTemplates>>,
): Promise<{ action: ManageAction; newTemplateId?: string } | null> {
  const hasTemplates = templates.length > 0;

  const options: { value: ManageAction; label: string; hint?: string }[] = [
    {
      value: "create",
      label: "Create new template",
      hint: "Start from scratch",
    },
  ];

  if (hasTemplates) {
    options.push(
      {
        value: "edit",
        label: "Edit existing template",
        hint: "Modify a template",
      },
      {
        value: "clone",
        label: "Clone and modify template",
        hint: "Copy as starting point",
      },
    );
  }

  options.push({
    value: "back",
    label: "Back to workspace setup",
  });

  let action: ManageAction;
  try {
    action = await promptSelect("Template management", {
      options: options.map((o) => ({
        value: o.value,
        label: o.label,
        ...(o.hint ? { description: o.hint } : {}),
      })),
      throwOnCancel: true,
    });
  } catch (e) {
    if (e instanceof CancelError) return null;
    throw e;
  }

  if (action === "back") {
    return { action: "back" };
  }

  let newTemplateId: string | null = null;

  switch (action) {
    case "create":
      newTemplateId = await wizardCreateTemplate();
      break;
    case "edit":
      newTemplateId = await wizardEditTemplate(templates);
      break;
    case "clone":
      newTemplateId = await wizardCloneTemplate(templates);
      break;
  }

  return newTemplateId ? { action, newTemplateId } : { action };
}

/**
 * Prompt user to select a template or enter repos manually.
 */
async function promptForTemplateOrRepos(): Promise<string[] | null> {
  try {
    // Main loop to allow returning from template management
    while (true) {
      const templates = await listTemplates();

      type SelectionValue =
        | { type: "template"; id: string }
        | { type: "custom" }
        | { type: "manage" };

      // If no templates, offer to create one first
      if (templates.length === 0) {
        const createFirst = await promptConfirm(
          "No templates found. Create one now?",
          true,
          { throwOnCancel: true },
        );

        if (createFirst) {
          const newTemplateId = await wizardCreateTemplate();
          if (newTemplateId) {
            promptLog.success(`Template "${newTemplateId}" created.`);
            // Loop back to show templates
            continue;
          }
          // If cancelled, fall through to manual entry
        }

        // Manual entry
        const repos = await promptText("Repositories", {
          placeholder: "cached name, org/repo, or git URL; comma-separated",
          validate: (input) => {
            if (!input.trim()) return "At least one repository is required";
            return null;
          },
          throwOnCancel: true,
        });

        return repos
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean);
      }

      // Build options for select
      const selectOptions: {
        value: SelectionValue;
        label: string;
        description?: string;
      }[] = templates.map((t) => ({
        value: { type: "template", id: t.id },
        label: t.id,
        description: formatTemplateHint(t, t.id.length),
      }));

      selectOptions.push({
        value: { type: "custom" },
        label: "Enter repositories manually",
      });

      promptLog.info("Choose a template or enter repos directly.");
      const selection = await promptSelect<SelectionValue>(
        "Select workspace setup",
        {
          options: selectOptions,
          hotkeys: [
            {
              key: "t",
              value: { type: "manage" } as SelectionValue,
              hint: "manage templates",
            },
          ],
          throwOnCancel: true,
        },
      );

      if (selection.type === "manage") {
        const result = await handleTemplateManagement(templates);
        if (result === null) {
          cancel("Cancelled");
          return null;
        }
        if (result.newTemplateId) {
          promptLog.success(`Template "${result.newTemplateId}" saved.`);
        }
        // Loop back to show updated template list
        continue;
      }

      if (selection.type === "custom") {
        const repos = await promptText("Repositories", {
          placeholder: "cached name, org/repo, or git URL; comma-separated",
          validate: (input) => {
            if (!input.trim()) return "At least one repository is required";
            return null;
          },
          throwOnCancel: true,
        });

        return repos
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean);
      }

      // Use the selected template directly
      return [selection.id];
    }
  } catch (e) {
    if (e instanceof CancelError) {
      cancel("Cancelled");
      return null;
    }
    throw e;
  }
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
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
    if (isPathInsideOrEqual(resolvedCwd, repoDir)) {
      return repo.name;
    }
  }

  if (
    metadata.workspace.type === "review" &&
    metadata.repos.length === 1 &&
    isPathInsideOrEqual(resolvedCwd, resolvedWorkspaceDir)
  ) {
    return metadata.repos[0]?.name;
  }

  if (allowTask) {
    for (const entry of metadata.tasks ?? []) {
      const worktreeDir = resolveContainedPath(
        resolvedWorkspaceDir,
        entry.path,
      );
      if (isPathInsideOrEqual(resolvedCwd, worktreeDir)) {
        return entry.parent_repo;
      }
    }
  }

  return undefined;
}

function resolveWorktreeSourceDirFromCwd({
  workspaceDir,
  metadata,
  parentRepoName,
  cwd,
}: {
  workspaceDir: string;
  metadata: WorkspaceMetadata;
  parentRepoName: string;
  cwd: string;
}): string | undefined {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedCwd = path.resolve(cwd);

  for (const entry of metadata.review_worktrees ?? []) {
    const worktreeDir = resolveContainedPath(resolvedWorkspaceDir, entry.path);
    if (isPathInsideOrEqual(resolvedCwd, worktreeDir)) {
      return worktreeDir;
    }
  }

  for (const entry of metadata.tasks ?? []) {
    const worktreeDir = resolveContainedPath(resolvedWorkspaceDir, entry.path);
    if (
      entry.parent_repo === parentRepoName &&
      isPathInsideOrEqual(resolvedCwd, worktreeDir)
    ) {
      return worktreeDir;
    }
  }

  return undefined;
}

function isPathInsideOrEqual(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * Workspace information for listing and selection.
 */
type WorkspaceInfo = {
  name: string;
  path: string;
  description?: string;
  template?: string;
  created?: string;
  modifiedAt: Date;
  repos: string[];
  repoCount: number;
};

/**
 * Find all workspaces in a directory.
 */
async function findWorkspaces(rootDir: string): Promise<WorkspaceInfo[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(rootDir);
  } catch {
    return [];
  }

  const workspaces: WorkspaceInfo[] = [];

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry);
    try {
      const stat = await fs.stat(entryPath);
      if (!stat.isDirectory()) continue;

      const metadata = await readWorkspaceMetadata(entryPath);
      if (metadata) {
        const repoNames = metadata.repos.map((repo) => repo.name);
        const modifiedAt = await getWorkspaceModifiedAt(
          entryPath,
          stat.mtime,
          repoNames,
        );

        workspaces.push({
          name: entry,
          path: entryPath,
          created: metadata.workspace.created_at,
          modifiedAt,
          repos: repoNames,
          repoCount: metadata.repos.length,
          ...(metadata.workspace.description
            ? { description: metadata.workspace.description }
            : {}),
          ...(metadata.workspace.template_id
            ? { template: metadata.workspace.template_id }
            : {}),
        });
      }
    } catch {
      // Skip entries that can't be read
    }
  }

  return workspaces.sort((a, b) => {
    const modifiedComparison = b.modifiedAt.getTime() - a.modifiedAt.getTime();
    return modifiedComparison !== 0
      ? modifiedComparison
      : a.name.localeCompare(b.name);
  });
}

async function getWorkspaceModifiedAt(
  workspaceDir: string,
  workspaceModifiedAt: Date,
  repoNames: readonly string[],
): Promise<Date> {
  let newestTime = workspaceModifiedAt.getTime();
  const paths = [
    getMetadataPath(workspaceDir),
    ...repoNames.map((repoName) =>
      resolveContainedPath(workspaceDir, repoName),
    ),
  ];

  for (const candidatePath of paths) {
    try {
      const stat = await fs.stat(candidatePath);
      newestTime = Math.max(newestTime, stat.mtime.getTime());
    } catch {
      // Missing or unreadable metadata/repos should not hide the workspace.
    }
  }

  return new Date(newestTime);
}

function formatWorkspacePickerDescription(workspace: WorkspaceInfo): string {
  const details = [
    workspace.repos.length > 0
      ? workspace.repos.join(", ")
      : `${workspace.repoCount} repo${workspace.repoCount !== 1 ? "s" : ""}`,
    workspace.template ? `template: ${workspace.template}` : undefined,
    `modified ${formatWorkspaceModifiedAt(workspace.modifiedAt)}`,
  ].filter((detail): detail is string => Boolean(detail));

  return details.join(" | ");
}

function formatWorkspaceModifiedAt(date: Date, now = new Date()): string {
  const elapsedMs = now.getTime() - date.getTime();
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));

  if (elapsedSeconds < 60) return "just now";

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) {
    return `${elapsedDays}d ago`;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).format(date);
}

async function resolveWorkspaceByName(name: string): Promise<string | null> {
  const { config } = await loadWorkspaceConfig();

  if (!config.defaultDir) {
    log.error("No defaultDir configured. Run: wf config init");
    return null;
  }

  const workspaceRoot = path.resolve(expandHome(config.defaultDir));
  const candidateNames = new Set([name]);

  if (config.dirPrefix && !name.startsWith(config.dirPrefix)) {
    candidateNames.add(`${config.dirPrefix}${name}`);
  }

  for (const candidateName of candidateNames) {
    try {
      const candidatePath = resolveContainedPath(
        workspaceRoot,
        validateResourceName(candidateName, "Workspace name"),
      );
      const stat = await fs.stat(candidatePath);
      if (!stat.isDirectory()) {
        continue;
      }

      const metadata = await readWorkspaceMetadata(candidatePath);
      if (metadata) {
        return candidatePath;
      }
    } catch {
      // Keep trying other candidates.
    }
  }

  const workspaces = await findWorkspaces(workspaceRoot);
  log.error(`Workspace "${name}" not found in ${workspaceRoot}`);
  if (workspaces.length > 0) {
    log.info(`Available: ${workspaces.map((ws) => ws.name).join(", ")}`);
  }
  return null;
}

/**
 * Interactive workspace selection.
 * Returns the selected workspace path, or null if cancelled.
 */
async function selectWorkspaceInteractive(
  prompt = "Select workspace",
): Promise<string | null> {
  const { config } = await loadWorkspaceConfig();

  if (!config.defaultDir) {
    promptLog.error(
      "No defaultDir configured. Specify workspace path or run: wf config init",
    );
    return null;
  }

  const workspaceRoot = path.resolve(expandHome(config.defaultDir));
  const workspaces = await findWorkspaces(workspaceRoot);

  if (workspaces.length === 0) {
    promptLog.info(`No workspaces found in ${workspaceRoot}`);
    return null;
  }

  try {
    const selection = await promptSelect(prompt, {
      options: workspaces.map((ws) => ({
        value: ws.path,
        label: ws.name,
        description: formatWorkspacePickerDescription(ws),
      })),
      throwOnCancel: true,
    });

    return selection;
  } catch (e) {
    if (e instanceof CancelError) return null;
    throw e;
  }
}

async function selectWorkspaceFuzzy(
  prompt = "Find workspace",
): Promise<string | null | undefined> {
  const { config } = await loadWorkspaceConfig();

  if (!config.defaultDir) {
    promptLog.error(
      "No defaultDir configured. Specify workspace path or run: wf config init",
    );
    return undefined;
  }

  const workspaceRoot = path.resolve(expandHome(config.defaultDir));
  const workspaces = await findWorkspaces(workspaceRoot);

  if (workspaces.length === 0) {
    promptLog.info(`No workspaces found in ${workspaceRoot}`);
    return undefined;
  }

  try {
    const selection = await promptFuzzySelect(prompt, {
      options: workspaces.map((ws) => ({
        value: ws.path,
        label: ws.name,
        description: formatWorkspacePickerDescription(ws),
      })),
      throwOnCancel: true,
    });

    return selection;
  } catch (e) {
    if (e instanceof CancelError) return null;
    throw e;
  }
}

/**
 * Display a cleanup preview as a note box.
 */
function showCleanupPreview(preview: CleanupPreview): void {
  const lines: string[] = [
    `Directory: ${preview.workspaceDir}`,
    `Repositories: ${preview.repos.join(", ")}`,
  ];

  if (preview.tasks && preview.tasks.length > 0) {
    lines.push(`Tasks: ${preview.tasks.join(", ")}`);
  }

  if (preview.remoteBranches && preview.remoteBranches.length > 0) {
    lines.push("");
    lines.push("Merged remote branches available for deletion:");
    for (const branch of preview.remoteBranches) {
      lines.push(`  • ${branch.repo}: ${branch.branch}`);
    }
  }

  note(lines.join("\n"), "Cleanup preview");
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

function repositoryReportSection(
  title: string,
  repos: readonly RepoConfig[],
): ReportSection {
  return {
    title,
    entries: repos.map((repo) => ({
      title: repo.name,
      details: [{ label: "Remote", value: repo.remote }],
    })),
  };
}
