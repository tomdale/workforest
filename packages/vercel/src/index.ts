import { promises as fs } from "node:fs";
import path from "node:path";
import {
  hasAny,
  pathExists,
  type InitializerContext,
  type PluginDetection,
} from "@wf-plugin/core";

async function hasVercelInPackageJson(dir: string): Promise<boolean> {
  try {
    const packageJsonPath = path.join(dir, "package.json");
    const content = await fs.readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(content) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps["vercel"]) {
      return true;
    }

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

export async function detect(
  context: InitializerContext,
): Promise<PluginDetection> {
  const vercelDir = path.join(context.repoDir, ".vercel");
  if (await pathExists(vercelDir)) {
    return { activate: false };
  }

  const hasVercelJson = await hasAny(context.repoDir, ["vercel.json"]);
  const hasVercelDep = await hasVercelInPackageJson(context.repoDir);

  if (!hasVercelJson && !hasVercelDep) {
    return { activate: false };
  }

  return { activate: true, initializers: ["vercel-link"] };
}
