import { log } from "../logger.ts";
import type { RunCommandOptions } from "../types.ts";
import { runCommand } from "../utils/exec.ts";

export function runGit(
  args: string[],
  options: RunCommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return runCommand("git", args, options);
}

/**
 * Try to clone a repository using GitHub CLI first, then fall back to git clone.
 * Supports git remotes like git@github.com:org/repo.git and https URLs.
 * Additional git arguments can be passed via the gitArgs parameter (e.g., ["--mirror"]).
 */
export async function cloneRepository(
  remote: string,
  targetDir: string,
  gitArgs: string[] = [],
  options: RunCommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const githubSlug = getGitHubSlug(remote);

  if (githubSlug) {
    try {
      log.info(`Attempting to clone ${githubSlug} using GitHub CLI`);
      const args = ["repo", "clone", githubSlug, targetDir];
      if (gitArgs.length > 0) {
        args.push("--", ...gitArgs);
      }
      return await runCommand("gh", args, options);
    } catch {
      log.info(
        `GitHub CLI not available or failed. Falling back to git clone for ${githubSlug}`,
      );
    }
  } else {
    log.info(
      `Remote ${remote} is not a GitHub URL; cloning with git directly.`,
    );
  }

  return runGit(["clone", ...gitArgs, remote, targetDir], options);
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
