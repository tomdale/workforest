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
  const args = arg(
    {
      "--help": Boolean,
      "--with": String,
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

  await stampWorkspace({
    featureName: normalizedFeature,
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
