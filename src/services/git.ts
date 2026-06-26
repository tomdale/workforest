import type { RunCommandOptions } from "../types.ts";
import { runCommand, runCommandWithStdin } from "../utils/exec.ts";
import type { TaskState } from "../utils/task-generator.ts";

export function runGit(
  args: string[],
  options: RunCommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return runCommand("git", args, options);
}

export function runGitWithStdin(
  args: string[],
  stdin: string,
  options: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return runCommandWithStdin("git", args, stdin, options);
}

type CloneResult = { stdout: string; stderr: string };

function parseCheckedOutBranchRefs(worktreeList: string): Set<string> {
  const branches = new Set<string>();

  for (const rawLine of worktreeList.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("branch ")) continue;

    const branch = line.slice("branch ".length).trim();
    if (branch.startsWith("refs/heads/")) {
      branches.add(branch);
    }
  }

  return branches;
}

async function readCheckedOutBranchRefs(
  cwd: string,
): Promise<Set<string> | null> {
  try {
    const { stdout } = await runGit(["worktree", "list", "--porcelain"], {
      cwd,
    });
    return parseCheckedOutBranchRefs(stdout);
  } catch {
    return null;
  }
}

/**
 * Clone a repository while yielding progress messages.
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
 * Move all refs from refs/heads/* to refs/remotes/origin/* in a bare repo.
 * This fixes the issue where git clone --bare creates local branches instead of remote-tracking refs.
 * Uses batched git update-ref --stdin for efficiency (single git call instead of 2N calls).
 */
export async function* fixBareRepoRefsGenerator(
  cwd: string,
): AsyncGenerator<TaskState, void, undefined> {
  // Get all refs in refs/heads/ with their SHA
  const { stdout } = await runGit(
    ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"],
    { cwd },
  );

  const lines = stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return;

  const checkedOutBranchRefs = await readCheckedOutBranchRefs(cwd);

  yield {
    status: "log",
    level: "info",
    message: `Normalizing ${lines.length} refs from refs/heads/* to refs/remotes/origin/*`,
  };

  if (checkedOutBranchRefs === null) {
    yield {
      status: "log",
      level: "warn",
      message:
        "Unable to inspect linked worktrees; preserving local branch refs while updating remote-tracking refs",
    };
  }

  // Build stdin commands for batched update-ref
  // Format: "update <newref> <newsha> [<oldsha>]\ndelete <oldref>\n"
  // Using "update" without oldsha allows creating or updating existing refs
  const stdinLines: string[] = [];
  const preservedRefs: string[] = [];
  for (const line of lines) {
    const [ref, sha] = line.split(" ");
    if (!ref || !sha) continue;

    const branch = ref.replace("refs/heads/", "");
    const newRef = `refs/remotes/origin/${branch}`;

    // Use update without oldsha to create-or-update the remote ref
    stdinLines.push(`update ${newRef} ${sha}`);

    if (checkedOutBranchRefs === null || checkedOutBranchRefs.has(ref)) {
      preservedRefs.push(ref);
      continue;
    }

    stdinLines.push(`delete ${ref}`);
  }

  if (checkedOutBranchRefs !== null && preservedRefs.length > 0) {
    yield {
      status: "log",
      level: "warn",
      message: `Preserving checked-out local branch refs during bare repo normalization: ${preservedRefs.join(", ")}`,
    };
  }

  if (stdinLines.length === 0) return;

  // Execute all ref updates in a single git call
  // Each line must end with newline, and we need a final newline
  await runGitWithStdin(
    ["update-ref", "--stdin"],
    `${stdinLines.join("\n")}\n`,
    { cwd },
  );
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
