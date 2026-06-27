import { getNodeVersionPrefix, pathExists } from "@wf-plugin/core";
import type { Hook } from "../types.ts";
import {
  assertContainedPathWithoutSymlinks,
  resolveContainedPath,
} from "../utils/path-safety.ts";
import {
  runCommandGenerator,
  type TaskGenerator,
} from "../utils/task-generator.ts";

/**
 * Generator-based hook execution.
 * Checks conditions and executes hook command with proper node version handling.
 */
export async function* runHook(
  hook: Hook,
  workspaceDir: string,
  repoDir?: string,
): TaskGenerator {
  const cwd = repoDir ?? workspaceDir;
  await assertContainedPathWithoutSymlinks(workspaceDir, cwd);

  yield { status: "running", message: `Checking conditions for ${hook.name}` };

  // Check condition if present (relative to cwd)
  if (hook.if?.fileExists) {
    const filePath = resolveContainedPath(cwd, hook.if.fileExists);
    await assertContainedPathWithoutSymlinks(workspaceDir, filePath);
    const conditionMet = await pathExists(filePath);
    if (!conditionMet) {
      yield {
        status: "skipped",
        reason: `Condition not met: ${hook.if.fileExists} does not exist`,
      };
      return;
    }
  }

  const versionPrefix = await getNodeVersionPrefix(cwd);

  yield { status: "running", message: `Running ${hook.name}` };

  let command: string;
  let args: string[];
  if (versionPrefix) {
    command = versionPrefix.command;
    args = [...versionPrefix.args, "sh", "-c", hook.run];
  } else {
    command = "sh";
    args = ["-c", hook.run];
  }

  const hookGen = runCommandGenerator(command, args, { cwd });

  yield* hookGen;
}
