import type { WorkspaceConfig } from "../types.ts";

/**
 * Resolve the Vercel team for a repo, mirroring the `@wf-plugin/vercel`
 * initializer's rule (repo override → owner mapping → valid GitHub owner) so
 * the in-sandbox `vercel link --scope` matches what local changes get. Lifted
 * here rather than imported because the plugin's copy is private and typed
 * against the plugin's own config shape; the logic is small and stable.
 */
export function resolveVercelTeam(
  remote: string,
  config: WorkspaceConfig,
): string | undefined {
  if (config.cloud?.vercel?.team) {
    return config.cloud.vercel.team;
  }

  const slug = githubSlug(remote);
  if (!slug) return undefined;
  const [owner] = slug.split("/");
  if (!owner) return undefined;

  const override = config.vercelLink?.repoOverrides?.[slug];
  if (override?.disabled) return undefined;

  return (
    override?.team ??
    config.vercelLink?.teamByGitHubOwner?.[owner] ??
    (isValidVercelScope(owner) ? owner : undefined)
  );
}

function githubSlug(remote: string): string | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;

  const ssh = trimmed.match(/^git@github\.com:(.+)$/i);
  if (ssh?.[1]) return ssh[1].replace(/\.git$/, "");

  const https = trimmed.match(/^https?:\/\/github\.com\/(.+)$/i);
  if (https?.[1]) return https[1].replace(/\.git$/, "");

  return null;
}

function isValidVercelScope(input: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(input);
}

/**
 * The HTTPS clone URL for a repo, derived from its configured remote. Cloud
 * sandboxes clone over HTTPS (not SSH) so the firewall can broker the GitHub
 * credential; SSH remotes are rewritten to their HTTPS form.
 */
export function httpsCloneUrl(remote: string): string {
  const slug = githubSlug(remote);
  if (slug) return `https://github.com/${slug}.git`;
  return remote;
}
