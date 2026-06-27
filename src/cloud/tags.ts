import type { CloudSandboxMetadata } from "../types.ts";

/**
 * Vercel Sandbox tags are the source of truth for which cloud workspaces exist:
 * the laptop holds no authoritative registry, so `wf cloud list/status`
 * reconstructs state by listing sandboxes and decoding these tags. Sandboxes
 * are limited to five tags, so the schema is intentionally minimal — the change
 * name is carried by the sandbox name (see {@link cloudSandboxName}) rather than
 * spending a tag on it.
 */

/** Marks a sandbox as workforest-managed. Value is always "1". */
export const MANAGED_TAG = "wf";
const BRANCH_TAG = "wfBranch";
const TEMPLATE_TAG = "wfTemplate";
const REPOS_TAG = "wfRepos";

/** Sandbox names workforest creates are namespaced with this prefix. */
const SANDBOX_NAME_PREFIX = "wf-";
/** Base (per-template) snapshot sandboxes are namespaced separately. */
const BASE_SANDBOX_NAME_PREFIX = "wfbase-";

const REPOS_SEPARATOR = ",";

/** The Vercel Sandbox name for a workspace change. */
export function cloudSandboxName(changeName: string): string {
  return `${SANDBOX_NAME_PREFIX}${changeName}`;
}

/** Recover the change name from a workspace sandbox name. */
export function changeNameFromSandbox(sandboxName: string): string {
  return sandboxName.startsWith(SANDBOX_NAME_PREFIX)
    ? sandboxName.slice(SANDBOX_NAME_PREFIX.length)
    : sandboxName;
}

/** The Vercel Sandbox name for a per-template/repo-set base snapshot. */
export function baseSandboxName(group: string): string {
  return `${BASE_SANDBOX_NAME_PREFIX}${group}`;
}

/** True for workspace sandboxes (excludes base-snapshot sandboxes). */
export function isWorkspaceSandboxName(sandboxName: string): boolean {
  return (
    sandboxName.startsWith(SANDBOX_NAME_PREFIX) &&
    !sandboxName.startsWith(BASE_SANDBOX_NAME_PREFIX)
  );
}

export type CloudWorkspaceTags = Readonly<{
  changeName: string;
  branchName: string;
  templateId?: string;
  repos: readonly string[];
}>;

/** Build the tag map written to a workspace sandbox at creation. */
export function buildWorkspaceTags(
  tags: CloudWorkspaceTags,
): Record<string, string> {
  const result: Record<string, string> = {
    [MANAGED_TAG]: "1",
    [BRANCH_TAG]: tags.branchName,
    [REPOS_TAG]: tags.repos.join(REPOS_SEPARATOR),
  };
  if (tags.templateId !== undefined) {
    result[TEMPLATE_TAG] = tags.templateId;
  }
  return result;
}

/** A minimal view of a Vercel Sandbox, as needed to decode workforest metadata. */
export type TaggedSandbox = Readonly<{
  name: string;
  status: string;
  createdAt: Date | number;
  tags?: Record<string, string> | undefined;
}>;

/** True when a sandbox carries the workforest-managed marker tag. */
export function isManagedSandbox(sandbox: TaggedSandbox): boolean {
  return sandbox.tags?.[MANAGED_TAG] === "1";
}

/** Decode a managed sandbox's tags into {@link CloudSandboxMetadata}. */
export function decodeCloudSandbox(
  sandbox: TaggedSandbox,
): CloudSandboxMetadata {
  const tags = sandbox.tags ?? {};
  const reposValue = tags[REPOS_TAG] ?? "";
  const templateId = tags[TEMPLATE_TAG];
  return {
    name: sandbox.name,
    changeName: changeNameFromSandbox(sandbox.name),
    branchName: tags[BRANCH_TAG] ?? "",
    ...(templateId !== undefined ? { templateId } : {}),
    repos: reposValue
      .split(REPOS_SEPARATOR)
      .map((repo) => repo.trim())
      .filter((repo) => repo.length > 0),
    status: sandbox.status,
    createdAt:
      sandbox.createdAt instanceof Date
        ? sandbox.createdAt.toISOString()
        : new Date(sandbox.createdAt).toISOString(),
  };
}
