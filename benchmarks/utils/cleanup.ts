import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "../../src/utils/fs.ts";

/**
 * Clean up benchmark directories between runs.
 */
export async function cleanupBenchmarkDirs(options: {
  cacheDir: string;
  workspaceDir: string;
  keepCache?: boolean;
}): Promise<void> {
  const { cacheDir, workspaceDir, keepCache = false } = options;

  // Always clean workspace
  if (await pathExists(workspaceDir)) {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }

  // Optionally clean cache (for cold start benchmarks)
  if (!keepCache && (await pathExists(cacheDir))) {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
}

/**
 * Set up isolated directories for benchmarking.
 * Uses temp directories to avoid polluting user's cache.
 */
export async function setupBenchmarkDirs(): Promise<{
  cacheDir: string;
  configDir: string;
  workspaceBaseDir: string;
}> {
  const baseDir = path.join(process.cwd(), ".agent", "benchmark");

  const cacheDir = path.join(baseDir, "cache");
  const configDir = path.join(baseDir, "config");
  const workspaceBaseDir = path.join(baseDir, "workspaces");

  await fs.mkdir(cacheDir, { recursive: true });
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(workspaceBaseDir, { recursive: true });

  return { cacheDir, configDir, workspaceBaseDir };
}

/**
 * Clean up all benchmark directories.
 */
export async function cleanupAllBenchmarkDirs(): Promise<void> {
  const baseDir = path.join(process.cwd(), ".agent", "benchmark");
  if (await pathExists(baseDir)) {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
}
