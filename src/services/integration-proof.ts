import type { RunCommandOptions } from "../types.ts";
import { runGit as defaultRunGit, getGitHubSlug } from "./git.ts";
import {
  runGh as defaultRunGh,
  type GhRunner,
  listMergedPullRequestsByHead,
  listMergedPullRequestsForCommit,
} from "./github-cli.ts";

export type GitRunner = (
  args: string[],
  options?: RunCommandOptions,
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Layered integration verdict used by delete safety, status, tasks, and
 * create-time donor preference (reap lane).
 *
 * Precedence: default branch → ancestry (offline) → merged GitHub PR.
 */
export type IntegrationProof =
  | {
      status: "integrated";
      method: "default-branch" | "ancestor" | "github-pr";
      detail?: string;
    }
  | {
      status: "not-integrated";
      method: "ancestor" | "github-pr" | "rule-c";
      detail?: string;
    }
  | {
      status: "unknown";
      reason:
        | "no-base"
        | "gh-unavailable"
        | "gh-error"
        | "no-head"
        | "non-github";
      detail?: string;
    };

export type ProveIntegrationOptions = Readonly<{
  /** Git working directory used for git and gh commands. */
  cwd: string;
  /**
   * Base ref that should contain the head when integrated via ancestry,
   * e.g. `origin/main` or parent `HEAD` for task branches.
   */
  base: string;
  /** Current branch name when known; used for default-branch and PR-by-branch. */
  branch?: string | null;
  /** Default branch name for the on-default-branch short circuit. */
  defaultBranch?: string | null;
  /**
   * Commit-ish to prove. Defaults to `HEAD` (worktree tip). Task/cleanup
   * callers pass a branch name or remote ref tip.
   */
  headRef?: string;
  runGit?: GitRunner;
  runGh?: GhRunner;
}>;

/**
 * Prove whether `headRef` (default HEAD) is integrated into `base`.
 *
 * Rules (agreed v1):
 * 1. On default branch → integrated
 * 2. `git merge-base --is-ancestor <head> <base>` → integrated (offline first)
 * 3. Else GitHub merged PR via `gh`:
 *    - merged PR for this branch, or
 *    - merged PR whose head SHA equals local head
 *    - Rule C: branch-name-only match refuses when head is strictly ahead of
 *      that PR's head SHA (continued commits after the merge)
 * 4. Otherwise not integrated / unproven
 */
export async function proveIntegration(
  options: ProveIntegrationOptions,
): Promise<IntegrationProof> {
  const runGit = options.runGit ?? defaultRunGit;
  const runGh = options.runGh ?? defaultRunGh;
  const headRef = options.headRef ?? "HEAD";
  const branch = options.branch ?? null;
  const defaultBranch = options.defaultBranch ?? null;
  const base = options.base.trim();

  if (!base) {
    return { status: "unknown", reason: "no-base" };
  }

  if (branch && defaultBranch && branch === defaultBranch) {
    return { status: "integrated", method: "default-branch" };
  }

  if (await isAncestor(runGit, options.cwd, headRef, base)) {
    return { status: "integrated", method: "ancestor" };
  }

  return proveViaGithubPr({
    cwd: options.cwd,
    branch,
    headRef,
    runGit,
    runGh,
  });
}

/**
 * Boolean view used by existing delete/status surfaces.
 * - true: proven integrated
 * - false: proven not integrated, or unproven after checks
 * - null: only when there is no base to evaluate
 *
 * Unknown (gh down, non-GitHub) maps to false so delete keeps refuse-by-default.
 */
export function integrationProofToBoolean(
  proof: IntegrationProof,
): boolean | null {
  if (proof.status === "integrated") {
    return true;
  }
  if (proof.status === "unknown" && proof.reason === "no-base") {
    return null;
  }
  return false;
}

export function isProvenIntegrated(proof: IntegrationProof): boolean {
  return proof.status === "integrated";
}

async function proveViaGithubPr(options: {
  cwd: string;
  branch: string | null;
  headRef: string;
  runGit: GitRunner;
  runGh: GhRunner;
}): Promise<IntegrationProof> {
  const headSha = await resolveSha(
    options.runGit,
    options.cwd,
    options.headRef,
  );
  if (!headSha) {
    return { status: "unknown", reason: "no-head" };
  }

  const repo = await resolveGithubRepo(options.runGit, options.cwd);
  if (!repo) {
    return {
      status: "not-integrated",
      method: "ancestor",
      detail: "non-github-remote",
    };
  }

  try {
    // Prefer branch-scoped PR list when we know the branch name.
    if (options.branch) {
      const byBranch = await listMergedPullRequestsByHead({
        repo,
        head: options.branch,
        cwd: options.cwd,
        runGh: options.runGh,
      });

      const headMatch = byBranch.find(
        (pr) => normalizeSha(pr.headRefOid) === normalizeSha(headSha),
      );
      if (headMatch) {
        return {
          status: "integrated",
          method: "github-pr",
          detail: `#${headMatch.number}`,
        };
      }

      if (byBranch.length > 0) {
        // Rule C: branch-name-only match must not be strictly ahead of PR head.
        for (const pr of byBranch) {
          const ahead = await isStrictlyAhead(
            options.runGit,
            options.cwd,
            headSha,
            pr.headRefOid,
          );
          if (ahead) {
            return {
              status: "not-integrated",
              method: "rule-c",
              detail: `#${pr.number}`,
            };
          }
        }

        const matched = byBranch[0];
        if (matched) {
          return {
            status: "integrated",
            method: "github-pr",
            detail: `#${matched.number}`,
          };
        }
      }
    }

    // Branch unknown or no branch-head PR: match merged PR by commit association
    // and require head SHA equality (the "head SHA == local HEAD" path).
    const byCommit = await listMergedPullRequestsForCommit({
      repo,
      sha: headSha,
      cwd: options.cwd,
      runGh: options.runGh,
    });
    const headMatch = byCommit.find(
      (pr) => normalizeSha(pr.headRefOid) === normalizeSha(headSha),
    );
    if (headMatch) {
      return {
        status: "integrated",
        method: "github-pr",
        detail: `#${headMatch.number}`,
      };
    }

    return { status: "not-integrated", method: "ancestor" };
  } catch (error) {
    if (isGhUnavailable(error)) {
      return {
        status: "unknown",
        reason: "gh-unavailable",
        detail: errorMessage(error),
      };
    }
    return {
      status: "unknown",
      reason: "gh-error",
      detail: errorMessage(error),
    };
  }
}

async function isAncestor(
  runGit: GitRunner,
  cwd: string,
  headRef: string,
  base: string,
): Promise<boolean> {
  try {
    await runGit(["merge-base", "--is-ancestor", headRef, base], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `headSha` is a descendant of `prHeadSha` and not equal to it.
 * That is the Rule C "strictly ahead of PR head" case.
 */
async function isStrictlyAhead(
  runGit: GitRunner,
  cwd: string,
  headSha: string,
  prHeadSha: string,
): Promise<boolean> {
  if (normalizeSha(headSha) === normalizeSha(prHeadSha)) {
    return false;
  }
  // pr head is ancestor of local head ⇒ local is ahead (or equal, already excluded)
  return isAncestor(runGit, cwd, prHeadSha, headSha);
}

async function resolveSha(
  runGit: GitRunner,
  cwd: string,
  ref: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGit(["rev-parse", ref], { cwd });
    const sha = stdout.trim();
    return sha || null;
  } catch {
    return null;
  }
}

async function resolveGithubRepo(
  runGit: GitRunner,
  cwd: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGit(["config", "--get", "remote.origin.url"], {
      cwd,
    });
    return getGitHubSlug(stdout.trim());
  } catch {
    return null;
  }
}

function normalizeSha(sha: string): string {
  return sha.trim().toLowerCase();
}

function isGhUnavailable(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("command not found") ||
    message.includes("gh auth") ||
    message.includes("not logged into") ||
    message.includes("authentication") ||
    message.includes("http 401") ||
    message.includes("http 403")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Re-export runners so tests and future lanes can inject consistently.
export type { GhRunner };
export { defaultRunGh as runGh };
