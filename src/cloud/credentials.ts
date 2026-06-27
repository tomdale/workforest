import {
  getAuth,
  OAuth,
  updateAuthConfig,
} from "@vercel/sandbox/dist/auth/index.js";
import { OperationalError, UsageError } from "../cli/errors.ts";
import type { WorkspaceConfig } from "../types.ts";

/**
 * Explicit Vercel credentials passed to every SDK call. Cloud provisioning is
 * deterministic: the team and project come from config as slugs (the Vercel API
 * accepts slugs in place of team_…/prj_… ids), and the token from the
 * environment or the Vercel CLI login. The team/project scope is always explicit
 * — nothing is inferred from the token.
 */
export type CloudCredentials = Readonly<{
  token: string;
  teamId: string;
  projectId: string;
}>;

/** Refresh the login token this far ahead of its expiry to avoid mid-run failures. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Resolve the credentials for a cloud command, or throw a clear, actionable
 * error when the workspace is not configured for cloud use. Call this at the top
 * of every cloud entry point so misconfiguration fails fast and uniformly.
 *
 * The token is resolved from, in order: `VERCEL_TOKEN`, `VERCEL_OIDC_TOKEN`, then
 * the `vercel` CLI login. The login token is a short-lived OAuth token, so it is
 * refreshed (and persisted) via its stored refresh token when near expiry — that
 * is what keeps cloud commands working past the ~hours token lifetime rather than
 * erroring once it lapses. The team and project always come from config (as
 * slugs) and are passed as the explicit scope.
 */
export async function resolveCloudCredentials(
  config: WorkspaceConfig,
): Promise<CloudCredentials> {
  const team = config.cloud?.vercel?.team;
  const project = config.cloud?.vercel?.project;
  if (!team || !project) {
    throw new UsageError(
      [
        "Cloud workspaces require a team and project to be configured.",
        "Set both (as Vercel slugs) in your workforest config:",
        '  "cloud": { "vercel": { "team": "<team-slug>", "project": "<project-slug>" } }',
        "Run `wf config edit` to add them.",
      ].join("\n"),
    );
  }

  const token =
    process.env["VERCEL_TOKEN"]?.trim() ||
    process.env["VERCEL_OIDC_TOKEN"]?.trim() ||
    (await vercelLoginToken());
  if (!token) {
    throw new OperationalError(
      [
        "No Vercel token found for cloud provisioning.",
        "Log in with `vercel login`, or set VERCEL_TOKEN to a Vercel access token.",
        "╰▶ https://vercel.com/account/tokens",
      ].join("\n"),
    );
  }

  return { token, teamId: team, projectId: project };
}

/**
 * Read the `vercel` CLI login token, refreshing it through its OAuth refresh
 * token when it is missing/expired/near expiry. Reuses the SDK's own auth store
 * and OAuth client (the same `vercel login` writes to), and persists the
 * refreshed token so the next run — and `vercel` itself — see it. Returns
 * undefined when there is no usable login (caller then emits the "log in" error).
 */
async function vercelLoginToken(): Promise<string | undefined> {
  const auth = safeGetAuth();
  if (!auth?.token) return undefined;

  const expiresAt =
    auth.expiresAt instanceof Date ? auth.expiresAt.getTime() : undefined;
  // No expiry (e.g. a PAT in auth.json) or comfortably fresh: use as-is.
  if (expiresAt === undefined || expiresAt - REFRESH_BUFFER_MS > Date.now()) {
    return auth.token;
  }
  // Expired/near expiry with no way to refresh: treat as unusable.
  if (!auth.refreshToken) return undefined;

  try {
    const oauth = await OAuth();
    const set = await oauth.refreshToken(auth.refreshToken);
    updateAuthConfig({
      token: set.access_token,
      refreshToken: set.refresh_token ?? auth.refreshToken,
      expiresAt: new Date(Date.now() + set.expires_in * 1000),
    });
    return set.access_token;
  } catch {
    return undefined;
  }
}

function safeGetAuth(): ReturnType<typeof getAuth> {
  try {
    return getAuth();
  } catch {
    return null;
  }
}

/**
 * Translate a raw SDK/API failure into an actionable error. A 404 from the
 * Vercel API almost always means the configured team or project slug does not
 * exist (or the token lacks access) rather than a missing sandbox, so surface the
 * scope being used. Other errors pass through unchanged.
 */
export function describeCloudError(
  error: unknown,
  credentials: CloudCredentials,
): Error {
  if (error instanceof UsageError || error instanceof OperationalError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/\b404\b|not ok|not found/i.test(message)) {
    return new OperationalError(
      [
        `Vercel rejected the request for team "${credentials.teamId}" / project "${credentials.projectId}".`,
        "Check that both slugs exist and your token has access — the project must already exist in the team.",
        `╰▶ ${message}`,
      ].join("\n"),
    );
  }
  return error instanceof Error ? error : new Error(message);
}
