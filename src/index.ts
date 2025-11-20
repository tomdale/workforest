import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import arg from "arg";
import chalk from "chalk";

type RepoConfig = {
  name: string;
  remote: string;
  defaultBranch: string;
};

type RunCommandOptions = {
  cwd?: string;
  capture?: boolean;
};

const REPOSITORIES: RepoConfig[] = [
  {
    name: "front",
    remote: "git@github.com:vercel/front.git",
    defaultBranch: "main",
  },
  {
    name: "api",
    remote: "git@github.com:vercel/api.git",
    defaultBranch: "main",
  },
];

const log = {
  info: (...messages: unknown[]) =>
    console.log(chalk.cyan("[info]"), ...messages),
  warn: (...messages: unknown[]) =>
    console.warn(chalk.yellow("[warn]"), ...messages),
  error: (...messages: unknown[]) =>
    console.error(chalk.red("[error]"), ...messages),
  success: (...messages: unknown[]) =>
    console.log(chalk.green("[done]"), ...messages),
};

export async function cli(): Promise<void> {
  const args = arg(
    {
      "--help": Boolean,
      "-h": "--help",
    },
    { argv: process.argv.slice(2) },
  );

  if (args["--help"]) {
    printHelp();
    return;
  }

  const featureName = args._[0];

  if (!featureName?.trim()) {
    log.error("Missing <feature-name> argument.");
    printHelp();
    process.exitCode = 1;
    return;
  }

  const normalizedFeature = featureName.trim().replace(/\s+/g, "-");
  const workspaceDir = path.resolve(
    process.cwd(),
    `vercel-${normalizedFeature}`,
  );
  const cacheDir = await ensureCacheDir();

  await fs.mkdir(workspaceDir, { recursive: true });
  log.info(`Stamping workspace at ${workspaceDir}`);

  await Promise.all(
    REPOSITORIES.map((repo) =>
      prepareRepository({
        repo,
        cacheDir,
        workspaceDir,
      }),
    ),
  );

  log.success("Workspace ready.");
  log.info("Happy shipping!");
}

async function ensureCacheDir(): Promise<string> {
  const cacheHome =
    process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  const cacheRoot = path.join(cacheHome, "vercel-workspace");
  await fs.mkdir(cacheRoot, { recursive: true });
  return cacheRoot;
}

async function prepareRepository({
  repo,
  cacheDir,
  workspaceDir,
}: {
  repo: RepoConfig;
  cacheDir: string;
  workspaceDir: string;
}) {
  const mirrorDir = path.join(cacheDir, `${repo.name}.git`);
  await ensureMirrorRepo(repo, mirrorDir);

  const targetDir = path.join(workspaceDir, repo.name);
  await ensureWorkingCopy(repo, mirrorDir, targetDir);
}

async function ensureMirrorRepo(repo: RepoConfig, mirrorDir: string) {
  const mirrorExists = await pathExists(mirrorDir);

  if (!mirrorExists) {
    log.info(`Seeding mirror for ${repo.name}`);
    await withRetry(
      () => runGit(["clone", "--mirror", repo.remote, mirrorDir], {}),
      { attempts: 3, label: `clone-mirror:${repo.name}` },
    );
    return;
  }

  try {
    await withRetry(
      () => runGit(["fetch", "--all", "--prune"], { cwd: mirrorDir }),
      { attempts: 3, label: `update-mirror:${repo.name}` },
    );
  } catch (error_) {
    log.warn(
      `Unable to update mirror for ${repo.name}. Using the last cached snapshot.`,
    );
    log.warn(String(error_));
  }
}

async function ensureWorkingCopy(
  repo: RepoConfig,
  mirrorDir: string,
  targetDir: string,
) {
  const workingCopyExists = await pathExists(targetDir);

  if (!workingCopyExists) {
    log.info(`Cloning ${repo.name} into workspace`);
    await withRetry(
      () =>
        runGit(
          ["clone", "--reference-if-able", mirrorDir, repo.remote, targetDir],
          {},
        ),
      { attempts: 3, label: `clone:${repo.name}` },
    );
  } else {
    log.info(`Reusing existing checkout for ${repo.name}`);
  }

  const clean = await isWorkingTreeClean(targetDir);
  if (!clean) {
    log.warn(
      `${repo.name} has local changes. Skipping automatic reset to origin/${repo.defaultBranch}.`,
    );
    return;
  }

  try {
    await withRetry(
      () => runGit(["fetch", "origin", "--prune"], { cwd: targetDir }),
      { attempts: 3, label: `fetch:${repo.name}` },
    );
  } catch (error_) {
    log.warn(
      `Unable to fetch latest changes for ${repo.name}. Using cached refs.`,
    );
    log.warn(String(error_));
  }

  await runGit(["checkout", repo.defaultBranch], { cwd: targetDir });
  await runGit(["reset", "--hard", `origin/${repo.defaultBranch}`], {
    cwd: targetDir,
  });
}

async function isWorkingTreeClean(repoDir: string): Promise<boolean> {
  const { stdout } = await runGit(["status", "--porcelain"], {
    cwd: repoDir,
    capture: true,
  });
  return stdout.trim().length === 0;
}

async function withRetry<T>(
  task: () => Promise<T>,
  {
    attempts,
    label,
  }: {
    attempts: number;
    label: string;
  },
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error_) {
      lastError = error_;
      const delay = attempt * 1000;
      if (attempt < attempts) {
        log.warn(
          `${label} failed (attempt ${attempt}/${attempts}). Retrying in ${delay}ms...`,
        );
        await wait(delay);
      } else {
        log.warn(`${label} failed on final attempt (${attempts}/${attempts}).`);
      }
    }
  }

  throw lastError ?? new Error(`${label} failed after ${attempts} attempts.`);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch (error_) {
    if ((error_ as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error_;
  }
}

async function runGit(
  args: string[],
  options: RunCommandOptions,
): Promise<{ stdout: string; stderr: string }> {
  return runCommand("git", args, options);
}

function runCommand(
  command: string,
  args: string[],
  { cwd, capture = false }: RunCommandOptions,
): Promise<{ stdout: string; stderr: string }> {
  log.info(`$ ${command} ${args.join(" ")}`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: capture
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "inherit", "inherit"],
    });

    let stdout = "";
    let stderr = "";

    if (capture) {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
    }

    child.on("error", (error_: Error) => reject(error_));
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with code ${code}. ${stderr}`,
          ),
        );
      }
    });
  });
}

function printHelp() {
  console.log(`Usage: vercel-workspace <feature-name>

Creates a workspace directory (vercel-<feature-name>) and stamps the
vercel/front and vercel/api repositories into it by cloning from cached
bare mirrors under $XDG_CACHE_HOME/vercel-workspace.
`);
}
