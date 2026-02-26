import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
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
} from "./types.ts";
import { isInteractive, promptConfirm, promptText } from "./utils/prompts.ts";
import { generateSlugFromDescription, isSlug } from "./utils/slug.ts";
import {
  type CleanupPreview,
  cleanupWorkspace,
  previewCleanup,
  validateWorkspace,
} from "./workspace/cleanup.ts";
import { stampWorkspace } from "./workspace/index.ts";
import { readWorkspaceMetadata } from "./workspace/metadata.ts";

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
    case "clean":
      await runCleanCommand(commandArgv);
      break;
    case "config":
      await runConfigCommand(commandArgv);
      break;
    case "template":
      await runTemplateCommand(commandArgv);
      break;
    case "fork":
      await runForkCommand(commandArgv);
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

  const newConfig = {
    ...config,
    defaultDir: defaultDir || undefined,
    dirPrefix: dirPrefix || undefined,
    branchPrefix: branchPrefix || undefined,
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
          description: metadata.workspace.description,
          template: metadata.workspace.template_id,
          branch: metadata.repos[0]?.feature_branch,
          created: metadata.workspace.created_at,
          repos: metadata.repos.length,
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
      log.info("Available: list, show, new, edit, delete, copy");
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

  if (template.config.branchPrefix) {
    console.log(`\nBranch prefix: ${template.config.branchPrefix}`);
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
    description = await promptText("Description (optional)");
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

  const { renderTemplateEditor } = await import("./ui/index.ts");

  await renderTemplateEditor({
    templateId,
    initialConfig: template.config,
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
      const selected = await selectWorkspaceInteractive();
      if (!selected) {
        p.cancel("Cancelled");
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
    const cwd = process.cwd();
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
      p.log.warn("You are inside the workspace being deleted");
    }
  } else {
    log.info(`Workspace: ${preview.workspaceDir}`);
    log.info(`Repositories: ${preview.repos.join(", ")}`);
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
      p.cancel("Cancelled");
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
    const parentDir = path.dirname(path.resolve(workspaceDir));
    if (interactive) {
      p.log.info(`Workspace deleted. Run: cd ${parentDir}`);
    } else {
      log.info(`Workspace deleted. Run: cd ${parentDir}`);
    }
  }
}

async function runNewCommand(argv: string[]): Promise<void> {
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
  let selections = args._;

  // Interactive mode with intro framing
  if (interactive && selections.length === 0) {
    p.intro("Create a new workspace");
  }

  // Load config
  let config: WorkspaceConfig;
  try {
    ({ config } = await loadWorkspaceConfig());
  } catch (error) {
    if (interactive) p.cancel("Configuration error");
    log.error(getErrorMessage(error));
    process.exitCode = 1;
    return;
  }

  // Prompt for template/repos if not provided
  if (selections.length === 0) {
    if (!interactive) {
      log.error("No template or repositories specified.");
      log.info('Usage: wf new <template|repo...> -d "description"');
      log.info('Example: wf new my-template -d "fixing auth bug"');
      log.info(
        'Example: wf new vercel/next.js vercel/turbo -d "testing feature"',
      );
      process.exitCode = 1;
      return;
    }

    const selected = await promptForTemplateOrRepos();
    if (!selected) return;
    selections = selected;
  }

  // Resolve to repos
  let repos: RepoConfig[];
  let templateId: string | undefined;
  let templateBranchPrefix: string | undefined;

  try {
    const resolved = await resolveSelections(selections);
    repos = resolved.repos;
    templateId = resolved.templateId;
    templateBranchPrefix = resolved.templateBranchPrefix;
  } catch (error) {
    if (interactive) p.cancel("Failed to resolve repositories");
    log.error(getErrorMessage(error));
    process.exitCode = 1;
    return;
  }

  // Get feature name
  let featureName: string;
  let description: string | undefined;

  if (args["--description"]) {
    const input = args["--description"];
    if (isSlug(input)) {
      featureName = input;
    } else {
      description = input;
      // Show spinner for AI generation in interactive mode
      if (interactive) {
        const s = p.spinner();
        s.start("Generating feature name...");
        const generated = await generateSlugFromDescription(input);
        s.stop("Feature name ready");
        featureName = generated ?? sanitizeToSlug(input);
      } else {
        const generated = await generateSlugFromDescription(input);
        featureName = generated ?? sanitizeToSlug(input);
      }
    }
  } else {
    if (!interactive) {
      log.error(
        "Missing --description argument (required in non-interactive mode).",
      );
      log.info('Usage: wf new <template|repo...> -d "description"');
      log.info('Example: wf new my-template -d "fixing auth bug"');
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
  const effectiveBranchPrefix = templateBranchPrefix ?? config.branchPrefix;
  const branchName = effectiveBranchPrefix
    ? `${effectiveBranchPrefix}${featureName}`
    : featureName;

  // Dry-run mode
  if (args["--dry-run"]) {
    if (interactive) {
      p.note(
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
      p.outro("No changes made");
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
    const { stampWorkspaceInteractive } = await import("./workspace/index.ts");
    await stampWorkspaceInteractive(options);
    p.outro("Happy shipping!");
  } else {
    await stampWorkspace(options);
    log.info("Happy shipping!");
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
    p.intro("Fork workspace");
  }

  // Get feature name from positional arg, --description, or interactive prompt
  let featureName: string;
  let description: string | undefined;

  if (args._.length > 0) {
    const input = args._[0];
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
        const s = p.spinner();
        s.start("Generating feature name...");
        const generated = await generateSlugFromDescription(input);
        s.stop("Feature name ready");
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
  const branchPrefix = inferBranchPrefix(metadata);
  const dirPrefix = inferDirPrefix(sourceDir, metadata.workspace.feature_name);
  const branchName = branchPrefix
    ? `${branchPrefix}${featureName}`
    : featureName;

  // Build new workspace as a sibling of the source
  const workspaceDir = path.join(
    path.dirname(sourceDir),
    `${dirPrefix}${featureName}`,
  );

  const templateId = metadata.workspace.template_id;

  // Dry-run mode
  if (args["--dry-run"]) {
    if (interactive) {
      p.note(
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
      p.outro("No changes made");
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
    p.outro("Happy shipping!");
  } else {
    await stampWorkspace(options);
    log.info("Happy shipping!");
  }
}

/**
 * Extract the branch prefix by comparing feature_branch to feature_name.
 * E.g. branch "td/fix-auth" with name "fix-auth" → prefix "td/".
 */
function inferBranchPrefix(metadata: WorkspaceMetadata): string {
  const { feature_name } = metadata.workspace;
  const firstRepo = metadata.repos[0];
  if (!firstRepo?.feature_branch) return "";

  const branch = firstRepo.feature_branch;
  if (branch.endsWith(feature_name)) {
    return branch.slice(0, -feature_name.length);
  }
  return "";
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
    ...(templateBranchPrefix && { templateBranchPrefix }),
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
 * Prompt user for feature name interactively using clack prompts.
 * Detects if input is a slug or prose, and generates slug if needed.
 */
async function promptForFeatureName(): Promise<FeatureNameResult | null> {
  const input = await p.text({
    message: "What are you working on?",
    placeholder: "describe your task, or enter a slug like fix-auth-bug",
    validate: (value) => {
      if (!value.trim()) return "Please describe what you're working on";
      return undefined;
    },
  });

  if (p.isCancel(input)) {
    p.cancel("Cancelled");
    return null;
  }

  const trimmed = input.trim();

  // If it's already a slug, use it directly with confirmation
  if (isSlug(trimmed)) {
    p.log.info(`Using "${trimmed}" as feature name`);
    return { featureName: trimmed };
  }

  // It's prose - generate a slug with spinner
  const s = p.spinner();
  s.start("Generating feature name...");
  const generated = await generateSlugFromDescription(trimmed);
  s.stop("Feature name ready");

  const defaultSlug = generated ?? sanitizeToSlug(trimmed);

  const featureName = await p.text({
    message: "Feature name",
    defaultValue: defaultSlug,
    validate: (value) => {
      if (!value.trim()) return "Feature name is required";
      return undefined;
    },
  });

  if (p.isCancel(featureName)) {
    p.cancel("Cancelled");
    return null;
  }

  return {
    featureName: featureName.trim(),
    description: trimmed,
  };
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
 * Show template preview and prompt for action.
 * Returns: "use" to use the template, "edit" to edit first, "back" to go back
 */
async function showTemplatePreview(
  template: NonNullable<Awaited<ReturnType<typeof loadTemplate>>>,
): Promise<"use" | "edit" | "back" | null> {
  const lines: string[] = [];

  if (template.config.description) {
    lines.push(`Description: ${template.config.description}`);
    lines.push("");
  }

  lines.push("Repositories:");
  for (const repo of template.config.repos) {
    lines.push(`  • ${repo}`);
  }

  if (template.config.hooks && template.config.hooks.length > 0) {
    lines.push("");
    lines.push("Hooks:");
    for (const hook of template.config.hooks) {
      lines.push(`  • ${hook.name}`);
    }
  }

  if (template.config.branchPrefix) {
    lines.push("");
    lines.push(`Branch prefix: ${template.config.branchPrefix}`);
  }

  p.note(lines.join("\n"), `Template: ${template.id}`);

  const action = await p.select({
    message: "What would you like to do?",
    options: [
      { value: "use" as const, label: "Use this template" },
      { value: "edit" as const, label: "Edit template first" },
      { value: "back" as const, label: "Choose different template" },
    ],
  });

  if (p.isCancel(action)) {
    return null;
  }

  return action;
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
  const templateId = await p.text({
    message: "Template name",
    placeholder: "my-template",
    validate: validateTemplateName,
  });

  if (p.isCancel(templateId)) {
    return null;
  }

  // Check if template already exists
  const existing = await loadTemplate(templateId);
  if (existing) {
    p.log.error(`Template "${templateId}" already exists.`);
    return null;
  }

  const { renderTemplateEditor } = await import("./ui/index.ts");

  let savedTemplateId: string | null = null;

  await renderTemplateEditor({
    templateId,
    initialConfig: { repos: [] },
    onSave: async (config) => {
      await createTemplate(templateId, config);
      savedTemplateId = templateId;
    },
  });

  return savedTemplateId;
}

/**
 * Interactive flow to edit an existing template.
 * Returns the template ID if saved, null if cancelled.
 */
async function wizardEditTemplate(
  templates: Awaited<ReturnType<typeof listTemplates>>,
): Promise<string | null> {
  if (templates.length === 0) {
    p.log.warn("No templates to edit.");
    return null;
  }

  const selection = await p.select({
    message: "Select template to edit",
    options: templates.map((t) => ({
      value: t.id,
      label: t.id,
      hint: formatTemplateHint(t, t.id.length),
    })),
  });

  if (p.isCancel(selection)) {
    return null;
  }

  const template = await loadTemplate(selection);
  if (!template) {
    p.log.error(`Template "${selection}" not found.`);
    return null;
  }

  const { renderTemplateEditor } = await import("./ui/index.ts");

  let savedTemplateId: string | null = null;

  await renderTemplateEditor({
    templateId: template.id,
    initialConfig: template.config,
    onSave: async (config) => {
      await createTemplate(template.id, config);
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
    p.log.warn("No templates to clone.");
    return null;
  }

  const sourceSelection = await p.select({
    message: "Select template to clone",
    options: templates.map((t) => ({
      value: t.id,
      label: t.id,
      hint: formatTemplateHint(t, t.id.length),
    })),
  });

  if (p.isCancel(sourceSelection)) {
    return null;
  }

  const sourceTemplate = await loadTemplate(sourceSelection);
  if (!sourceTemplate) {
    p.log.error(`Template "${sourceSelection}" not found.`);
    return null;
  }

  const newTemplateId = await p.text({
    message: "New template name",
    placeholder: `${sourceTemplate.id}-copy`,
    validate: validateTemplateName,
  });

  if (p.isCancel(newTemplateId)) {
    return null;
  }

  // Check if new template already exists
  const existing = await loadTemplate(newTemplateId);
  if (existing) {
    p.log.error(`Template "${newTemplateId}" already exists.`);
    return null;
  }

  const { renderTemplateEditor } = await import("./ui/index.ts");

  let savedTemplateId: string | null = null;

  await renderTemplateEditor({
    templateId: newTemplateId,
    initialConfig: sourceTemplate.config,
    onSave: async (config) => {
      await createTemplate(newTemplateId, config);
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

  const action = await p.select({
    message: "Template management",
    options,
  });

  if (p.isCancel(action)) {
    return null;
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

  return { action, newTemplateId: newTemplateId ?? undefined };
}

/**
 * Prompt user to select a template or enter repos manually using clack prompts.
 */
async function promptForTemplateOrRepos(): Promise<string[] | null> {
  // Main loop to allow returning from template management
  while (true) {
    const templates = await listTemplates();

    type SelectionValue =
      | { type: "template"; id: string }
      | { type: "custom" }
      | { type: "manage" };

    // If no templates, offer to create one first
    if (templates.length === 0) {
      const createFirst = await p.confirm({
        message: "No templates found. Create one now?",
        initialValue: true,
      });

      if (p.isCancel(createFirst)) {
        p.cancel("Cancelled");
        return null;
      }

      if (createFirst) {
        const newTemplateId = await wizardCreateTemplate();
        if (newTemplateId) {
          p.log.success(`Template "${newTemplateId}" created.`);
          // Loop back to show templates
          continue;
        }
        // If cancelled, fall through to manual entry
      }

      // Manual entry
      const repos = await p.text({
        message: "Repositories",
        placeholder: "org/repo or git URL, comma-separated",
        validate: (input) => {
          if (!input.trim()) return "At least one repository is required";
          return undefined;
        },
      });

      if (p.isCancel(repos)) {
        p.cancel("Cancelled");
        return null;
      }

      return repos
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);
    }

    // Build options for select
    const options: { value: SelectionValue; label: string; hint?: string }[] =
      templates.map((t) => ({
        value: { type: "template", id: t.id },
        label: t.id,
        hint: formatTemplateHint(t, t.id.length),
      }));

    options.push({
      value: { type: "manage" },
      label: "Manage templates...",
      hint: "Create, edit, or clone",
    });

    options.push({
      value: { type: "custom" },
      label: "Enter repositories manually",
    });

    const selection = await p.select({
      message: "Select workspace setup",
      options,
    });

    if (p.isCancel(selection)) {
      p.cancel("Cancelled");
      return null;
    }

    if (selection.type === "manage") {
      const result = await handleTemplateManagement(templates);
      if (result === null) {
        p.cancel("Cancelled");
        return null;
      }
      if (result.newTemplateId) {
        p.log.success(`Template "${result.newTemplateId}" saved.`);
      }
      // Loop back to show updated template list
      continue;
    }

    if (selection.type === "custom") {
      const repos = await p.text({
        message: "Repositories",
        placeholder: "org/repo or git URL, comma-separated",
        validate: (input) => {
          if (!input.trim()) return "At least one repository is required";
          return undefined;
        },
      });

      if (p.isCancel(repos)) {
        p.cancel("Cancelled");
        return null;
      }

      return repos
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);
    }

    // Template selected - show preview
    const template = await loadTemplate(selection.id);
    if (!template) {
      p.log.error(`Template "${selection.id}" not found.`);
      continue;
    }

    const action = await showTemplatePreview(template);

    if (action === null) {
      p.cancel("Cancelled");
      return null;
    }

    if (action === "back") {
      // Loop back to selection
      continue;
    }

    if (action === "edit") {
      const { renderTemplateEditor } = await import("./ui/index.ts");
      let saved = false;

      await renderTemplateEditor({
        templateId: template.id,
        initialConfig: template.config,
        onSave: async (config) => {
          await createTemplate(template.id, config);
          saved = true;
        },
      });

      if (!saved) {
        // Cancelled, go back to selection
        continue;
      }

      p.log.success(`Template "${template.id}" updated.`);
    }

    // Use the template
    return [selection.id];
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
 * Walks up the directory tree looking for a .workforest file.
 * Returns the workspace directory path if found, null otherwise.
 */
async function detectWorkspaceFromCwd(): Promise<string | null> {
  let dir = process.cwd();

  while (dir !== path.dirname(dir)) {
    const metadataPath = path.join(dir, ".workforest");
    try {
      await fs.stat(metadataPath);
      return dir;
    } catch {
      // Not found, continue up
    }
    dir = path.dirname(dir);
  }
  return null;
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
          description: metadata.workspace.description,
          template: metadata.workspace.template_id,
          created: metadata.workspace.created_at,
          repoCount: metadata.repos.length,
        });
      }
    } catch {
      // Skip entries that can't be read
    }
  }

  return workspaces;
}

/**
 * Interactive workspace selection using @clack/prompts.
 * Returns the selected workspace path, or null if cancelled.
 */
async function selectWorkspaceInteractive(): Promise<string | null> {
  const { config } = await loadWorkspaceConfig();

  if (!config.defaultDir) {
    p.log.error(
      "No defaultDir configured. Specify workspace path or run: wf config init",
    );
    return null;
  }

  const workspaceRoot = path.resolve(expandHome(config.defaultDir));
  const workspaces = await findWorkspaces(workspaceRoot);

  if (workspaces.length === 0) {
    p.log.info(`No workspaces found in ${workspaceRoot}`);
    return null;
  }

  const selection = await p.select({
    message: "Select workspace to clean",
    options: workspaces.map((ws) => ({
      value: ws.path,
      label: ws.name,
      hint: `${ws.repoCount} repo${ws.repoCount !== 1 ? "s" : ""}${ws.template ? ` (${ws.template})` : ""}`,
    })),
  });

  if (p.isCancel(selection)) {
    return null;
  }

  return selection;
}

/**
 * Display a cleanup preview using @clack/prompts note format.
 */
function showCleanupPreview(preview: CleanupPreview): void {
  const lines: string[] = [
    `Directory: ${preview.workspaceDir}`,
    `Repositories: ${preview.repos.join(", ")}`,
  ];

  if (preview.remoteBranches && preview.remoteBranches.length > 0) {
    lines.push("");
    lines.push("Merged remote branches available for deletion:");
    for (const branch of preview.remoteBranches) {
      lines.push(`  • ${branch.repo}: ${branch.branch}`);
    }
  }

  p.note(lines.join("\n"), "Cleanup preview");
}
