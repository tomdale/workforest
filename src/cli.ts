import os from "node:os";
import path from "node:path";
import arg from "arg";
import { isRepoSlug, loadWorkspaceConfig, reposFromSlugs } from "./config.ts";
import { help } from "./help.ts";
import { log } from "./logger.ts";
import {
  createTemplate,
  deleteTemplate,
  getTemplatesDir,
  listTemplates,
  loadTemplate,
} from "./templates/index.ts";
import type { RepoConfig, WorkspaceConfig } from "./types.ts";
import { isInteractive, promptSelect, promptText } from "./utils/prompts.ts";
import { generateSlugFromDescription, isSlug } from "./utils/slug.ts";
import {
  cleanupWorkspace,
  previewCleanup,
  validateWorkspace,
} from "./workspace/cleanup.ts";
import { stampWorkspace } from "./workspace/index.ts";

export { log };

export async function cli(): Promise<void> {
  const argv = process.argv.slice(2);

  // Check for help flag at top level
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(await help());
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
    default:
      log.error(`Unknown command: ${command}`);
      console.log(await help());
      process.exitCode = 1;
  }
}

async function runConfigCommand(argv: string[]): Promise<void> {
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

  const { path: configPath } = await loadWorkspaceConfig();
  log.info(`Config file location: ${configPath}`);
  log.info("Edit the config file directly with your preferred editor.");
}

async function runTemplateCommand(argv: string[]): Promise<void> {
  const subcommand = argv[0];
  const subArgv = argv.slice(1);

  switch (subcommand) {
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
    default:
      log.error(`Unknown template subcommand: ${subcommand}`);
      log.info("Available: list, show, new, delete");
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

  console.log(`\nLocation: ${getTemplatesDir()}/${template.id}/template.json`);
  console.log();
}

async function runTemplateNew(argv: string[]): Promise<void> {
  let templateId = argv[0];

  if (!templateId) {
    if (!isInteractive()) {
      log.error("Missing template name. Usage: workforest template new <name>");
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

  // Prompt for repos
  const reposInput = await promptText(
    "Repositories (org/repo, comma-separated)",
    {
      validate: (input) => {
        if (!input.trim()) {
          return "At least one repository is required";
        }
        return null;
      },
    },
  );

  const repos = reposInput
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  // Validate repos
  for (const repo of repos) {
    if (!isRepoSlug(repo)) {
      log.error(`Invalid repository format: "${repo}". Expected "org/repo".`);
      process.exitCode = 1;
      return;
    }
  }

  // Prompt for description (optional)
  const description = await promptText("Description (optional)");

  await createTemplate(templateId, {
    repos,
    description: description.trim() || undefined,
  });

  log.success(`Template "${templateId}" created.`);
  log.info(`Location: ${getTemplatesDir()}/${templateId}/template.json`);
}

async function runTemplateDelete(argv: string[]): Promise<void> {
  const templateId = argv[0];

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

  await deleteTemplate(templateId);
  log.success(`Template "${templateId}" deleted.`);
}

async function runCleanCommand(argv: string[]): Promise<void> {
  const args = arg(
    {
      "--help": Boolean,
      "--dry-run": Boolean,
      "--force": Boolean,
      "--keep-mirrors": Boolean,
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

  const workspaceDir = args._[0] ?? process.cwd();
  const dryRun = args["--dry-run"] ?? false;
  const force = args["--force"] ?? false;
  const keepMirrors = args["--keep-mirrors"] ?? true;

  // Validate workspace first
  try {
    await validateWorkspace(workspaceDir);
  } catch (error) {
    log.error(getErrorMessage(error));
    process.exitCode = 1;
    return;
  }

  // Show preview
  const preview = await previewCleanup(workspaceDir);
  log.info(`Workspace: ${preview.workspaceDir}`);
  log.info(`Repositories: ${preview.repos.join(", ")}`);

  // Confirm unless --force or --dry-run
  if (!force && !dryRun) {
    const readline = await import("node:readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await new Promise<string>((resolve) => {
      rl.question(
        "This will delete the workspace directory. Continue? [y/N] ",
        resolve,
      );
    });
    rl.close();

    if (answer.toLowerCase() !== "y") {
      log.info("Cancelled.");
      return;
    }
  }

  await cleanupWorkspace(workspaceDir, { dryRun, force, keepMirrors });
}

async function runNewCommand(argv: string[]): Promise<void> {
  const args = arg(
    {
      "--help": Boolean,
      "--description": String,
      "-h": "--help",
      "-d": "--description",
    },
    { argv },
  );

  if (args["--help"]) {
    console.log(await help());
    return;
  }

  let config: WorkspaceConfig;
  try {
    ({ config } = await loadWorkspaceConfig());
  } catch (error) {
    log.error(getErrorMessage(error));
    process.exitCode = 1;
    return;
  }

  // Positional args are templates or org/repo strings
  let selections = args._;

  // If no selections provided, prompt interactively or error
  if (selections.length === 0) {
    if (!isInteractive()) {
      log.error("No template or repositories specified.");
      process.exitCode = 1;
      return;
    }

    const selected = await promptForTemplateOrRepos();
    if (!selected) {
      return;
    }
    selections = selected;
  }

  // Resolve selections to repos and collect template info
  let repos: RepoConfig[];
  let templateId: string | undefined;
  let templateBranchPrefix: string | undefined;

  try {
    const resolved = await resolveSelections(selections);
    repos = resolved.repos;
    templateId = resolved.templateId;
    templateBranchPrefix = resolved.templateBranchPrefix;
  } catch (error) {
    log.error(getErrorMessage(error));
    process.exitCode = 1;
    return;
  }

  // Get feature name from --description or interactive prompt
  let featureName: string;
  let description: string | undefined;

  if (args["--description"]) {
    const input = args["--description"];
    if (isSlug(input)) {
      featureName = input;
    } else {
      description = input;
      const generated = await generateSlugFromDescription(input);
      featureName = generated ?? sanitizeToSlug(input);
    }
  } else {
    if (!isInteractive()) {
      log.error(
        "Missing --description argument (required in non-interactive mode).",
      );
      process.exitCode = 1;
      return;
    }

    const result = await promptForFeatureName();
    if (!result) {
      return;
    }
    featureName = result.featureName;
    description = result.description;
  }

  const workspaceRoot = config.defaultDir
    ? path.resolve(expandHome(config.defaultDir))
    : process.cwd();
  const prefix = config.dirPrefix ?? "";
  const workspaceDir = path.resolve(workspaceRoot, `${prefix}${featureName}`);

  // Use template's branchPrefix if provided, otherwise fall back to config
  const effectiveBranchPrefix = templateBranchPrefix ?? config.branchPrefix;
  const branchName = effectiveBranchPrefix
    ? `${effectiveBranchPrefix}${featureName}`
    : featureName;

  await stampWorkspace({
    featureName,
    description,
    branchName,
    workspaceDir,
    repos,
    templateId,
  });

  log.info("Happy shipping!");
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
    templateId,
    templateBranchPrefix,
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
  const input = await promptText("What are you working on?", {
    validate: (value) => {
      if (!value.trim()) {
        return "Please describe what you're working on";
      }
      return null;
    },
  });

  const trimmed = input.trim();

  // If it's already a slug, use it directly
  if (isSlug(trimmed)) {
    return { featureName: trimmed };
  }

  // It's prose - generate a slug
  log.info("Generating feature name...");
  const generated = await generateSlugFromDescription(trimmed);
  const defaultSlug = generated ?? sanitizeToSlug(trimmed);

  const featureName = await promptText("Feature name", {
    defaultValue: defaultSlug,
    validate: (value) => {
      if (!value.trim()) {
        return "Feature name is required";
      }
      return null;
    },
  });

  if (!featureName.trim()) {
    log.error("Feature name is required.");
    process.exitCode = 1;
    return null;
  }

  return {
    featureName: featureName.trim(),
    description: trimmed,
  };
}

/**
 * Prompt user to select a template or enter repos manually.
 */
async function promptForTemplateOrRepos(): Promise<string[] | null> {
  const templates = await listTemplates();

  type SelectionValue = { type: "template"; id: string } | { type: "custom" };

  const options: {
    label: string;
    description?: string;
    value: SelectionValue;
  }[] = [];

  // Add template options
  for (const template of templates) {
    options.push({
      label: template.id,
      description:
        template.config.description ?? template.config.repos.join(", "),
      value: { type: "template", id: template.id },
    });
  }

  // Add custom option
  options.push({
    label: "Enter repositories manually",
    value: { type: "custom" },
  });

  // If no templates, go straight to manual entry
  if (templates.length === 0) {
    const customRepos = await promptText(
      "Repositories (org/repo, comma-separated)",
      {
        validate: (input) => {
          if (!input.trim()) {
            return "At least one repository is required";
          }
          return null;
        },
      },
    );
    return customRepos
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
  }

  const selection = await promptSelect<SelectionValue>(
    "Select workspace setup:",
    { options },
  );

  if (selection.type === "template") {
    return [selection.id];
  }

  // Custom entry
  const customRepos = await promptText(
    "Repositories (org/repo, comma-separated)",
    {
      validate: (input) => {
        if (!input.trim()) {
          return "At least one repository is required";
        }
        return null;
      },
    },
  );

  const repos = customRepos
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  if (repos.length === 0) {
    return null;
  }

  return repos;
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
