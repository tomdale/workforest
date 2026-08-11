import type { RunCommandOptions } from "../types.ts";
import { runCommand } from "../utils/exec.ts";

export type GhRunner = (
  args: string[],
  options?: RunCommandOptions,
) => Promise<{ stdout: string; stderr: string }>;

export type MergedPullRequest = Readonly<{
  number: number;
  url: string;
  headRefOid: string;
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
      "number,url,headRefOid",
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
  const { stdout } = await runner(
    [
      "api",
      `repos/${options.repo}/commits/${options.sha}/pulls`,
      "--jq",
      "[.[] | select(.merged_at != null) | {number: .number, url: .html_url, headRefOid: .head.sha}]",
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
    if (
      typeof number !== "number" ||
      !Number.isFinite(number) ||
      typeof url !== "string" ||
      typeof headRefOid !== "string" ||
      !headRefOid
    ) {
      continue;
    }
    results.push({ number, url, headRefOid });
  }
  return results;
}
