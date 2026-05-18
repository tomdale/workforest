import { spawnSync } from "node:child_process";

const INHERITED_ENV_KEYS = new Set([
  "CI",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GPG_AGENT_INFO",
  "SSH_AUTH_SOCK",
  "VERCEL_TOKEN",
]);

const INHERITED_ENV_PREFIXES = [
  "GITHUB_",
  "NPM_CONFIG_",
  "npm_config_",
  "TURBO_",
  "VERCEL_",
];

/**
 * Build the environment for a child process that runs in a different cwd.
 *
 * Version managers can export activation-specific variables and prepend concrete
 * tool directories to PATH. If those leak into a command launched for another
 * repo, shims may keep using the parent repo's toolchain. Ask the user's shell
 * for the cwd-specific environment, then inherit only explicitly allowlisted
 * process-scoped values from the parent.
 */
export function createSpawnEnv(cwd?: string): NodeJS.ProcessEnv | undefined {
  if (cwd === undefined) {
    return undefined;
  }

  const shellEnv = getShellEnv(cwd);
  if (shellEnv === null) {
    return { ...process.env, PWD: cwd };
  }

  return mergeShellEnv(process.env, shellEnv, cwd);
}

export function mergeShellEnv(
  parentEnv: NodeJS.ProcessEnv,
  shellEnv: NodeJS.ProcessEnv,
  cwd: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...shellEnv };

  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined || key in shellEnv) {
      continue;
    }

    if (!shouldInheritFromParent(key)) {
      continue;
    }

    env[key] = value;
  }

  env["PWD"] = cwd;
  return env;
}

const shellEnvCache = new Map<string, NodeJS.ProcessEnv | null>();

function getShellEnv(cwd: string): NodeJS.ProcessEnv | null {
  const shell = process.env["SHELL"];
  if (!shell) {
    return null;
  }

  const cacheKey = `${shell}\0${cwd}`;
  const cached = shellEnvCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const result = spawnSync(shell, ["-lc", "env -0"], {
    cwd,
    env: minimalShellEnv(shell, cwd),
    encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status !== 0 || result.error) {
    shellEnvCache.set(cacheKey, null);
    return null;
  }

  const env = parseNullSeparatedEnv(result.stdout);
  shellEnvCache.set(cacheKey, env);
  return env;
}

function minimalShellEnv(shell: string, cwd: string): NodeJS.ProcessEnv {
  return copyDefinedEnv({
    HOME: process.env["HOME"],
    USER: process.env["USER"],
    LOGNAME: process.env["LOGNAME"],
    SHELL: shell,
    TERM: process.env["TERM"],
    TMPDIR: process.env["TMPDIR"],
    PWD: cwd,
    PATH: defaultPath(),
  });
}

function copyDefinedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => {
      return entry[1] !== undefined;
    }),
  );
}

function defaultPath(): string {
  return [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
}

function parseNullSeparatedEnv(output: Buffer): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const entry of output.toString("utf8").split("\0")) {
    if (!entry) {
      continue;
    }

    const separator = entry.indexOf("=");
    if (separator === -1) {
      continue;
    }

    env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }

  return env;
}

function shouldInheritFromParent(key: string): boolean {
  return (
    INHERITED_ENV_KEYS.has(key) ||
    INHERITED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}
