import type { RunCommandOptions } from "../types.ts";
import { runCommand } from "../utils/exec.ts";

export function runGit(
  args: string[],
  options: RunCommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return runCommand("git", args, options);
}
