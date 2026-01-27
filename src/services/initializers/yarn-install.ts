import { getNodeVersionPrefix } from "../../utils/node-version.ts";
import { runCommandGenerator } from "../../utils/task-generator.ts";
import { hasAny } from "../pnpm.ts";
import type {
  InitializerContext,
  InitializerDefinition,
  InitializerDetection,
} from "./types.ts";

const PNPM_LOCK_FILES = ["pnpm-lock.yaml", "pnpm-lock.yml"];

/**
 * Detect if this is a yarn project (has yarn.lock but no pnpm lockfile).
 */
async function detect(
  context: InitializerContext,
): Promise<InitializerDetection> {
  // Don't run if there's a pnpm lockfile
  const hasPnpmLock = await hasAny(context.repoDir, PNPM_LOCK_FILES);
  if (hasPnpmLock) {
    return { shouldRun: false };
  }

  const hasYarnLock = await hasAny(context.repoDir, ["yarn.lock"]);
  return { shouldRun: hasYarnLock };
}

/**
 * Install yarn dependencies with frozen-lockfile.
 */
async function* execute(context: InitializerContext) {
  const { repoDir } = context;

  const versionPrefix = await getNodeVersionPrefix(repoDir);

  yield { status: "running" as const, message: "Installing (frozen-lockfile)" };

  let command: string;
  let args: string[];
  if (versionPrefix) {
    command = versionPrefix.command;
    args = [...versionPrefix.args, "yarn", "install", "--frozen-lockfile"];
  } else {
    command = "yarn";
    args = ["install", "--frozen-lockfile"];
  }

  const install = runCommandGenerator(command, args, { cwd: repoDir });

  for await (const state of install) {
    yield state;
  }
}

export const yarnInstallInitializer: InitializerDefinition = {
  id: "yarn-install",
  name: "yarn install",
  priority: 101,
  detect,
  execute,
};
