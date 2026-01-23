import os from "node:os";
import path from "node:path";
import arg from "arg";
import { loadWorkspaceConfig, resolveRepositories } from "./config.ts";
import { help } from "./help.ts";
import { log } from "./logger.ts";
import type { RepoConfig, WorkspaceConfig } from "./types.ts";
import { isInteractive, promptSelect, promptText } from "./utils/prompts.ts";
import { generateSlugFromDescription } from "./utils/slug.ts";
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
      "--with": String,
      "--template": String,
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

  let featureName = args._[0];
  let description: string | undefined = args["--description"];
  let repoArgs: string[];

  // Check if we need interactive mode
  if (!featureName?.trim() && !args["--with"]) {
    if (!isInteractive()) {
      log.error("Missing <feature-name> argument.");
      console.log(await help());
      process.exitCode = 1;
      return;
    }

    // Interactive mode: prompt for feature name and repos
    const interactiveResult = await runInteractivePrompts(config);
    if (!interactiveResult) {
      return;
    }
    featureName = interactiveResult.featureName;
    description = interactiveResult.description;
    repoArgs = interactiveResult.repoArgs;
  } else {
    if (!featureName?.trim()) {
      log.error("Missing <feature-name> argument.");
      console.log(await help());
      process.exitCode = 1;
      return;
    }

    const withArg = args["--with"] ?? "";
    repoArgs = withArg
      .split("+")
      .map((argValue) => argValue.trim())
      .filter(Boolean);
  }

  const normalizedFeature = featureName.trim().replace(/\s+/g, "-");

  let repos: RepoConfig[];
  try {
    repos = resolveRepositories(repoArgs, config);
  } catch (error) {
    log.error(getErrorMessage(error));
    console.log(await help());
    process.exitCode = 1;
    return;
  }

  const workspaceRoot = config.defaultDir
    ? path.resolve(expandHome(config.defaultDir))
    : process.cwd();
  const prefix = config.dirPrefix ?? "";
  const workspaceDir = path.resolve(
    workspaceRoot,
    `${prefix}${normalizedFeature}`,
  );

  const branchName = config.branchPrefix
    ? `${config.branchPrefix}${normalizedFeature}`
    : normalizedFeature;

  const templateId = args["--template"];

  await stampWorkspace({
    featureName: normalizedFeature,
    description,
    branchName,
    workspaceDir,
    repos,
    templateId,
  });

  log.info("Happy shipping!");
}

type InteractiveResult = {
  featureName: string;
  description?: string;
  repoArgs: string[];
};

async function runInteractivePrompts(
  config: WorkspaceConfig,
): Promise<InteractiveResult | null> {
  // Prompt for description first (optional) - used to generate slug suggestion
  const description = await promptText("Description (optional)");

  // Generate slug suggestion from description if provided
  let slugSuggestion: string | undefined;
  if (description.trim()) {
    slugSuggestion =
      (await generateSlugFromDescription(description.trim())) ?? undefined;
  }

  // Prompt for feature name with generated slug as default
  const featureName = await promptText("Feature name", {
    defaultValue: slugSuggestion,
    validate: (input) => {
      if (!input.trim()) {
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

  // Build selection options from aliases and defaults
  const aliases = config.aliases ?? {};
  const aliasEntries = Object.entries(aliases);
  const hasAliases = aliasEntries.length > 0;
  const hasDefaults =
    config.defaultRepos !== undefined && config.defaultRepos.length > 0;

  type SelectionValue =
    | { type: "alias"; alias: string }
    | { type: "defaults" }
    | { type: "custom" };

  const options: {
    label: string;
    description?: string;
    value: SelectionValue;
  }[] = [];

  // Add default repos option if configured
  if (hasDefaults) {
    options.push({
      label: "Default repositories",
      description: config.defaultRepos?.join(", "),
      value: { type: "defaults" },
    });
  }

  // Add alias options
  for (const [alias, repos] of aliasEntries) {
    options.push({
      label: alias,
      description: repos.join(", "),
      value: { type: "alias", alias },
    });
  }

  // Add custom option
  options.push({
    label: "Enter repositories manually",
    value: { type: "custom" },
  });

  // If no aliases and no defaults, skip selection and go straight to custom
  let repoArgs: string[];
  if (!hasAliases && !hasDefaults) {
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
    repoArgs = customRepos
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
  } else {
    const selection = await promptSelect<SelectionValue>(
      "Select repositories:",
      { options },
    );

    if (selection.type === "defaults") {
      repoArgs = [];
    } else if (selection.type === "alias") {
      repoArgs = [selection.alias];
    } else {
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
      repoArgs = customRepos
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);
    }
  }

  console.log();
  return {
    featureName,
    description: description.trim() || undefined,
    repoArgs,
  };
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
