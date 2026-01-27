import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "../../utils/fs.ts";
import { runCommandGenerator } from "../../utils/task-generator.ts";
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

/**
 * Detect if this is a monorepo (has turbo.json or workspaces in package.json).
 */
async function isMonorepo(workspaceDir: string): Promise<boolean> {
  // Check for turbo.json in workspace root
  if (await pathExists(path.join(workspaceDir, "turbo.json"))) {
    return true;
  }

  // Check for workspaces in root package.json
  try {
    const packageJsonPath = path.join(workspaceDir, "package.json");
    const content = await fs.readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(content) as {
      workspaces?: string[] | { packages?: string[] };
    };

    if (pkg.workspaces) {
      return true;
    }
  } catch {
    // No package.json or invalid JSON
  }

  return false;
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

  // Detect if this is a monorepo to use --repo flag
  const useRepoFlag = await isMonorepo(context.workspaceDir);

  return {
    shouldRun: true,
    metadata: { useRepoFlag },
  };
}

/**
 * Run vercel link.
 */
async function* execute(
  context: InitializerContext,
  metadata: Record<string, unknown>,
) {
  const { repoDir } = context;
  const useRepoFlag = metadata["useRepoFlag"] === true;

  const args = ["link", "--yes"];
  if (useRepoFlag) {
    args.push("--repo");
  }

  yield { status: "running" as const, message: `vercel ${args.join(" ")}` };

  const link = runCommandGenerator("vercel", args, { cwd: repoDir });

  for await (const state of link) {
    yield state;
  }
}

export const vercelLinkInitializer: InitializerDefinition = {
  id: "vercel-link",
  name: "Vercel link",
  priority: 200,
  detect,
  execute,
};
