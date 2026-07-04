import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  getNodeVersionPrefix,
  pathExists,
  spawnCommand,
  TailBuffer,
  type InitializerContext,
  type InitializerDefinition,
} from "@wf-plugin/core";

const PNPM_LOCK_FILES = ["pnpm-lock.yaml", "pnpm-lock.yml"];
const LOCKFILE_HASH_FILE = ".pnpm-lockfile-hash";
const INSTALL_OUTPUT_TAIL_CHARS = 16_384;
/** Very large monorepos can take a while, but not forever. */
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
/** pnpm reports progress continuously; silence means a stalled install. */
const INSTALL_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const INSTALL_LIMITS = {
  timeoutMs: INSTALL_TIMEOUT_MS,
  inactivityTimeoutMs: INSTALL_INACTIVITY_TIMEOUT_MS,
};

function isFrozenLockfileError(error: Error, output: string): boolean {
  const combined = `${error.message} ${output}`;
  return (
    combined.includes("ERR_PNPM_OUTDATED_LOCKFILE") ||
    combined.includes('Cannot install with "frozen-lockfile"') ||
    combined.includes("frozen-lockfile")
  );
}

async function* execute(context: InitializerContext) {
  const { repoDir } = context;

  if (await canSkipInstall(repoDir)) {
    yield {
      status: "skipped" as const,
      reason: "Lockfile unchanged, node_modules up to date",
    };
    return;
  }

  const lockfileHash = await computeLockfileHash(repoDir);
  const versionPrefix = await getNodeVersionPrefix(repoDir);

  yield { status: "running" as const, message: "Installing (frozen-lockfile)" };

  let failed = false;
  let lastError: Error | undefined;
  const collectedOutput = new TailBuffer(INSTALL_OUTPUT_TAIL_CHARS);

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

  const fastInstall = spawnCommand(command, args, {
    cwd: repoDir,
    ...INSTALL_LIMITS,
  });

  for await (const state of fastInstall) {
    if (state.status === "failed") {
      failed = true;
      lastError = state.error;
    } else if (state.status === "output") {
      collectedOutput.append(state.data);
      yield state;
    } else {
      yield state;
    }
  }

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

    if (versionPrefix) {
      command = versionPrefix.command;
      args = [...versionPrefix.args, "pnpm", "install"];
    } else {
      command = "pnpm";
      args = ["install"];
    }

    const fallbackInstall = spawnCommand(command, args, {
      cwd: repoDir,
      ...INSTALL_LIMITS,
    });

    let fallbackFailed = false;
    for await (const state of fallbackInstall) {
      if (state.status === "failed") {
        fallbackFailed = true;
      }
      yield state;
    }

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
  } else if (lockfileHash) {
    await storeLockfileHash(repoDir, lockfileHash);
  }
}

const pnpmInstallInitializer: InitializerDefinition = {
  id: "pnpm-install",
  name: "pnpm install",
  execute,
};

export default pnpmInstallInitializer;

async function computeLockfileHash(repoDir: string): Promise<string | null> {
  for (const filename of PNPM_LOCK_FILES) {
    const lockfilePath = path.join(repoDir, filename);
    if (await pathExists(lockfilePath)) {
      const content = await fs.readFile(lockfilePath);
      return crypto.createHash("sha256").update(content).digest("hex");
    }
  }
  return null;
}

async function getStoredLockfileHash(repoDir: string): Promise<string | null> {
  const hashFilePath = path.join(repoDir, "node_modules", LOCKFILE_HASH_FILE);
  if (await pathExists(hashFilePath)) {
    const content = await fs.readFile(hashFilePath, "utf8");
    return content.trim();
  }
  return null;
}

async function storeLockfileHash(repoDir: string, hash: string): Promise<void> {
  const nodeModulesDir = path.join(repoDir, "node_modules");
  if (await pathExists(nodeModulesDir)) {
    const hashFilePath = path.join(nodeModulesDir, LOCKFILE_HASH_FILE);
    await fs.writeFile(hashFilePath, hash, "utf8");
  }
}

async function canSkipInstall(repoDir: string): Promise<boolean> {
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
