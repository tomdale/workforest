import type { PostInstallHook } from "../types.ts";
import { getNodeVersionPrefix } from "../utils/node-version.ts";
import {
  runCommandGenerator,
  type TaskGenerator,
} from "../utils/task-generator.ts";
import { hasAny } from "./pnpm.ts";

/**
 * Generator-based post-install hook execution.
 * Checks conditions and executes hook command with proper node version handling.
 */
export async function* runPostInstallHook(
  hook: PostInstallHook,
  repoDir: string,
): TaskGenerator {
  yield { status: "running", message: `Checking conditions for ${hook.name}` };

  // Check condition if present
  if (hook.condition?.fileExists) {
    const conditionMet = await hasAny(repoDir, hook.condition.fileExists);
    if (!conditionMet) {
      yield {
        status: "skipped",
        reason: `Condition not met: none of [${hook.condition.fileExists.join(", ")}] exist`,
      };
      return;
    }
  }

  const versionPrefix = await getNodeVersionPrefix(repoDir);

  yield { status: "running", message: `Running ${hook.name}` };

  let command: string;
  let args: string[];
  if (versionPrefix) {
    command = versionPrefix.command;
    args = [...versionPrefix.args, hook.command, ...hook.args];
  } else {
    command = hook.command;
    args = hook.args;
  }

  const hookGen = runCommandGenerator(command, args, { cwd: repoDir });

  yield* hookGen;
}
