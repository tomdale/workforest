import path from "node:path";
import { log } from "../logger.ts";
import type { RepoConfig, RunCommandOptions } from "../types.ts";
import { runCommand } from "../utils/exec.ts";
import { pathExists } from "../utils/fs.ts";
import { withRetry } from "../utils/retry.ts";
import {
  runCommandGenerator,
  type TaskGenerator,
} from "../utils/task-generator.ts";

const PNPM_LOCK_FILES = ["pnpm-lock.yaml", "pnpm-lock.yml"];
const TURBO_CONFIG_FILES = ["turbo.json", "turbo.jsonc"];

/**
 * Generator-based dependency installation with frozen-lockfile optimization.
 * Yields state updates for UI consumption.
 *
 * Strategy:
 * 1. Try fast path with --frozen-lockfile --prefer-offline
 * 2. If frozen-lockfile fails (stale lockfile), retry without it
 */
export async function* installDependencies(
  _repo: RepoConfig,
  repoDir: string,
): TaskGenerator {
  yield { status: "running", message: "Checking for lockfile" };

  const hasLockFile = await hasAny(repoDir, PNPM_LOCK_FILES);
  if (!hasLockFile) {
    yield { status: "skipped", reason: "No pnpm lockfile" };
    return;
  }

  yield { status: "running", message: "Installing (frozen-lockfile)" };

  // Collect output from the fast install to check for errors
  let failed = false;
  let lastError: Error | undefined;
  let collectedOutput = "";

  // Try fast path first: frozen-lockfile + prefer-offline
  const fastInstall = runCommandGenerator(
    "pnpm",
    ["install", "--frozen-lockfile", "--prefer-offline"],
    { cwd: repoDir },
  );

  for await (const state of fastInstall) {
    if (state.status === "failed") {
      failed = true;
      lastError = state.error;
      // Don't yield failure yet - check if it's recoverable
    } else if (state.status === "output") {
      collectedOutput += state.data;
      yield state;
    } else {
      yield state;
    }
  }

  // Check if this was a frozen-lockfile error (recoverable)
  if (
    failed &&
    lastError &&
    isFrozenLockfileError(lastError, collectedOutput)
  ) {
    yield { status: "retrying", reason: "Lockfile out of sync", attempt: 1 };

    // Retry without --frozen-lockfile
    const fallbackInstall = runCommandGenerator("pnpm", ["install"], {
      cwd: repoDir,
    });

    yield* fallbackInstall;
  } else if (failed && lastError) {
    yield { status: "failed", error: lastError };
  } else if (failed) {
    yield {
      status: "failed",
      error: new Error("Unknown error during install"),
    };
  }
}

/**
 * Generator-based turbo link.
 */
export async function* linkTurbo(
  _repo: RepoConfig,
  repoDir: string,
): TaskGenerator {
  yield { status: "running", message: "Checking for turbo config" };

  const hasTurboConfig = await hasAny(repoDir, TURBO_CONFIG_FILES);
  if (!hasTurboConfig) {
    yield { status: "skipped", reason: "No turbo config" };
    return;
  }

  yield { status: "running", message: "Linking turbo cache" };

  const linkGen = runCommandGenerator(
    "pnpm",
    ["turbo", "link", "--scope", "vercel", "--yes"],
    { cwd: repoDir },
  );

  yield* linkGen;
}

/**
 * Check if the error is due to frozen-lockfile mismatch.
 * pnpm emits ERR_PNPM_OUTDATED_LOCKFILE when the lockfile doesn't match package.json.
 */
function isFrozenLockfileError(error: Error, output: string): boolean {
  const combined = `${error.message} ${output}`;
  return (
    combined.includes("ERR_PNPM_OUTDATED_LOCKFILE") ||
    combined.includes('Cannot install with "frozen-lockfile"') ||
    combined.includes("frozen-lockfile")
  );
}

// ============================================================================
// Legacy functions (for backwards compatibility during transition)
// ============================================================================

/**
 * @deprecated Use installDependencies generator instead
 */
export async function installDependenciesIfNeeded(
  repo: RepoConfig,
  repoDir: string,
): Promise<void> {
  const hasLockFile = await hasAny(repoDir, PNPM_LOCK_FILES);

  if (!hasLockFile) {
    log.info(
      `${repo.name}: no pnpm lockfile detected. Skipping dependency install.`,
    );
    return;
  }

  log.info(`${repo.name}: installing dependencies via pnpm install.`);
  await withRetry(() => runPnpm(["install"], { cwd: repoDir }), {
    attempts: 3,
    label: `pnpm-install:${repo.name}`,
  });
}

/**
 * @deprecated Use linkTurbo generator instead
 */
export async function turboLinkIfNeeded(
  repo: RepoConfig,
  repoDir: string,
): Promise<void> {
  const hasTurboConfig = await hasAny(repoDir, TURBO_CONFIG_FILES);

  if (!hasTurboConfig) {
    log.info(`${repo.name}: no turbo config detected. Skipping turbo link.`);
    return;
  }

  log.info(`${repo.name}: linking turbo cache for scope "vercel".`);
  await withRetry(
    () =>
      runPnpm(["turbo", "link", "--scope", "vercel", "--yes"], {
        cwd: repoDir,
      }),
    { attempts: 3, label: `turbo-link:${repo.name}` },
  );
}

// ============================================================================
// Helpers
// ============================================================================

export async function hasAny(
  dir: string,
  filenames: string[],
): Promise<boolean> {
  for (const filename of filenames) {
    if (await pathExists(path.join(dir, filename))) {
      return true;
    }
  }
  return false;
}

function runPnpm(
  args: string[],
  options: RunCommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return runCommand("pnpm", args, options);
}
