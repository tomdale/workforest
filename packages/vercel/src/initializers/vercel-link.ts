import path from "node:path";
import {
  pathExists,
  runCommandGenerator,
  type InitializerContext,
  type InitializerDefinition,
  type WorkspaceConfig,
} from "@wf-plugin/core";

export const DEFAULT_VERCEL_TEAM_BY_GITHUB_OWNER: Record<string, string> = {
  vercel: "vercel",
  "vercel-labs": "vercel-labs",
};

type VercelRepoLinkTarget =
  | {
      kind: "link";
      githubOwner: string;
      githubSlug: string;
      team: string;
    }
  | { kind: "skip"; reason: string };

export function resolveVercelRepoLinkTarget(
  remote: string,
  config: WorkspaceConfig,
): VercelRepoLinkTarget {
  const githubSlug = getGitHubSlug(remote);
  if (!githubSlug) {
    return {
      kind: "skip",
      reason: "Vercel auto-link only supports GitHub repositories.",
    };
  }

  const [githubOwner] = githubSlug.split("/");
  if (!githubOwner) {
    return {
      kind: "skip",
      reason: `Unable to determine GitHub owner from "${githubSlug}".`,
    };
  }

  const repoOverride = config.vercelLink?.repoOverrides?.[githubSlug];
  if (repoOverride?.disabled) {
    return {
      kind: "skip",
      reason: `Vercel auto-link disabled for GitHub repo "${githubSlug}".`,
    };
  }

  const team =
    repoOverride?.team ??
    config.vercelLink?.teamByGitHubOwner?.[githubOwner] ??
    DEFAULT_VERCEL_TEAM_BY_GITHUB_OWNER[githubOwner];

  if (!team) {
    return {
      kind: "skip",
      reason: `No Vercel team mapping configured for GitHub owner "${githubOwner}".`,
    };
  }

  return {
    kind: "link",
    githubOwner,
    githubSlug,
    team,
  };
}

async function* execute(
  context: InitializerContext,
  _metadata: Record<string, unknown>,
) {
  const { repoDir } = context;
  const target = resolveVercelRepoLinkTarget(
    context.repo.remote,
    context.workspaceConfig ?? {},
  );

  if (target.kind === "skip") {
    yield { status: "skipped" as const, reason: target.reason };
    return;
  }

  const args = ["link", "--yes", "--repo", "--scope", target.team];
  const link = runCommandGenerator("vercel", args, { cwd: repoDir });
  let completed = false;

  for await (const state of link) {
    if (state.status === "completed") {
      completed = true;
      continue;
    }
    yield state;
  }

  if (!completed) {
    return;
  }

  const repoConfigPath = path.join(repoDir, ".vercel", "repo.json");
  if (!(await pathExists(repoConfigPath))) {
    yield {
      status: "skipped" as const,
      reason: `No existing Vercel projects linked to GitHub repo "${target.githubSlug}" under team "${target.team}".`,
    };
    return;
  }

  yield { status: "completed" as const };
}

const vercelLinkInitializer: InitializerDefinition = {
  id: "vercel-link",
  name: "Vercel link",
  execute,
};

export default vercelLinkInitializer;

function getGitHubSlug(remote: string): string | null {
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
