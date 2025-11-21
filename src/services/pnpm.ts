import path from "node:path";
import { log } from "../logger.ts";
import type { RepoConfig, RunCommandOptions } from "../types.ts";
import { runCommand } from "../utils/exec.ts";
import { pathExists } from "../utils/fs.ts";
import { withRetry } from "../utils/retry.ts";

const PNPM_LOCK_FILES = ["pnpm-lock.yaml", "pnpm-lock.yml"];
const TURBO_CONFIG_FILES = ["turbo.json", "turbo.jsonc"];

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

async function hasAny(dir: string, filenames: string[]): Promise<boolean> {
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
