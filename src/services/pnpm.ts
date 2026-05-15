import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { log } from "../logger.ts";
import type { RepoConfig, RunCommandOptions } from "../types.ts";
import { runCommand } from "../utils/exec.ts";
import { pathExists } from "../utils/fs.ts";
import { getNodeVersionPrefix } from "../utils/node-version.ts";
import { withRetry } from "../utils/retry.ts";
import { TailBuffer } from "../utils/tail-buffer.ts";
import {
  runCommandGenerator,
  type TaskGenerator,
} from "../utils/task-generator.ts";

const PNPM_LOCK_FILES = ["pnpm-lock.yaml", "pnpm-lock.yml"];
const LOCKFILE_HASH_FILE = ".pnpm-lockfile-hash";
const INSTALL_OUTPUT_TAIL_CHARS = 16_384;

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

  const versionPrefix = await getNodeVersionPrefix(repoDir);

  yield { status: "running", message: "Installing (frozen-lockfile)" };

  // Collect output from the fast install to check for errors
  let failed = false;
  let lastError: Error | undefined;
  const collectedOutput = new TailBuffer(INSTALL_OUTPUT_TAIL_CHARS);

  // Try fast path first: frozen-lockfile + prefer-offline
  let command: string;
  let args: string[];
  if (versionPrefix) {
    command = versionPrefix.command;
    args = [
      ...versionPrefix.args,
      "pnpm",
      "install",
      "--frozen-lockfile",
      "--prefer-offline",
    ];
  } else {
    command = "pnpm";
    args = ["install", "--frozen-lockfile", "--prefer-offline"];
  }

  const fastInstall = runCommandGenerator(command, args, { cwd: repoDir });

  for await (const state of fastInstall) {
    if (state.status === "failed") {
      failed = true;
      lastError = state.error;
      // Don't yield failure yet - check if it's recoverable
    } else if (state.status === "output") {
      collectedOutput.append(state.data);
      yield state;
    } else {
      yield state;
    }
  }

  // Check if this was a frozen-lockfile error (recoverable)
  if (
    failed &&
    lastError &&
    isFrozenLockfileError(lastError, collectedOutput.toString())
  ) {
    yield { status: "retrying", reason: "Lockfile out of sync", attempt: 1 };

    // Retry without --frozen-lockfile
    if (versionPrefix) {
      command = versionPrefix.command;
      args = [...versionPrefix.args, "pnpm", "install"];
    } else {
      command = "pnpm";
      args = ["install"];
    }

    const fallbackInstall = runCommandGenerator(command, args, {
      cwd: repoDir,
    });

    // Track fallback result
    for await (const state of fallbackInstall) {
      yield state;
    }
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

// ============================================================================
// Lockfile hash caching for skipping unnecessary installs
// ============================================================================

/**
 * Compute SHA256 hash of the pnpm lockfile.
 * Returns null if no lockfile exists.
 */
export async function computeLockfileHash(
  repoDir: string,
): Promise<string | null> {
  for (const filename of PNPM_LOCK_FILES) {
    const lockfilePath = path.join(repoDir, filename);
    if (await pathExists(lockfilePath)) {
      const content = await fs.readFile(lockfilePath);
      return crypto.createHash("sha256").update(content).digest("hex");
    }
  }
  return null;
}

/**
 * Get the stored lockfile hash from a previous install.
 * Returns null if no hash is stored.
 */
export async function getStoredLockfileHash(
  repoDir: string,
): Promise<string | null> {
  const hashFilePath = path.join(repoDir, "node_modules", LOCKFILE_HASH_FILE);
  if (await pathExists(hashFilePath)) {
    const content = await fs.readFile(hashFilePath, "utf8");
    return content.trim();
  }
  return null;
}

/**
 * Store the lockfile hash after a successful install.
 */
export async function storeLockfileHash(
  repoDir: string,
  hash: string,
): Promise<void> {
  const nodeModulesDir = path.join(repoDir, "node_modules");
  if (await pathExists(nodeModulesDir)) {
    const hashFilePath = path.join(nodeModulesDir, LOCKFILE_HASH_FILE);
    await fs.writeFile(hashFilePath, hash, "utf8");
  }
}

/**
 * Check if install can be skipped based on lockfile hash.
 * Returns true if node_modules exists and lockfile hash matches.
 */
export async function canSkipInstall(repoDir: string): Promise<boolean> {
  const nodeModulesDir = path.join(repoDir, "node_modules");
  if (!(await pathExists(nodeModulesDir))) {
    return false;
  }

  const currentHash = await computeLockfileHash(repoDir);
  if (!currentHash) {
    return false;
  }

  const storedHash = await getStoredLockfileHash(repoDir);
  return currentHash === storedHash;
}
