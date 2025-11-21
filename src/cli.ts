import path from "node:path";
import arg from "arg";
import { log } from "./logger.ts";
import { stampWorkspace } from "./workspace/index.ts";

export { log };

export async function cli(): Promise<void> {
  const args = arg(
    {
      "--help": Boolean,
      "-h": "--help",
    },
    { argv: process.argv.slice(2) },
  );

  if (args["--help"]) {
    printHelp();
    return;
  }

  const featureName = args._[0];

  if (!featureName?.trim()) {
    log.error("Missing <feature-name> argument.");
    printHelp();
    process.exitCode = 1;
    return;
  }

  const normalizedFeature = featureName.trim().replace(/\s+/g, "-");
  const workspaceDir = path.resolve(
    process.cwd(),
    `vercel-${normalizedFeature}`,
  );

  await stampWorkspace({
    featureName: normalizedFeature,
    workspaceDir,
  });

  log.info("Happy shipping!");
}

function printHelp() {
  console.log(`Usage: vercel-workspace <feature-name>

Creates a workspace directory (vercel-<feature-name>) and stamps the
vercel/front and vercel/api repositories into it by cloning from cached
bare mirrors under $XDG_CACHE_HOME/vercel-workspace.
`);
}
