import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import arg from "arg";
import {
  isRepoSlug,
  loadWorkspaceConfig,
  reposFromSlugs,
  saveWorkspaceConfig,
} from "./config.ts";
import { help } from "./help.ts";
import { log } from "./logger.ts";
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
} from "./templates/index.ts";
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
import { generateSlugFromDescription, isSlug } from "./utils/slug.ts";
import {
  type CleanupPreview,
  cleanupWorkspace,
  previewCleanup,
  validateWorkspace,
} from "./workspace/cleanup.ts";
import { stampWorkspace } from "./workspace/index.ts";
import {
  hasWorkspaceMetadata,
  readWorkspaceMetadata,
} from "./workspace/metadata.ts";

export { log };

export async function cli(): Promise<void> {
  const argv = process.argv.slice(2);

  // Check for help flag at top level
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(await help());
    return;
  }

  // Check for version flag at top level
  if (argv[0] === "--version" || argv[0] === "-V") {
    await runVersionCommand();
    return;
  }

  // Route to subcommands
  const command = argv[0];
  const commandArgv = argv.slice(1);

  switch (command) {
    case "new":
      await runNewCommand(commandArgv);
      break;
    case "cd":
      await runCdCommand(commandArgv);
      break;
    case "find":
      await runFindCommand(commandArgv);
      break;
    case "add":
      await runAddCommand(commandArgv);
      break;
    case "clean":
      await runCleanCommand(commandArgv);
      break;
    case "config":
      await runConfigCommand(commandArgv);
      break;
    case "skills": {
      const { runSkillsCommand } = await import("./skills.ts");
      await runSkillsCommand(commandArgv);
      break;
    }
    case "init":
      await runInitCommand(commandArgv);
      break;
    case "template":
      await runTemplateCommand(commandArgv);
      break;
    case "fork":
      await runForkCommand(commandArgv);
      break;
    case "worktree":
    case "wt":
      await runWorktreeCommand(commandArgv);
      break;
    case "list":
    case "ls":
      await runListCommand();
      break;
    case "version":
      await runVersionCommand();
      break;
    default:
      log.error(`Unknown command: ${command}`);
      console.log(await help());
      process.exitCode = 1;
  }
}

async function runConfigCommand(argv: string[]): Promise<void> {
  const subcommand = argv[0];

  switch (subcommand) {
    case "--help":
    case "-h":
      console.log(await help());
      break;
    case "edit":
      await runConfigEdit();
      break;
    case "init":
      await runConfigInit();
      break;
    case "show":
    case undefined:
      await runConfigShow();
      break;
    default:
      log.error(`Unknown config subcommand: ${subcommand}`);
      log.info("Available: show, edit, init");
      process.exitCode = 1;
  }
}

async function runInitCommand(argv: string[]): Promise<void> {
  const args = arg(
    {
      "--help": Boolean,
      "-h": "--help",
    },
    { argv },
  );

  if (args["--help"]) {
    console.log(await help());
    return;
  }

  const requestedShell = args._[0] ?? process.env["SHELL"];
  const shell = normalizeShellName(requestedShell);

  if (!shell) {
    log.error("Unsupported shell. Use 'wf init zsh' or 'wf init bash'.");
    process.exitCode = 1;
    return;
  }

  console.log(renderShellInit(shell));
}

async function runConfigInit(): Promise<void> {
  if (!isInteractive()) {
    log.error("Config init requires an interactive terminal.");
    log.info("Use 'wf config edit' to edit the config file directly.");
    process.exitCode = 1;
    return;
  }

  const { path: configPath, config } = await loadWorkspaceConfig();

  console.log("\nConfigure workforest\n");

  // Default directory
  const currentDefaultDir = config.defaultDir ?? "";
  const defaultDir = await promptText(
    "Default workspace directory (where workspaces are created)",
    { defaultValue: currentDefaultDir || "~/Code/workspaces" },
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
    ...(dirPrefix ? { dirPrefix } : {}),
    ...(branchPrefix ? { branchPrefix } : {}),
  };

  await saveWorkspaceConfig(configPath, newConfig);
  log.success(`Config saved to ${configPath}`);
}

async function runConfigShow(): Promise<void> {
  const { path: configPath, config } = await loadWorkspaceConfig();

  console.log("\nWorkspace Configuration\n");

  // Default directory
  console.log("Default Directory:");
  if (config.defaultDir) {
    console.log(`  ${config.defaultDir}`);
  } else {
    console.log("  (not set - uses current directory)");
  }
  console.log("  Example: ~/Code/workspaces");

  // Directory prefix
  console.log("\nDirectory Prefix:");
  console.log(`  "${config.dirPrefix ?? ""}"`);
  console.log('  Example: "wf-" creates directories like wf-my-feature');

  // Branch prefix
  console.log("\nBranch Prefix:");
  console.log(`  "${config.branchPrefix ?? ""}"`);
  console.log('  Example: "tom/" creates branches like tom/my-feature');

  if (config.vercelLink) {
    console.log("\nVercel Auto-Link:");

    const ownerMappings = Object.entries(
      config.vercelLink.teamByGitHubOwner ?? {},
    );
    if (ownerMappings.length > 0) {
      console.log("  Team by GitHub Owner:");
      for (const [owner, team] of ownerMappings) {
        console.log(`    ${owner} -> ${team}`);
      }
    } else {
      console.log("  Team by GitHub Owner: (none)");
    }

    const repoOverrides = Object.entries(config.vercelLink.repoOverrides ?? {});
    if (repoOverrides.length > 0) {
      console.log("  Repo Overrides:");
      for (const [repo, override] of repoOverrides) {
        if (override.disabled) {
          console.log(`    ${repo}: disabled`);
        } else if (override.team) {
          console.log(`    ${repo}: ${override.team}`);
        } else {
          console.log(`    ${repo}: (no-op override)`);
        }
      }
    } else {
      console.log("  Repo Overrides: (none)");
    }
  }

  console.log(`\nConfig Location: ${configPath}`);
  console.log();
}

async function runConfigEdit(): Promise<void> {
  const { spawn } = await import("node:child_process");
  const { path: configPath } = await loadWorkspaceConfig();

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
        reject(new Error(`Editor exited with code ${code}`));
      }
    });
    child.on("error", reject);
  });
}

async function runVersionCommand(): Promise<void> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = path.join(__dirname, "..", "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  console.log(`workforest ${packageJson.version}`);
}

async function runListCommand(): Promise<void> {
  const { config } = await loadWorkspaceConfig();

  if (!config.defaultDir) {
    log.error(
      "No defaultDir configured. Set it in your config to list workspaces.",
    );
    log.info("Run: wf config edit");
    process.exitCode = 1;
    return;
  }

  const workspaceRoot = path.resolve(expandHome(config.defaultDir));

  // Check if directory exists
  let entries: string[];
  try {
    entries = await fs.readdir(workspaceRoot);
  } catch {
    log.error(`Directory not found: ${workspaceRoot}`);
    process.exitCode = 1;
    return;
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
    return;
  }

  console.log(`\nWorkspaces in ${workspaceRoot}\n`);

  for (const ws of workspaces) {
    const desc = ws.description ? ` - ${ws.description}` : "";
    const template = ws.template ? ` (${ws.template})` : "";
    const branch = ws.branch ? `, branch: ${ws.branch}` : "";
    const created = ws.created
      ? new Date(ws.created).toLocaleDateString()
      : "unknown";
    console.log(`  ${ws.name}${desc}`);
    console.log(
      `    ${ws.repos} repos${template}${branch}, created ${created}`,
    );
  }

  console.log();
}

async function runWorktreeCommand(argv: string[]): Promise<void> {
  const args = arg(
    {
      "--help": Boolean,
      "--dir": String,
      "--repo": String,
      "--dry-run": Boolean,
      "--force": Boolean,
      "-h": "--help",
      "-n": "--dry-run",
      "-f": "--force",
    },
    { argv },
  );

  if (args["--help"]) {
    console.log(await help());
    return;
  }

  const subcommand = args._[0];
  if (subcommand === "list") {
    await runTemporaryWorktreeList(args);
    return;
  }

  if (subcommand === "rm") {
    await runTemporaryWorktreeRemove(args);
    return;
  }

  if (subcommand && !isRepoSlug(subcommand)) {
    const workspaceDir = await detectWorkspaceFromCwd();
    if (workspaceDir) {
      await runTemporaryWorktreeCreate(args, workspaceDir);
      return;
    }
  }

  await runStandaloneWorktreeCreate(args);
}

async function runStandaloneWorktreeCreate(args: {
  _: string[];
  "--dir"?: string;
  "--dry-run"?: boolean;
}): Promise<void> {
  const [repoInput, slug, extra] = args._;
  if (!repoInput || !slug || extra) {
    log.error("Usage: wf worktree <repo> <slug> [--dir <path>] [--dry-run]");
    process.exitCode = 1;
    return;
  }

  if (!isSlug(slug)) {
    log.error(
      `Invalid slug "${slug}". Slugs must be lowercase words separated by hyphens.`,
    );
    process.exitCode = 1;
    return;
  }

  let repo: RepoConfig;
  let branchName: string;
  let targetDir: string;
  try {
    const repos = reposFromSlugs([repoInput]);
    if (repos.length !== 1) {
      throw new Error("Exactly one repository is required.");
    }

    const resolvedRepo = repos[0];
    if (!resolvedRepo) {
      throw new Error("Exactly one repository is required.");
    }
    repo = resolvedRepo;

    const { config } = await loadWorkspaceConfig();
    branchName = buildBranchName(slug, config.branchPrefix);
    targetDir = args["--dir"]
      ? path.resolve(expandHome(args["--dir"]))
      : path.resolve(process.cwd(), slug);
  } catch (error) {
    log.error(getErrorMessage(error));
    process.exitCode = 1;
    return;
  }

  if (args["--dry-run"]) {
    console.log("\nDry run - no changes will be made\n");
    console.log(`Repository: ${repo.name} (${repo.remote})`);
    console.log(`Branch: ${branchName}`);
    console.log(`Target: ${targetDir}`);
    console.log();
    return;
  }

  try {
    const { createSingleWorktree } = await import("./worktree.ts");
    await createSingleWorktree({ repo, branchName, targetDir });
    await writeShellCdPath(targetDir);
    log.success(`Worktree ready: ${targetDir}`);
    if (!isShellAutoCdEnabled()) {
      log.info(`Run: cd ${targetDir}`);
    }
  } catch (error) {
    log.error(getErrorMessage(error));
    process.exitCode = 1;
  }
}

async function runTemporaryWorktreeCreate(
  args: {
    _: string[];
    "--dir"?: string;
    "--repo"?: string;
    "--dry-run"?: boolean;
    "--force"?: boolean;
  },
  workspaceDir: string,
): Promise<void> {
  if (args["--dir"]) {
    log.error("--dir is only supported for standalone worktrees.");
    process.exitCode = 1;
    return;
  }

  const slugs = args._;
  if (slugs.length === 0) {
    log.error("Usage: wf worktree <slug...> [--repo <repo>] [--dry-run]");
    process.exitCode = 1;
    return;
  }

  let metadata: WorkspaceMetadata | null;
  try {
    metadata = await readWorkspaceMetadata(workspaceDir);
  } catch (error) {
    log.error(getErrorMessage(error));
    process.exitCode = 1;
    return;
  }

  if (!metadata) {
    log.error(`Could not read workspace metadata from ${workspaceDir}`);
    process.exitCode = 1;
    return;
  }

  let parentRepo: WorkspaceRepoMetadata;
  try {
    parentRepo = resolveWorkspaceRepoForWorktreeCommand({
      workspaceDir,
      metadata,
      repoName: args["--repo"],
      cwd: process.cwd(),
      allowTemporaryWorktree: false,
    });
  } catch (error) {
    log.error(getErrorMessage(error));
    process.exitCode = 1;
    return;
  }

  const template = metadata.workspace.template_id
    ? await loadTemplate(metadata.workspace.template_id)
    : null;

  try {
    const { createTemporaryWorktrees } = await import(
      "./workspace/temporary-worktrees.ts"
    );
    const result = await createTemporaryWorktrees({
      workspaceDir,
      parentRepo,
      slugs,
      dryRun: args["--dry-run"] ?? false,
      force: args["--force"] ?? false,
      ...(template?.config.disableInitializers !== undefined
        ? { disabledInitializers: template.config.disableInitializers }
        : {}),
    });

    if (args["--dry-run"]) {
      console.log("\nDry run - no changes will be made\n");
      for (const worktree of result.created) {
        console.log(`Slug: ${worktree.slug}`);
        console.log(`Repository: ${worktree.parentRepo}`);
        console.log(`Branch: ${worktree.branch}`);
        console.log(`Target: ${worktree.path}`);
        console.log();
      }
      return;
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
      process.exitCode = 1;
    }
  } catch (error) {
    log.error(getErrorMessage(error));
    process.exitCode = 1;
  }
}

async function runTemporaryWorktreeList(args: {
  _: string[];
  "--repo"?: string;
}): Promise<void> {
  const extra = args._.slice(1);
  if (extra.length > 0) {
    log.error("Usage: wf worktree list [--repo <repo>]");
    process.exitCode = 1;
    return;
  }

  const workspaceDir = await detectWorkspaceFromCwd();
  if (!workspaceDir) {
    log.error("Not inside a workspace.");
    process.exitCode = 1;
    return;
  }

  const metadata = await readWorkspaceMetadata(workspaceDir);
  if (!metadata) {
    log.error(`Could not read workspace metadata from ${workspaceDir}`);
    process.exitCode = 1;
    return;
  }

  let parentRepoName: string | undefined;
  try {
    parentRepoName =
      args["--repo"] ??
      resolveWorkspaceRepoNameFromCwd({
        workspaceDir,
        metadata,
        cwd: process.cwd(),
        allowTemporaryWorktree: true,
      });
  } catch (error) {
    log.error(getErrorMessage(error));
    process.exitCode = 1;
    return;
  }

  const { listTemporaryWorktrees } = await import(
    "./workspace/temporary-worktrees.ts"
  );
  const entries = await listTemporaryWorktrees(workspaceDir, parentRepoName);

  if (entries.length === 0) {
    log.info("No temporary worktrees found.");
    return;
  }

  console.log("\nTemporary worktrees\n");
  for (const entry of entries) {
    const merged =
      entry.merged === null ? "unknown" : entry.merged ? "yes" : "no";
    console.log(`  ${entry.slug}`);
    console.log(`    repo:   ${entry.parent_repo}`);
    console.log(`    branch: ${entry.branch}`);
    console.log(`    status: ${entry.state}, merged: ${merged}`);
    console.log(`    path:   ${entry.absolutePath}`);
  }
  console.log();
}

async function runTemporaryWorktreeRemove(args: {
  _: string[];
  "--repo"?: string;
  "--dry-run"?: boolean;
  "--force"?: boolean;
}): Promise<void> {
  const slugs = args._.slice(1);
  if (slugs.length === 0) {
    log.error("Usage: wf worktree rm <slug...> [--repo <repo>] [--dry-run]");
    process.exitCode = 1;
    return;
  }

  const workspaceDir = await detectWorkspaceFromCwd();
  if (!workspaceDir) {
    log.error("Not inside a workspace.");
    process.exitCode = 1;
    return;
  }

  const metadata = await readWorkspaceMetadata(workspaceDir);
  if (!metadata) {
    log.error(`Could not read workspace metadata from ${workspaceDir}`);
    process.exitCode = 1;
    return;
  }

  let parentRepoName: string | undefined;
  try {
    parentRepoName =
      args["--repo"] ??
      resolveWorkspaceRepoNameFromCwd({
        workspaceDir,
        metadata,
        cwd: process.cwd(),
        allowTemporaryWorktree: true,
      });
  } catch (error) {
    log.error(getErrorMessage(error));
    process.exitCode = 1;
    return;
  }

  try {
    const { removeTemporaryWorktrees } = await import(
      "./workspace/temporary-worktrees.ts"
    );
    const result = await removeTemporaryWorktrees({
      workspaceDir,
      slugs,
      dryRun: args["--dry-run"] ?? false,
      force: args["--force"] ?? false,
      ...(parentRepoName ? { parentRepoName } : {}),
    });

    for (const entry of result.removed) {
      const action = args["--dry-run"] ? "Would remove" : "Removed";
      log.success(`${action} ${entry.parent_repo}-${entry.slug}`);
    }
  } catch (error) {
    log.error(getErrorMessage(error));
    process.exitCode = 1;
  }
}

async function runCdCommand(argv: string[]): Promise<void> {
  const args = arg(
    {
      "--help": Boolean,
      "-h": "--help",
    },
    { argv },
  );

  if (args["--help"]) {
    console.log(await help());
    return;
  }

  const interactive = isInteractive();
  let workspaceDir: string | null = null;

  try {
    if (args._[0]) {
      workspaceDir = await resolveWorkspaceByName(args._[0]);
      if (!workspaceDir) {
        process.exitCode = 1;
        return;
      }
    } else if (interactive) {
      workspaceDir = await selectWorkspaceInteractive(
        "Select workspace to open",
      );
      if (!workspaceDir) {
        cancel("Cancelled");
        return;
      }
    } else {
      log.error("Missing workspace name. Usage: wf cd <name>");
      process.exitCode = 1;
      return;
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
  } catch (error) {
    log.error(getErrorMessage(error));
    process.exitCode = 1;
  }
}

async function runFindCommand(argv: string[]): Promise<void> {
  const args = arg(
    {
      "--help": Boolean,
      "-h": "--help",
    },
    { argv },
  );

  if (args["--help"]) {
    console.log(await help());
    return;
  }

  if (args._.length > 0) {
    log.error("Usage: wf find");
    process.exitCode = 1;
    return;
  }

  if (!isInteractive()) {
    log.error("wf find requires an interactive terminal");
    process.exitCode = 1;
    return;
  }

  try {
    const workspaceDir = await selectWorkspaceFuzzy("Find workspace");
    if (workspaceDir === undefined) {
      process.exitCode = 1;
      return;
    }

    if (workspaceDir === null) {
      cancel("Cancelled");
      return;
    }

    await writeShellCdPath(workspaceDir);

    if (!isShellAutoCdEnabled()) {
      promptLog.info(`Run: cd ${workspaceDir}`);
    }
  } catch (error) {
    log.error(getErrorMessage(error));
    process.exitCode = 1;
  }
}

async function runTemplateCommand(argv: string[]): Promise<void> {
  const subcommand = argv[0];
  const subArgv = argv.slice(1);

  switch (subcommand) {
    case "--help":
    case "-h":
      console.log(await help());
      break;
    case "list":
    case "ls":
    case undefined:
      await runTemplateList();
      break;
    case "show":
      await runTemplateShow(subArgv);
      break;
    case "info":
      await runTemplateInfo(subArgv);
      break;
    case "new":
    case "create":
      await runTemplateNew(subArgv);
      break;
    case "delete":
    case "rm":
      await runTemplateDelete(subArgv);
      break;
    case "edit":
      await runTemplateEdit(subArgv);
      break;
    case "copy":
    case "cp":
      await runTemplateCopy(subArgv);
      break;
    default:
      log.error(`Unknown template subcommand: ${subcommand}`);
      log.info("Available: list, show, info, new, edit, delete, copy");
      process.exitCode = 1;
  }
}

async function runTemplateList(): Promise<void> {
  const templates = await listTemplates();

  if (templates.length === 0) {
    log.info("No templates configured.");
    log.info(`Templates directory: ${getTemplatesDir()}`);
    return;
  }

  console.log("\nTemplates:\n");
  for (const template of templates) {
    const desc =
      template.config.description ?? template.config.repos.join(", ");
    console.log(`  ${template.id.padEnd(20)} ${desc}`);
  }
  console.log();
}

async function runTemplateShow(argv: string[]): Promise<void> {
  const templateId = argv[0];

  if (!templateId) {
    log.error("Missing template name. Usage: workforest template show <name>");
    process.exitCode = 1;
    return;
  }

  const template = await loadTemplate(templateId);
  if (!template) {
    log.error(`Template "${templateId}" not found.`);
    const templates = await listTemplates();
    if (templates.length > 0) {
      log.info(`Available: ${templates.map((t) => t.id).join(", ")}`);
    }
    process.exitCode = 1;
    return;
  }

  const templateDir = path.dirname(template.path);
  await writeShellCdPath(templateDir);

  if (!isShellAutoCdEnabled()) {
    log.info(`Run: cd ${templateDir}`);
  }
}

async function runTemplateInfo(argv: string[]): Promise<void> {
  const templateId = argv[0];

  if (!templateId) {
    log.error("Missing template name. Usage: workforest template info <name>");
    process.exitCode = 1;
    return;
  }

  const template = await loadTemplate(templateId);
  if (!template) {
    log.error(`Template "${templateId}" not found.`);
    const templates = await listTemplates();
    if (templates.length > 0) {
      log.info(`Available: ${templates.map((t) => t.id).join(", ")}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`\nTemplate: ${template.id}\n`);

  if (template.config.description) {
    console.log(`Description: ${template.config.description}`);
  }

  console.log(`\nRepositories:`);
  for (const repo of template.config.repos) {
    console.log(`  - ${repo}`);
  }

  if (template.config.hooks && template.config.hooks.length > 0) {
    console.log(`\nHooks:`);
    for (const hook of template.config.hooks) {
      console.log(`  - ${hook.name}: ${hook.run}`);
      if (hook.in) {
        console.log(`    (runs in: ${hook.in})`);
      }
    }
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
  console.log(`\nBranch prefix: ${branchPrefixSummary}`);

  const filesDir = path.join(path.dirname(template.path), "files");
  if (await pathExists(filesDir)) {
    console.log(`Files: ${filesDir}`);
  }

  console.log(`\nLocation: ${template.path}`);
  console.log();
}

async function runTemplateNew(argv: string[]): Promise<void> {
  const args = arg(
    {
      "--description": String,
      "-d": "--description",
    },
    { argv, permissive: true },
  );

  // First positional arg is template name, rest are repos
  let templateId = args._[0];
  let repos = args._.slice(1);

  if (!templateId) {
    if (!isInteractive()) {
      log.error(
        "Missing template name. Usage: workforest template new <name> [repo...]",
      );
      process.exitCode = 1;
      return;
    }

    templateId = await promptText("Template name", {
      validate: (input) => {
        if (!input.trim()) {
          return "Template name is required";
        }
        if (!/^[a-z0-9-]+$/.test(input.trim())) {
          return "Template name must be lowercase alphanumeric with hyphens";
        }
        return null;
      },
    });
  }

  // Check if template already exists
  const existing = await loadTemplate(templateId);
  if (existing) {
    log.error(`Template "${templateId}" already exists.`);
    process.exitCode = 1;
    return;
  }

  // If no repos provided via args, prompt for them
  if (repos.length === 0) {
    if (!isInteractive()) {
      log.error(
        "Missing repositories. Usage: workforest template new <name> <repo...>",
      );
      process.exitCode = 1;
      return;
    }

    const reposInput = await promptText(
      "Repositories (org/repo or git URL, comma-separated)",
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

  // Validate repos
  for (const repo of repos) {
    if (!isRepoSlug(repo)) {
      log.error(
        `Invalid repository format: "${repo}". Expected "org/repo" or a git URL.`,
      );
      process.exitCode = 1;
      return;
    }
  }

  // Get description from flag or prompt
  let description = args["--description"];
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
}

async function runTemplateDelete(argv: string[]): Promise<void> {
  const args = arg(
    {
      "--force": Boolean,
      "-f": "--force",
    },
    { argv },
  );

  const templateId = args._[0];

  if (!templateId) {
    log.error(
      "Missing template name. Usage: workforest template delete <name>",
    );
    process.exitCode = 1;
    return;
  }

  const template = await loadTemplate(templateId);
  if (!template) {
    log.error(`Template "${templateId}" not found.`);
    process.exitCode = 1;
    return;
  }

  // Confirm deletion unless --force is passed
  if (!args["--force"]) {
    if (!isInteractive()) {
      log.error(
        "Cannot confirm deletion in non-interactive mode. Use --force.",
      );
      process.exitCode = 1;
      return;
    }

    const confirmed = await promptConfirm(`Delete template "${templateId}"?`);
    if (!confirmed) {
      log.info("Deletion cancelled.");
      return;
    }
  }

  await deleteTemplate(templateId);
  log.success(`Template "${templateId}" deleted.`);
}

async function runTemplateEdit(argv: string[]): Promise<void> {
  const templateId = argv[0];

  if (!templateId) {
    log.error("Missing template name. Usage: workforest template edit <name>");
    process.exitCode = 1;
    return;
  }

  if (!isInteractive()) {
    log.error("Template editing requires an interactive terminal.");
    process.exitCode = 1;
    return;
  }

  const template = await loadTemplate(templateId);
  if (!template) {
    log.error(`Template "${templateId}" not found.`);
    const templates = await listTemplates();
    if (templates.length > 0) {
      log.info(`Available: ${templates.map((t) => t.id).join(", ")}`);
    }
    process.exitCode = 1;
    return;
  }

  const { config: workspaceConfig } = await loadWorkspaceConfig();
  const { renderTemplateEditor } = await import("./ui/index.ts");

  await renderTemplateEditor({
    templateId,
    initialConfig: template.config,
    workspaceConfig,
    onSave: async (config) => {
      await createTemplate(templateId, config);
      log.success(`Template "${templateId}" saved.`);
    },
  });
}

async function runTemplateCopy(argv: string[]): Promise<void> {
  const sourceId = argv[0];
  const destId = argv[1];

  if (!sourceId || !destId) {
    log.error("Usage: workforest template copy <source> <destination>");
    process.exitCode = 1;
    return;
  }

  // Load source template
  const sourceTemplate = await loadTemplate(sourceId);
  if (!sourceTemplate) {
    log.error(`Source template "${sourceId}" not found.`);
    const templates = await listTemplates();
    if (templates.length > 0) {
      log.info(`Available: ${templates.map((t) => t.id).join(", ")}`);
    }
    process.exitCode = 1;
    return;
  }

  // Check destination doesn't exist
  const destTemplate = await loadTemplate(destId);
  if (destTemplate) {
    log.error(`Template "${destId}" already exists.`);
    process.exitCode = 1;
    return;
  }

  // Create the copy
  await createTemplate(destId, sourceTemplate.config);
  log.success(`Template "${sourceId}" copied to "${destId}".`);
}

async function runCleanCommand(argv: string[]): Promise<void> {
  const args = arg(
    {
      "--help": Boolean,
      "--dry-run": Boolean,
      "--force": Boolean,
      "--keep-mirrors": Boolean,
      "--delete-remote-branches": Boolean,
      "-h": "--help",
      "-n": "--dry-run",
      "-f": "--force",
      "-r": "--delete-remote-branches",
    },
    { argv },
  );

  if (args["--help"]) {
    console.log(await help());
    return;
  }

  const interactive = isInteractive();
  const initialCwd = process.cwd();
  let workspaceDir = args._[0];
  let isInsideWorkspace = false;

  // Determine workspace directory
  if (!workspaceDir) {
    // First: check if we're inside a workspace (self-destruct mode)
    const detectedWorkspace = await detectWorkspaceFromCwd();

    if (detectedWorkspace) {
      workspaceDir = detectedWorkspace;
      isInsideWorkspace = true;
    } else if (interactive) {
      // Not in a workspace, offer interactive selection
      const selected = await selectWorkspaceInteractive(
        "Select workspace to clean",
      );
      if (!selected) {
        cancel("Cancelled");
        return;
      }
      workspaceDir = selected;
    } else {
      log.error("No workspace path specified and not inside a workspace.");
      process.exitCode = 1;
      return;
    }
  }

  // Check if user is inside the workspace (even if they specified a path)
  if (!isInsideWorkspace) {
    const resolvedWorkspace = path.resolve(workspaceDir);
    const cwd = initialCwd;
    isInsideWorkspace =
      cwd === resolvedWorkspace || cwd.startsWith(`${resolvedWorkspace}/`);
  }

  const dryRun = args["--dry-run"] ?? false;
  const force = args["--force"] ?? false;
  const keepMirrors = args["--keep-mirrors"] ?? true;
  let deleteRemoteBranches = args["--delete-remote-branches"] ?? false;

  // Validate workspace first
  try {
    await validateWorkspace(workspaceDir);
  } catch (error) {
    log.error(getErrorMessage(error));
    process.exitCode = 1;
    return;
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
    log.info(`Workspace: ${preview.workspaceDir}`);
    log.info(`Repositories: ${preview.repos.join(", ")}`);
    if (preview.temporaryWorktrees?.length) {
      log.info(`Temporary worktrees: ${preview.temporaryWorktrees.join(", ")}`);
    }
    if (isInsideWorkspace) {
      log.warn("You are inside the workspace being deleted");
    }
  }

  // Confirm unless --force or --dry-run
  if (!force && !dryRun) {
    if (!interactive) {
      log.error("Cannot confirm in non-interactive mode. Use --force.");
      process.exitCode = 1;
      return;
    }

    const confirmed = await promptConfirm(
      "This will delete the workspace directory. Continue?",
      false,
    );
    if (!confirmed) {
      cancel("Cancelled");
      return;
    }

    // If -r flag not set, prompt only if there are eligible merged branches
    if (!deleteRemoteBranches && preview.remoteBranches?.length) {
      const branchCount = preview.remoteBranches.length;
      const branchList = preview.remoteBranches
        .map((b) => `${b.repo}: ${b.branch}`)
        .join(", ");
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
}

function logNewUsage(): void {
  log.info("Usage: wf new <name-or-description> -- <template|repo...>");
  log.info("Example: wf new fixing auth bug -- my-template");
  log.info("Example: wf new testing feature -- vercel/next.js vercel/turbo");
}

async function runNewCommand(argv: string[]): Promise<void> {
  const delimiterIndex = argv.indexOf("--");
  const beforeDelimiter =
    delimiterIndex === -1 ? argv : argv.slice(0, delimiterIndex);
  const afterDelimiter =
    delimiterIndex === -1 ? [] : argv.slice(delimiterIndex + 1);
  let args: {
    _: string[];
    "--help"?: boolean;
    "--dry-run"?: boolean;
  };
  try {
    args = arg(
      {
        "--help": Boolean,
        "--dry-run": Boolean,
        "-h": "--help",
        "-n": "--dry-run",
      },
      { argv: beforeDelimiter },
    );
  } catch (error) {
    log.error(getErrorMessage(error));
    logNewUsage();
    process.exitCode = 1;
    return;
  }

  if (args["--help"]) {
    console.log(await help());
    return;
  }

  const interactive = isInteractive();
  let selections = afterDelimiter;
  let featureName: string | undefined;
  let description: string | undefined;
  let templateBranchPrefix: string | undefined;

  // Load config
  let config: WorkspaceConfig;
  try {
    ({ config } = await loadWorkspaceConfig());
  } catch (error) {
    if (interactive) cancel("Configuration error");
    log.error(getErrorMessage(error));
    process.exitCode = 1;
    return;
  }

  if (delimiterIndex === -1) {
    if (args._.length === 0) {
      if (!interactive) {
        log.error("Missing name/description and repositories.");
        logNewUsage();
        process.exitCode = 1;
        return;
      }

      const { shouldUseGrid } = await import("./ui/grid-consumer.ts");
      if (shouldUseGrid()) {
        const { runNewWizard } = await import("./ui/new-wizard.ts");
        const templates = await listTemplates();
        const wizardResult = await runNewWizard({
          config,
          templates,
          handleTemplateManagement,
        });
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
        if (!selected) return;
        selections = selected;
      }
    } else {
      log.error('Missing "--" delimiter before repositories.');
      logNewUsage();
      process.exitCode = 1;
      return;
    }
  } else {
    const workText = args._.join(" ").trim();
    if (!workText) {
      log.error('Missing name or description before "--".');
      logNewUsage();
      process.exitCode = 1;
      return;
    }

    if (!interactive) {
      if (selections.length === 0) {
        log.error('Missing template or repositories after "--".');
        logNewUsage();
        process.exitCode = 1;
        return;
      }
    } else if (selections.length === 0) {
      log.error('Missing template or repositories after "--".');
      logNewUsage();
      process.exitCode = 1;
      return;
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
    const resolved = await resolveSelections(selections);
    repos = resolved.repos;
    templateId = resolved.templateId;
    if (templateBranchPrefix === undefined) {
      templateBranchPrefix = resolved.templateBranchPrefix;
    }
  } catch (error) {
    if (interactive) cancel("Failed to resolve repositories");
    log.error(getErrorMessage(error));
    process.exitCode = 1;
    return;
  }

  // Get feature name (skip if delimiter or wizard already provided it)
  if (!featureName) {
    if (!interactive) {
      log.error("Missing name or description.");
      logNewUsage();
      process.exitCode = 1;
      return;
    }

    const result = await promptForFeatureName();
    if (!result) return;
    featureName = result.featureName;
    description = result.description;
  }

  // Build paths
  const workspaceRoot = config.defaultDir
    ? path.resolve(expandHome(config.defaultDir))
    : process.cwd();
  const prefix = config.dirPrefix ?? "";
  const workspaceDir = path.resolve(workspaceRoot, `${prefix}${featureName}`);
  const branchName = buildBranchName(
    featureName,
    resolveBranchPrefix(config.branchPrefix, templateBranchPrefix),
  );

  // Dry-run mode
  if (args["--dry-run"]) {
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
      console.log("\nDry run - no changes will be made\n");
      console.log("Workspace:");
      console.log(`  Directory: ${workspaceDir}`);
      console.log(`  Feature: ${featureName}`);
      if (description) {
        console.log(`  Description: ${description}`);
      }
      console.log(`  Branch: ${branchName}`);
      if (templateId) {
        console.log(`  Template: ${templateId}`);
      }
      console.log("\nRepositories:");
      for (const repo of repos) {
        console.log(`  - ${repo.name} (${repo.remote})`);
      }
      console.log();
    }
    return;
  }

  // Stamp workspace
  const options = {
    featureName,
    branchName,
    workspaceDir,
    repos,
    ...(description && { description }),
    ...(templateId && { templateId }),
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
}

async function runAddCommand(argv: string[]): Promise<void> {
  const args = arg(
    {
      "--help": Boolean,
      "--workspace": String,
      "--dry-run": Boolean,
      "-h": "--help",
      "-w": "--workspace",
      "-n": "--dry-run",
    },
    { argv },
  );

  if (args["--help"]) {
    console.log(await help());
    return;
  }

  const interactive = isInteractive();
  let selections = args._;

  if (selections.length === 0) {
    if (!interactive) {
      log.error("No repositories specified.");
      log.info("Usage: wf add <repo...> [--workspace <dir>]");
      process.exitCode = 1;
      return;
    }

    const repos = await promptText("Repositories to add", {
      placeholder: "org/repo or git URL, comma-separated",
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

  const workspaceDir = args["--workspace"]
    ? path.resolve(expandHome(args["--workspace"]))
    : await detectWorkspaceFromCwd();

  if (!workspaceDir) {
    log.error(
      "Not inside a workspace. Run this command from a workspace or pass --workspace <dir>.",
    );
    process.exitCode = 1;
    return;
  }

  let metadata: Awaited<ReturnType<typeof readWorkspaceMetadata>>;
  try {
    metadata = await readWorkspaceMetadata(workspaceDir);
  } catch (error) {
    log.error(getErrorMessage(error));
    process.exitCode = 1;
    return;
  }

  if (!metadata) {
    log.error(`Could not read workspace metadata from ${workspaceDir}`);
    process.exitCode = 1;
    return;
  }

  let repos: RepoConfig[];
  try {
    repos = reposFromSlugs(selections);
  } catch (error) {
    log.error(getErrorMessage(error));
    process.exitCode = 1;
    return;
  }

  const branchName =
    metadata.repos.find((repo) => repo.feature_branch)?.feature_branch ??
    metadata.workspace.feature_name;

  if (args["--dry-run"]) {
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
      console.log("\nDry run - no changes will be made\n");
      console.log(`Workspace: ${workspaceDir}`);
      console.log(`Branch: ${branchName}`);
      console.log("\nRepositories to add:");
      for (const repo of repos) {
        console.log(`  - ${repo.name} (${repo.remote})`);
      }
      console.log();
    }
    return;
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
    });

    if (result.addedRepos.length > 0) {
      log.success(
        `Added ${result.addedRepos.length} repos to ${path.basename(workspaceDir)}.`,
      );
    }

    if (result.failedRepos.length > 0) {
      process.exitCode = 1;
      log.error(
        `Failed to add ${result.failedRepos.length} repo${result.failedRepos.length === 1 ? "" : "s"}.`,
      );
      return;
    }

    if (interactive) {
      outro("Workspace updated");
    }
  } catch (error) {
    log.error(getErrorMessage(error));
    process.exitCode = 1;
  }
}

async function runForkCommand(argv: string[]): Promise<void> {
  const args = arg(
    {
      "--help": Boolean,
      "--description": String,
      "--dry-run": Boolean,
      "-h": "--help",
      "-d": "--description",
      "-n": "--dry-run",
    },
    { argv },
  );

  if (args["--help"]) {
    console.log(await help());
    return;
  }

  const interactive = isInteractive();

  // Must be inside a workspace
  const sourceDir = await detectWorkspaceFromCwd();
  if (!sourceDir) {
    log.error(
      "Not inside a workspace. Run this command from within an existing workspace.",
    );
    process.exitCode = 1;
    return;
  }

  const metadata = await readWorkspaceMetadata(sourceDir);
  if (!metadata) {
    log.error(`Could not read workspace metadata from ${sourceDir}`);
    process.exitCode = 1;
    return;
  }

  if (interactive && args._.length === 0) {
    intro("Fork workspace");
  }

  // Get feature name from positional arg, --description, or interactive prompt
  let featureName: string;
  let description: string | undefined;

  if (args._.length > 0) {
    const input = args._[0];
    if (input === undefined) {
      throw new Error("Expected a feature name.");
    }
    if (isSlug(input)) {
      featureName = input;
    } else {
      description = input;
      const generated = await generateSlugFromDescription(input);
      featureName = generated ?? sanitizeToSlug(input);
    }
  } else if (args["--description"]) {
    const input = args["--description"];
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
  } else {
    if (!interactive) {
      log.error(
        "Missing name or --description argument (required in non-interactive mode).",
      );
      log.info("Usage: wf fork <name>");
      log.info("Example: wf fork new-approach");
      process.exitCode = 1;
      return;
    }

    const result = await promptForFeatureName();
    if (!result) return;
    featureName = result.featureName;
    description = result.description;
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
  const workspaceDir = path.join(
    path.dirname(sourceDir),
    `${dirPrefix}${featureName}`,
  );

  const templateId = metadata.workspace.template_id;

  // Dry-run mode
  if (args["--dry-run"]) {
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
      console.log("\nDry run - no changes will be made\n");
      console.log(`Source workspace: ${path.basename(sourceDir)}`);
      console.log("New workspace:");
      console.log(`  Directory: ${workspaceDir}`);
      console.log(`  Feature: ${featureName}`);
      if (description) {
        console.log(`  Description: ${description}`);
      }
      console.log(`  Branch: ${branchName}`);
      if (templateId) {
        console.log(`  Template: ${templateId}`);
      }
      console.log("\nRepositories:");
      for (const repo of repos) {
        console.log(`  - ${repo.name} (${repo.remote})`);
      }
      console.log();
    }
    return;
  }

  // Stamp workspace
  const options = {
    featureName,
    branchName,
    workspaceDir,
    repos,
    ...(description && { description }),
    ...(templateId && { templateId }),
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

type ResolvedSelections = {
  repos: RepoConfig[];
  templateId?: string;
  templateBranchPrefix?: string;
};

/**
 * Resolve positional arguments to repos.
 * Arguments containing "/" are treated as org/repo slugs.
 * Other arguments are treated as template names.
 */
async function resolveSelections(
  selections: string[],
): Promise<ResolvedSelections> {
  const repoSlugs: string[] = [];
  let templateId: string | undefined;
  let templateBranchPrefix: string | undefined;

  for (const selection of selections) {
    if (isRepoSlug(selection)) {
      repoSlugs.push(selection);
    } else {
      // It's a template name
      const template = await loadTemplate(selection);
      if (!template) {
        const templates = await listTemplates();
        const available = templates.map((t) => t.id).join(", ");
        const suffix = available
          ? `Available templates: ${available}`
          : "No templates configured.";
        throw new Error(`Unknown template "${selection}". ${suffix}`);
      }
      templateId = template.id;
      templateBranchPrefix = template.config.branchPrefix;
      repoSlugs.push(...template.config.repos);
    }
  }

  if (repoSlugs.length === 0) {
    throw new Error(
      "No repositories specified. Provide template names or org/repo arguments.",
    );
  }

  return {
    repos: reposFromSlugs(repoSlugs),
    ...(templateId && { templateId }),
    ...(templateBranchPrefix !== undefined && { templateBranchPrefix }),
  };
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
 * Validate template name format (lowercase alphanumeric with hyphens).
 */
function validateTemplateName(input: string): string | undefined {
  if (!input.trim()) {
    return "Template name is required";
  }
  if (!/^[a-z0-9-]+$/.test(input.trim())) {
    return "Template name must be lowercase alphanumeric with hyphens";
  }
  return undefined;
}

/**
 * Interactive flow to create a new template.
 * Returns the new template ID if successful, null if cancelled.
 */
async function wizardCreateTemplate(): Promise<string | null> {
  try {
    const templateId = await promptText("Template name", {
      placeholder: "my-template",
      validate: (input) => validateTemplateName(input) ?? null,
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
        await createTemplate(templateId, config);
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

    const { config: workspaceConfig } = await loadWorkspaceConfig();
    const { renderTemplateEditor } = await import("./ui/index.ts");

    let savedTemplateId: string | null = null;

    await renderTemplateEditor({
      templateId: template.id,
      initialConfig: template.config,
      workspaceConfig,
      onSave: async (config) => {
        await createTemplate(template.id, config);
        savedTemplateId = template.id;
      },
    });

    return savedTemplateId;
  } catch (e) {
    if (e instanceof CancelError) return null;
    throw e;
  }
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

    const newTemplateId = await promptText("New template name", {
      placeholder: `${sourceTemplate.id}-copy`,
      validate: (input) => validateTemplateName(input) ?? null,
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
        await createTemplate(newTemplateId, config);
        savedTemplateId = newTemplateId;
      },
    });

    return savedTemplateId;
  } catch (e) {
    if (e instanceof CancelError) return null;
    throw e;
  }
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
          placeholder: "org/repo or git URL, comma-separated",
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
          placeholder: "org/repo or git URL, comma-separated",
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
  allowTemporaryWorktree,
}: {
  workspaceDir: string;
  metadata: WorkspaceMetadata;
  repoName: string | undefined;
  cwd: string;
  allowTemporaryWorktree: boolean;
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
    allowTemporaryWorktree,
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
  allowTemporaryWorktree,
}: {
  workspaceDir: string;
  metadata: WorkspaceMetadata;
  cwd: string;
  allowTemporaryWorktree: boolean;
}): string | undefined {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedCwd = path.resolve(cwd);

  for (const repo of metadata.repos) {
    const repoDir = path.join(resolvedWorkspaceDir, repo.name);
    if (isPathInsideOrEqual(resolvedCwd, repoDir)) {
      return repo.name;
    }
  }

  if (allowTemporaryWorktree) {
    for (const entry of metadata.temporary_worktrees ?? []) {
      const worktreeDir = path.join(resolvedWorkspaceDir, entry.path);
      if (isPathInsideOrEqual(resolvedCwd, worktreeDir)) {
        return entry.parent_repo;
      }
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
        workspaces.push({
          name: entry,
          path: entryPath,
          created: metadata.workspace.created_at,
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

  return workspaces;
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
    const candidatePath = path.join(workspaceRoot, candidateName);
    try {
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
        description: `${ws.repoCount} repo${ws.repoCount !== 1 ? "s" : ""}${ws.template ? ` (${ws.template})` : ""}`,
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
        description: `${ws.repoCount} repo${ws.repoCount !== 1 ? "s" : ""}${ws.template ? ` (${ws.template})` : ""}`,
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

  if (preview.temporaryWorktrees && preview.temporaryWorktrees.length > 0) {
    lines.push(`Temporary worktrees: ${preview.temporaryWorktrees.join(", ")}`);
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
