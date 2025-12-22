import path from "node:path";
import arg from "arg";
import { resolveRepositories } from "./config.ts";
import { help } from "./help.ts";
import { log } from "./logger.ts";
import type { RepoConfig } from "./types.ts";
import { stampWorkspaceWithUI } from "./ui/workspace-ui.ts";
import { stampWorkspace } from "./workspace/index.ts";

export { log };

export async function cli(): Promise<void> {
  const args = arg(
    {
      "--help": Boolean,
      "--no-tui": Boolean,
      "-h": "--help",
    },
    { argv: process.argv.slice(2) },
  );

  if (args["--help"]) {
    console.log(help());
    return;
  }

  const featureName = args._[0];

  if (!featureName?.trim()) {
    log.error("Missing <feature-name> argument.");
    console.log(help());
    process.exitCode = 1;
    return;
  }

  const normalizedFeature = featureName.trim().replace(/\s+/g, "-");
  const repoArgs = args._.slice(1)
    .map((argValue) => argValue.trim())
    .filter(Boolean);
  let repos: RepoConfig[];

  try {
    repos = resolveRepositories(repoArgs);
  } catch (error_) {
    const message = error_ instanceof Error ? error_.message : String(error_);
    log.error(message);
    console.log(help());
    process.exitCode = 1;
    return;
  }

  const workspaceDir = path.resolve(
    process.cwd(),
    `vercel-${normalizedFeature}`,
  );

  const options = {
    featureName: normalizedFeature,
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
