import type { RunCommandOptions } from "../types.ts";
import { runGit as defaultRunGit, getGitHubSlug } from "./git.ts";
import {
  runGh as defaultRunGh,
  type GhRunner,
  listMergedPullRequestsByHead,
  listMergedPullRequestsForCommit,
  type MergedPullRequest,
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
 *    - merged PR for this branch into the expected base, or
 *    - merged PR whose head SHA equals local head into the expected base
 *    - head repository must match this repo (reject same-named fork branches)
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
    base,
    branch,
    defaultBranch,
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
  base: string;
  branch: string | null;
  defaultBranch: string | null;
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

  const expectedBase = await resolveExpectedBaseRefName({
    base: options.base,
    defaultBranch: options.defaultBranch,
    cwd: options.cwd,
    runGit: options.runGit,
  });
  if (!expectedBase) {
    // Without a resolvable base branch name we cannot safely accept PR proof
    // (would re-open the wrong-base bypass). Leave unproven.
    return {
      status: "not-integrated",
      method: "github-pr",
      detail: "unresolvable-base",
    };
  }

  const repoOwner = repoOwnerLogin(repo);
  if (!repoOwner) {
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

      const eligible = byBranch.filter((pr) =>
        isEligibleMergedPr(pr, {
          expectedBase,
          expectedHeadOwner: repoOwner,
          expectedBaseRepo: repo,
          requireHeadOwner: true,
        }),
      );

      const headMatch = eligible.find(
        (pr) => normalizeSha(pr.headRefOid) === normalizeSha(headSha),
      );
      if (headMatch) {
        return {
          status: "integrated",
          method: "github-pr",
          detail: `#${headMatch.number}`,
        };
      }

      if (eligible.length > 0) {
        // Rule C: branch-name-only match must not be strictly ahead of PR head.
        for (const pr of eligible) {
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

        const matched = eligible[0];
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
      (pr) =>
        normalizeSha(pr.headRefOid) === normalizeSha(headSha) &&
        isEligibleMergedPr(pr, {
          expectedBase,
          expectedHeadOwner: repoOwner,
          expectedBaseRepo: repo,
          // Commit association already ties the SHA to this repo's history;
          // still require base match. Head-owner check is soft: accept when
          // the field is present and matches, or when it is absent.
          requireHeadOwner: false,
        }),
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

/**
 * True when the PR is a valid integration proof for this checkout:
 * - merged into the expected base branch name
 * - base repository is this repo when the field is present
 * - head repository owner matches this repo when required (branch-name path)
 */
function isEligibleMergedPr(
  pr: MergedPullRequest,
  options: {
    expectedBase: string;
    expectedHeadOwner: string;
    expectedBaseRepo: string;
    requireHeadOwner: boolean;
  },
): boolean {
  if (
    normalizeRefName(pr.baseRefName) !== normalizeRefName(options.expectedBase)
  ) {
    return false;
  }

  if (
    pr.baseRepository &&
    normalizeRepoSlug(pr.baseRepository) !==
      normalizeRepoSlug(options.expectedBaseRepo)
  ) {
    return false;
  }

  if (options.requireHeadOwner) {
    if (!pr.headRepositoryOwner) {
      return false;
    }
    if (
      normalizeOwner(pr.headRepositoryOwner) !==
      normalizeOwner(options.expectedHeadOwner)
    ) {
      return false;
    }
  } else if (
    pr.headRepositoryOwner &&
    normalizeOwner(pr.headRepositoryOwner) !==
      normalizeOwner(options.expectedHeadOwner)
  ) {
    return false;
  }

  return true;
}

/**
 * Map the ancestry `base` argument to a GitHub PR `baseRefName`.
 *
 * Callers pass git refs such as `origin/main`, `main`, or parent `HEAD`.
 * PR proof needs the bare branch name the PR was merged into.
 */
async function resolveExpectedBaseRefName(options: {
  base: string;
  defaultBranch: string | null;
  cwd: string;
  runGit: GitRunner;
}): Promise<string | null> {
  const stripped = stripRemoteRefPrefix(options.base);
  if (stripped && !isSymbolicOrSha(stripped)) {
    return stripped;
  }

  if (options.defaultBranch?.trim()) {
    return options.defaultBranch.trim();
  }

  // Task callers pass base `HEAD` without defaultBranch. Resolve the parent's
  // current branch name so PR proof still pins to the intended base.
  if (stripped === "HEAD" || options.base === "HEAD") {
    try {
      const { stdout } = await options.runGit(["branch", "--show-current"], {
        cwd: options.cwd,
      });
      const current = stdout.trim();
      if (current) {
        return current;
      }
    } catch {
      // fall through
    }
  }

  return null;
}

function stripRemoteRefPrefix(ref: string): string {
  let value = ref.trim();
  if (value.startsWith("refs/remotes/")) {
    // refs/remotes/<remote>/<branch>
    const parts = value.slice("refs/remotes/".length).split("/");
    value = parts.slice(1).join("/");
  } else if (value.startsWith("refs/heads/")) {
    value = value.slice("refs/heads/".length);
  } else {
    const originPrefix = "origin/";
    if (value.startsWith(originPrefix)) {
      value = value.slice(originPrefix.length);
    }
  }
  return value;
}

function isSymbolicOrSha(ref: string): boolean {
  if (ref === "HEAD" || ref === "@") {
    return true;
  }
  // Full or abbreviated SHA — not a usable PR baseRefName.
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

function repoOwnerLogin(slug: string): string | null {
  const owner = slug.split("/")[0]?.trim();
  return owner || null;
}

function normalizeRefName(name: string): string {
  return name.trim().toLowerCase();
}

function normalizeOwner(owner: string): string {
  return owner.trim().toLowerCase();
}

function normalizeRepoSlug(slug: string): string {
  return slug.trim().toLowerCase();
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
