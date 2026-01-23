import os from "node:os";
import path from "node:path";
import arg from "arg";
import { loadWorkspaceConfig, resolveRepositories } from "./config.ts";
import { help } from "./help.ts";
import { log } from "./logger.ts";
import type { RepoConfig, WorkspaceConfig } from "./types.ts";
import { editConfigWithUI } from "./ui/config-ui.ts";
import { stampWorkspaceWithUI } from "./ui/workspace-ui.ts";
import { stampWorkspace } from "./workspace/index.ts";

export { log };

export async function cli(): Promise<void> {
  const args = arg(
    {
      "--help": Boolean,
      "--with": String,
      "--no-tui": Boolean,
      "-h": "--help",
    },
    { argv: process.argv.slice(2) },
  );

  if (args["--help"]) {
    console.log(await help());
    return;
  }

  const featureName = args._[0];

  if (!featureName?.trim()) {
    if (process.stdout.isTTY && !args["--no-tui"]) {
      log.info("Launching config editor TUI (log: $WORKFOREST_TUI_LOG)");
      await editConfigWithUI();
      return;
    }
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

  const options = {
    featureName: normalizedFeature,
    branchName,
    workspaceDir,
    repos,
  };

  // Use TUI by default, unless --no-tui is specified or stdout is not a TTY
  const useTui = !args["--no-tui"] && process.stdout.isTTY;

  if (useTui) {
    await stampWorkspaceWithUI(options);
  } else {
    await stampWorkspace(options);
    log.info("Happy shipping!");
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
