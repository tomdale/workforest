import os from "node:os";
import path from "node:path";
import arg from "arg";
import { loadWorkspaceConfig, resolveRepositories } from "./config.ts";
import { help } from "./help.ts";
import { log } from "./logger.ts";
import type { RepoConfig, WorkspaceConfig } from "./types.ts";
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

async function runNewCommand(argv: string[]): Promise<void> {
  const args = arg(
    {
      "--help": Boolean,
      "--with": String,
      "-h": "--help",
    },
    { argv },
  );

  if (args["--help"]) {
    console.log(await help());
    return;
  }

  const featureName = args._[0];

  if (!featureName?.trim()) {
    log.error("Missing <feature-name> argument.");
    console.log(await help());
    process.exitCode = 1;
    return;
  }

  const normalizedFeature = featureName.trim().replace(/\s+/g, "-");
  const withArg = args["--with"] ?? "";
  const repoArgs = withArg
    .split("+")
    .map((argValue) => argValue.trim())
    .filter(Boolean);
  let repos: RepoConfig[];
  let config: WorkspaceConfig;
  try {
    ({ config } = await loadWorkspaceConfig());
  } catch (error) {
    log.error(getErrorMessage(error));
    process.exitCode = 1;
    return;
  }

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

  await stampWorkspace({
    featureName: normalizedFeature,
    branchName,
    workspaceDir,
    repos,
  });

  log.info("Happy shipping!");
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
