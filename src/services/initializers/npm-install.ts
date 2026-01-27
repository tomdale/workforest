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
 * Detect if this is an npm project (has package-lock.json but no pnpm/yarn lockfile).
 */
async function detect(
  context: InitializerContext,
): Promise<InitializerDetection> {
  // Don't run if there's a pnpm lockfile
  const hasPnpmLock = await hasAny(context.repoDir, PNPM_LOCK_FILES);
  if (hasPnpmLock) {
    return { shouldRun: false };
  }

  // Don't run if there's a yarn lockfile
  const hasYarnLock = await hasAny(context.repoDir, ["yarn.lock"]);
  if (hasYarnLock) {
    return { shouldRun: false };
  }

  const hasNpmLock = await hasAny(context.repoDir, ["package-lock.json"]);
  return { shouldRun: hasNpmLock };
}

/**
 * Install npm dependencies with npm ci.
 */
async function* execute(context: InitializerContext) {
  const { repoDir } = context;

  const versionPrefix = await getNodeVersionPrefix(repoDir);

  yield { status: "running" as const, message: "Installing (npm ci)" };

  let command: string;
  let args: string[];
  if (versionPrefix) {
    command = versionPrefix.command;
    args = [...versionPrefix.args, "npm", "ci"];
  } else {
    command = "npm";
    args = ["ci"];
  }

  const install = runCommandGenerator(command, args, { cwd: repoDir });

  for await (const state of install) {
    yield state;
  }
}

export const npmInstallInitializer: InitializerDefinition = {
  id: "npm-install",
  name: "npm install",
  priority: 102,
  detect,
  execute,
};
