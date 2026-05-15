import { getNodeVersionPrefix } from "../../utils/node-version.ts";
import { TailBuffer } from "../../utils/tail-buffer.ts";
import { runCommandGenerator } from "../../utils/task-generator.ts";
import {
  canSkipInstall,
  computeLockfileHash,
  hasAny,
  storeLockfileHash,
} from "../pnpm.ts";
import type {
  InitializerContext,
  InitializerDefinition,
  InitializerDetection,
} from "./types.ts";

const PNPM_LOCK_FILES = ["pnpm-lock.yaml", "pnpm-lock.yml"];
const INSTALL_OUTPUT_TAIL_CHARS = 16_384;

/**
 * Detect if this is a pnpm project.
 */
async function detect(
  context: InitializerContext,
): Promise<InitializerDetection> {
  const hasLockfile = await hasAny(context.repoDir, PNPM_LOCK_FILES);
  return { shouldRun: hasLockfile };
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

/**
 * Install pnpm dependencies with lockfile hash optimization.
 * Strategy:
 * 1. Check if install can be skipped (lockfile hash matches stored hash)
 * 2. Run pnpm install with --frozen-lockfile --prefer-offline
 * 3. If frozen-lockfile fails (stale lockfile), retry without it
 * 4. Store lockfile hash after successful install
 */
async function* execute(context: InitializerContext) {
  const { repoDir } = context;

  // Check if we can skip install based on lockfile hash (node_modules exists and matches)
  if (await canSkipInstall(repoDir)) {
    yield {
      status: "skipped" as const,
      reason: "Lockfile unchanged, node_modules up to date",
    };
    return;
  }

  // Compute hash for storing after install
  const lockfileHash = await computeLockfileHash(repoDir);

  const versionPrefix = await getNodeVersionPrefix(repoDir);

  yield { status: "running" as const, message: "Installing (frozen-lockfile)" };

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
    yield {
      status: "retrying" as const,
      reason: "Lockfile out of sync",
      attempt: 1,
    };

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
    let fallbackFailed = false;
    for await (const state of fallbackInstall) {
      if (state.status === "failed") {
        fallbackFailed = true;
      }
      yield state;
    }

    // Store hash on successful fallback install
    if (!fallbackFailed && lockfileHash) {
      await storeLockfileHash(repoDir, lockfileHash);
    }
  } else if (failed && lastError) {
    yield { status: "failed" as const, error: lastError };
  } else if (failed) {
    yield {
      status: "failed" as const,
      error: new Error("Unknown error during install"),
    };
  } else {
    // Fast install succeeded - store the lockfile hash
    if (lockfileHash) {
      await storeLockfileHash(repoDir, lockfileHash);
    }
  }
}

export const pnpmInstallInitializer: InitializerDefinition = {
  id: "pnpm-install",
  name: "pnpm install",
  priority: 100,
  detect,
  execute,
};
