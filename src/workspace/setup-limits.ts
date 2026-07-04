import { loadWorkspaceConfig } from "../config.ts";

/**
 * Operational limits for workspace/worktree setup. Kept in one place so the
 * pipeline's behavior under slow networks and stuck commands is auditable.
 * Initializer-specific limits (e.g. pnpm install) live with their plugins.
 */

/** A cold clone of a large repo can legitimately take a while. */
export const GIT_CLONE_TIMEOUT_MS = 15 * 60 * 1000;
/** But git reports progress continuously; silence means a stalled transfer. */
export const GIT_CLONE_INACTIVITY_TIMEOUT_MS = 120 * 1000;

export const GIT_FETCH_TIMEOUT_MS = 5 * 60 * 1000;
export const GIT_FETCH_INACTIVITY_TIMEOUT_MS = 60 * 1000;

/**
 * Default cap on repositories set up concurrently. Bounds the thundering
 * herd of clones, checkouts, and installs on large workspaces.
 */
export const DEFAULT_SETUP_MAX_CONCURRENT = 4;

/**
 * Resolve the setup concurrency cap: WORKFOREST_MAX_CONCURRENT wins, then
 * config `setup.maxConcurrent`, then the default. Zero means unlimited.
 */
export function resolveSetupMaxConcurrent(configured?: number): number {
  const fromEnvironment = parseMaxConcurrent(
    process.env["WORKFOREST_MAX_CONCURRENT"],
  );
  const value = fromEnvironment ?? configured ?? DEFAULT_SETUP_MAX_CONCURRENT;
  return value === 0 ? Number.POSITIVE_INFINITY : value;
}

/**
 * Resolve the cap from global config, for call sites that do not already
 * hold a loaded config.
 */
export async function resolveConfiguredMaxConcurrent(): Promise<number> {
  try {
    const { config } = await loadWorkspaceConfig();
    return resolveSetupMaxConcurrent(config.setup?.maxConcurrent);
  } catch {
    return resolveSetupMaxConcurrent();
  }
}

function parseMaxConcurrent(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}
