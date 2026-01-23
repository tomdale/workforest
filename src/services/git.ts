import type { RunCommandOptions } from "../types.ts";
import { runCommand } from "../utils/exec.ts";
import type { TaskState } from "../utils/task-generator.ts";

export function runGit(
  args: string[],
  options: RunCommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return runCommand("git", args, options);
}

type CloneResult = { stdout: string; stderr: string };

/**
 * Generator version of cloneRepository that yields log messages.
 * Tries GitHub CLI first, then falls back to git clone.
 */
export async function* cloneRepositoryGenerator(
  remote: string,
  targetDir: string,
  gitArgs: string[] = [],
  options: RunCommandOptions = {},
): AsyncGenerator<TaskState, CloneResult, undefined> {
  const githubSlug = getGitHubSlug(remote);

  if (githubSlug) {
    try {
      yield {
        status: "log",
        level: "info",
        message: `Attempting to clone ${githubSlug} using GitHub CLI`,
      };
      const args = ["repo", "clone", githubSlug, targetDir];
      if (gitArgs.length > 0) {
        args.push("--", ...gitArgs);
      }
      return await runCommand("gh", args, options);
    } catch {
      yield {
        status: "log",
        level: "info",
        message: `GitHub CLI not available or failed. Falling back to git clone for ${githubSlug}`,
      };
    }
  } else {
    yield {
      status: "log",
      level: "info",
      message: `Remote ${remote} is not a GitHub URL; cloning with git directly.`,
    };
  }

  return await runGit(["clone", ...gitArgs, remote, targetDir], options);
}

/**
 * Try to clone a repository using GitHub CLI first, then fall back to git clone.
 * Supports git remotes like git@github.com:org/repo.git and https URLs.
 * Additional git arguments can be passed via the gitArgs parameter (e.g., ["--mirror"]).
 * @deprecated Use cloneRepositoryGenerator for generator-based workflows.
 */
export async function cloneRepository(
  remote: string,
  targetDir: string,
  gitArgs: string[] = [],
  options: RunCommandOptions = {},
): Promise<CloneResult> {
  const gen = cloneRepositoryGenerator(remote, targetDir, gitArgs, options);
  // Consume the generator, discarding log messages
  let result = await gen.next();
  while (!result.done) {
    result = await gen.next();
  }
  return result.value;
}

/**
 * Move all refs from refs/heads/* to refs/remotes/origin/* in a bare repo.
 * This fixes the issue where git clone --bare creates local branches instead of remote-tracking refs.
 */
export async function* fixBareRepoRefsGenerator(
  cwd: string,
): AsyncGenerator<TaskState, void, undefined> {
  // Get all refs in refs/heads/
  const { stdout } = await runGit(
    ["for-each-ref", "--format=%(refname)", "refs/heads/"],
    { cwd },
  );

  const refs = stdout.trim().split("\n").filter(Boolean);
  if (refs.length === 0) return;

  yield {
    status: "log",
    level: "info",
    message: `Moving ${refs.length} refs from refs/heads/* to refs/remotes/origin/*`,
  };

  for (const ref of refs) {
    const branch = ref.replace("refs/heads/", "");
    const newRef = `refs/remotes/origin/${branch}`;

    // Create the remote-tracking ref
    await runGit(["update-ref", newRef, ref], { cwd });
    // Delete the local ref
    await runGit(["update-ref", "-d", ref], { cwd });
  }
}

export function getGitHubSlug(remote: string): string | null {
  const trimmed = remote.trim();
  if (!trimmed) {
    return null;
  }

  const sshMatch = trimmed.match(/^git@github\.com:(.+)$/i);
  if (sshMatch?.[1]) {
    return sshMatch[1].replace(/\.git$/, "");
  }

  const httpsMatch = trimmed.match(/^https?:\/\/github\.com\/(.+)$/i);
  if (httpsMatch?.[1]) {
    return httpsMatch[1].replace(/\.git$/, "");
  }

  return null;
}
