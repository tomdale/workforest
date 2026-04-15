import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DEFAULT_VERCEL_TEAM_BY_GITHUB_OWNER,
  loadWorkspaceConfig,
} from "../../config.ts";
import type { WorkspaceConfig } from "../../types.ts";
import { pathExists } from "../../utils/fs.ts";
import { runCommandGenerator } from "../../utils/task-generator.ts";
import { getGitHubSlug } from "../git.ts";
import { hasAny } from "../pnpm.ts";
import type {
  InitializerContext,
  InitializerDefinition,
  InitializerDetection,
} from "./types.ts";

/**
 * Check if the project uses vercel based on package.json dependencies or scripts.
 */
async function hasVercelInPackageJson(dir: string): Promise<boolean> {
  try {
    const packageJsonPath = path.join(dir, "package.json");
    const content = await fs.readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(content) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    // Check if vercel is in dependencies or devDependencies
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps["vercel"]) {
      return true;
    }

    // Check if any script references vercel
    if (pkg.scripts) {
      for (const script of Object.values(pkg.scripts)) {
        if (script.includes("vercel")) {
          return true;
        }
      }
    }

    return false;
  } catch {
    return false;
  }
}

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

/**
 * Detect if vercel link should run.
 * Conditions:
 * - Has vercel.json OR vercel in package.json deps/scripts
 * - No .vercel directory (not already linked)
 */
async function detect(
  context: InitializerContext,
): Promise<InitializerDetection> {
  // Check if already linked
  const vercelDir = path.join(context.repoDir, ".vercel");
  if (await pathExists(vercelDir)) {
    return { shouldRun: false };
  }

  // Check for vercel.json
  const hasVercelJson = await hasAny(context.repoDir, ["vercel.json"]);

  // Check for vercel in package.json
  const hasVercelDep = await hasVercelInPackageJson(context.repoDir);

  if (!hasVercelJson && !hasVercelDep) {
    return { shouldRun: false };
  }
  return { shouldRun: true };
}

/**
 * Run vercel link.
 */
async function* execute(
  context: InitializerContext,
  _metadata: Record<string, unknown>,
) {
  const { repoDir } = context;

  let config: WorkspaceConfig;
  try {
    ({ config } = await loadWorkspaceConfig());
  } catch (error) {
    yield {
      status: "failed" as const,
      error: error instanceof Error ? error : new Error(String(error)),
    };
    return;
  }

  const target = resolveVercelRepoLinkTarget(context.repo.remote, config);
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

export const vercelLinkInitializer: InitializerDefinition = {
  id: "vercel-link",
  name: "Vercel link",
  priority: 200,
  detect,
  execute,
};
