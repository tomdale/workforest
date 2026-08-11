import type { RunCommandOptions } from "../types.ts";
import { runCommand } from "../utils/exec.ts";

export type GhRunner = (
  args: string[],
  options?: RunCommandOptions,
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Merged PR fields needed for integration proof.
 *
 * - `baseRefName` / `baseRepository` pin proof to the intended merge target
 *   (default branch of this repo), rejecting merges into release/stacked bases.
 * - `headRepositoryOwner` pins branch-name proof to this repo's head, rejecting
 *   same-named fork branches.
 */
export type MergedPullRequest = Readonly<{
  number: number;
  url: string;
  headRefOid: string;
  baseRefName: string;
  /** `owner/name` of the PR base repository when known. */
  baseRepository: string | null;
  /** Login/org of the head repository owner when known. */
  headRepositoryOwner: string | null;
}>;

/**
 * Thin `gh` wrapper for integration proof and other non-AI call sites.
 * Kept separate from template-suggestions so callers do not pull AI baggage.
 */
export function runGh(
  args: string[],
  options: RunCommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return runCommand("gh", args, options);
}

/**
 * Lists merged pull requests whose head branch matches `head`.
 * `head` is typically the bare branch name; fork heads may use `owner:branch`.
 *
 * Callers must still filter by head repository owner: `--head` matches
 * `headRefName` only, so same-named branches on other forks can appear.
 */
export async function listMergedPullRequestsByHead(options: {
  repo: string;
  head: string;
  cwd: string;
  runGh?: GhRunner;
}): Promise<MergedPullRequest[]> {
  const runner = options.runGh ?? runGh;
  const { stdout } = await runner(
    [
      "pr",
      "list",
      "--repo",
      options.repo,
      "--head",
      options.head,
      "--state",
      "merged",
      "--json",
      "number,url,headRefOid,baseRefName,headRepositoryOwner",
    ],
    { cwd: options.cwd },
  );
  return parseMergedPullRequestList(stdout, "gh pr list");
}

/**
 * Lists merged pull requests associated with a commit SHA via the commits API.
 * Used to prove integration when the local HEAD matches a merged PR head.
 */
export async function listMergedPullRequestsForCommit(options: {
  repo: string;
  sha: string;
  cwd: string;
  runGh?: GhRunner;
}): Promise<MergedPullRequest[]> {
  const runner = options.runGh ?? runGh;
  // REST payload uses nested head/base objects; project to the same shape as
  // `gh pr list --json` so one parser serves both paths.
  const { stdout } = await runner(
    [
      "api",
      `repos/${options.repo}/commits/${options.sha}/pulls`,
      "--jq",
      "[.[] | select(.merged_at != null) | {number: .number, url: .html_url, headRefOid: .head.sha, baseRefName: .base.ref, baseRepository: .base.repo.full_name, headRepositoryOwner: .head.repo.owner.login}]",
    ],
    { cwd: options.cwd },
  );
  return parseMergedPullRequestList(stdout, "gh api commits/.../pulls");
}

function parseMergedPullRequestList(
  stdout: string,
  label: string,
): MergedPullRequest[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${label} returned a non-array JSON value.`);
  }

  const results: MergedPullRequest[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const number = record["number"];
    const url = record["url"];
    const headRefOid = record["headRefOid"];
    const baseRefName = record["baseRefName"];
    if (
      typeof number !== "number" ||
      !Number.isFinite(number) ||
      typeof url !== "string" ||
      typeof headRefOid !== "string" ||
      !headRefOid ||
      typeof baseRefName !== "string" ||
      !baseRefName
    ) {
      continue;
    }
    results.push({
      number,
      url,
      headRefOid,
      baseRefName,
      baseRepository: readRepositorySlug(record["baseRepository"]),
      headRepositoryOwner: readOwnerLogin(record["headRepositoryOwner"]),
    });
  }
  return results;
}

/**
 * Normalize owner login from either a bare string (`gh api` jq projection) or
 * the `{login}` object returned by `gh pr list --json headRepositoryOwner`.
 */
function readOwnerLogin(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (value && typeof value === "object") {
    const login = (value as Record<string, unknown>)["login"];
    if (typeof login === "string") {
      const trimmed = login.trim();
      return trimmed || null;
    }
  }
  return null;
}

/**
 * Normalize a repo slug from either a bare `owner/name` string or a nested
 * object with `name` + `owner.login` (unused today; kept for symmetry).
 */
function readRepositorySlug(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const name = record["name"];
    const owner = readOwnerLogin(record["owner"] ?? record["ownerLogin"]);
    if (typeof name === "string" && name && owner) {
      return `${owner}/${name}`;
    }
    // Some payloads expose full_name directly on nested objects.
    const fullName = record["full_name"] ?? record["nameWithOwner"];
    if (typeof fullName === "string") {
      const trimmed = fullName.trim();
      return trimmed || null;
    }
  }
  return null;
}
