import { promises as fs } from "node:fs";
import path from "node:path";
import {
  pathExists,
  runCommandGenerator,
  runParallel,
  type InitializerContext,
  type InitializerDefinition,
  type TaskGenerator,
  type WorkspaceConfig,
} from "@wf-plugin/core";

export const DEFAULT_VERCEL_TEAM_BY_GITHUB_OWNER: Record<string, string> = {
  vercel: "vercel",
  "vercel-labs": "vercel-labs",
};

export const MAX_CONCURRENT_ENV_PULLS = 6;

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

  const envPullTargets = await getEnvPullTargets(repoDir);
  if (envPullTargets.kind === "failed") {
    yield { status: "failed" as const, error: envPullTargets.error };
    return;
  }

  if (envPullTargets.warning) {
    yield {
      status: "log" as const,
      level: "warn" as const,
      message: envPullTargets.warning,
    };
  }

  let envPullFailed = false;
  for await (const { state } of runParallel(createEnvPullTasks(envPullTargets.cwd), {
    maxConcurrent: MAX_CONCURRENT_ENV_PULLS,
  })) {
    if (state.status === "completed") {
      continue;
    }

    if (state.status === "failed") {
      envPullFailed = true;
    }

    yield state;
  }

  if (envPullFailed) {
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

function createEnvPullTasks(cwds: string[]): Map<string, TaskGenerator> {
  return new Map(
    cwds.map((cwd, index) => [
      String(index),
      runCommandGenerator(
        "vercel",
        ["env", "pull", "--environment", "development", "--yes"],
        { cwd },
      ),
    ]),
  );
}

type EnvPullTargets =
  | { kind: "pull"; cwd: string[]; warning?: string }
  | { kind: "failed"; error: Error };

async function getEnvPullTargets(repoDir: string): Promise<EnvPullTargets> {
  const repoConfigPath = path.join(repoDir, ".vercel", "repo.json");
  if (await pathExists(repoConfigPath)) {
    return getRepoEnvPullTargets(repoDir, repoConfigPath);
  }

  const projectConfigPath = path.join(repoDir, ".vercel", "project.json");
  if (await pathExists(projectConfigPath)) {
    return { kind: "pull", cwd: [repoDir] };
  }

  return {
    kind: "pull",
    cwd: [repoDir],
    warning:
      "Neither .vercel/repo.json nor .vercel/project.json was found after vercel link; pulling development env at the repo root.",
  };
}

async function getRepoEnvPullTargets(
  repoDir: string,
  repoConfigPath: string,
): Promise<EnvPullTargets> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(repoConfigPath, "utf8"));
  } catch (error) {
    return {
      kind: "failed",
      error: new Error(`Failed to parse ${repoConfigPath}: ${formatError(error)}`),
    };
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { projects?: unknown }).projects)
  ) {
    return {
      kind: "failed",
      error: new Error(`${repoConfigPath} must contain a projects array.`),
    };
  }

  const projects = (parsed as { projects: unknown[] }).projects;
  const directories = projects
    .map((project) =>
      typeof project === "object" && project !== null
        ? (project as { directory?: unknown }).directory
        : undefined,
    )
    .filter((directory): directory is string => typeof directory === "string");

  return {
    kind: "pull",
    cwd: directories.map((directory) => path.join(repoDir, directory)),
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
