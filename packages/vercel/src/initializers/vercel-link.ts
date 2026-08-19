import { promises as fs } from "node:fs";
import path from "node:path";
import {
  canRunForegroundTask,
  pathExists,
  runForegroundTask,
  spawnCommand,
  runParallel,
  type InitializerContext,
  type InitializerDefinition,
  type TaskState,
  type TaskGenerator,
  type WorkspaceConfig,
} from "@wf-plugin/core";

const MAX_CONCURRENT_ENV_PULLS = 6;
/** Device auth can sit on "Waiting for authentication…" for several minutes. */
const VERCEL_DEVICE_AUTH_INACTIVITY_MS = 15 * 60 * 1000;
const VERCEL_AUTH_HINT =
  "Run `vercel login`, then rerun setup to link the project and pull development env.";

type VercelRepoLinkTarget =
  | {
      kind: "link";
      githubOwner: string;
      githubSlug: string;
      team: string;
    }
  | { kind: "skip"; reason: string };

function resolveVercelRepoLinkTarget(
  remote: string,
  config: WorkspaceConfig,
): VercelRepoLinkTarget {
  const githubSlug = getGitHubSlug(remote);
  if (!githubSlug) {
    return {
      kind: "skip",
      reason: "Vercel auto-link only supports GitHub repositories.",
    };
  }

  const [githubOwner] = githubSlug.split("/");
  if (!githubOwner) {
    return {
      kind: "skip",
      reason: `Unable to determine GitHub owner from "${githubSlug}".`,
    };
  }

  const repoOverride = config.vercelLink?.repoOverrides?.[githubSlug];
  if (repoOverride?.disabled) {
    return {
      kind: "skip",
      reason: `Vercel auto-link disabled for GitHub repo "${githubSlug}".`,
    };
  }

  const team =
    repoOverride?.team ??
    config.vercelLink?.teamByGitHubOwner?.[githubOwner] ??
    (isValidVercelScope(githubOwner) ? githubOwner : undefined);

  if (!team) {
    return {
      kind: "skip",
      reason: `No Vercel team mapping configured for GitHub owner "${githubOwner}".`,
    };
  }

  return {
    kind: "link",
    githubOwner,
    githubSlug,
    team,
  };
}

async function* execute(context: InitializerContext) {
  const { repoDir } = context;
  const authState: AuthRecoveryState = {
    loginAttempted: false,
    challengeRecovery: null,
  };
  const target = resolveVercelRepoLinkTarget(
    context.repo.remote,
    context.workspaceConfig ?? {},
  );

  if (target.kind === "skip") {
    yield { status: "skipped" as const, reason: target.reason };
    return;
  }

  const preflight = runVercelAuthAwareCommand(
    ["whoami", "--format", "json", "--non-interactive"],
    repoDir,
    authState,
    {
      commandLabel: "Vercel authentication",
      skipReason: `Vercel authentication required. ${VERCEL_AUTH_HINT}`,
      repoName: context.repo.name,
    },
  );
  const preflightResult = yield* preflight;
  if (preflightResult !== "completed") {
    return;
  }

  const linkResult = yield* runVercelAuthAwareCommand(
    ["link", "--yes", "--repo", "--scope", target.team, "--non-interactive"],
    repoDir,
    authState,
    {
      commandLabel: "Vercel link",
      skipReason: `Vercel authentication required. ${VERCEL_AUTH_HINT}`,
      repoName: context.repo.name,
    },
  );
  if (linkResult !== "completed") {
    return;
  }

  const envPullTargets = await getEnvPullTargets(repoDir);
  if (envPullTargets.kind === "failed") {
    yield { status: "failed" as const, error: envPullTargets.error };
    return;
  }

  if (envPullTargets.warning) {
    yield {
      status: "log" as const,
      level: "warn" as const,
      message: envPullTargets.warning,
    };
  }

  let envPullFailed = false;
  for await (const { state } of runParallel(
    createEnvPullTasks(repoDir, envPullTargets.cwd, authState, context.repo.name),
    {
      maxConcurrent: MAX_CONCURRENT_ENV_PULLS,
    },
  )) {
    if (state.status === "completed") {
      continue;
    }

    if (state.status === "failed") {
      envPullFailed = true;
    }

    yield state;
  }

  if (envPullFailed) {
    return;
  }

  yield { status: "completed" as const };
}

const vercelLinkInitializer: InitializerDefinition = {
  id: "vercel-link",
  name: "Vercel link",
  execute,
};

export default vercelLinkInitializer;

function createEnvPullTasks(
  repoDir: string,
  cwds: string[],
  authState: AuthRecoveryState,
  repoName: string,
): Map<string, TaskGenerator> {
  return new Map(
    cwds.map((cwd, index) => [
      String(index),
      withEnvPullCwdLabel(
        runVercelAuthAwareCommand(
          [
            "env",
            "pull",
            "--environment",
            "development",
            "--yes",
            "--non-interactive",
          ],
          cwd,
          authState,
          {
            commandLabel: "Vercel env pull",
            skipReason: `Vercel authentication required for env pull. ${VERCEL_AUTH_HINT}`,
            repoName,
          },
        ),
        repoDir,
        cwd,
      ),
    ]),
  );
}

type AuthRecoveryState = {
  loginAttempted: boolean;
  /**
   * One shared device-auth attempt for the whole initializer run so parallel
   * env pulls do not open multiple browser challenges at once.
   */
  challengeRecovery: Promise<boolean> | null;
};

type AuthAwareResult = "completed" | "failed" | "skipped";

type AuthAwareOptions = {
  commandLabel: string;
  skipReason: string;
  /** Repository name used in the actionable initialization retry command. */
  repoName: string;
};

async function* runVercelAuthAwareCommand(
  args: string[],
  cwd: string,
  authState: AuthRecoveryState,
  options: AuthAwareOptions,
): AsyncGenerator<TaskState, AuthAwareResult, undefined> {
  const firstResult = yield* runCommandWithResult("vercel", args, cwd);
  if (firstResult.status === "completed") {
    return "completed";
  }

  // Check before generic auth: the sensitive-env message also matches "authentication".
  if (isVercelChallengeRequiredError(firstResult.error)) {
    return yield* recoverVercelChallenge(args, cwd, authState, options);
  }

  if (!isVercelAuthError(firstResult.error)) {
    yield { status: "failed", error: firstResult.error };
    return "failed";
  }

  if (!canRunForegroundTask()) {
    yield { status: "skipped", reason: options.skipReason };
    return "skipped";
  }

  if (authState.loginAttempted) {
    yield { status: "failed", error: firstResult.error };
    return "failed";
  }

  authState.loginAttempted = true;
  yield {
    status: "log",
    level: "warn",
    message: `${options.commandLabel} requires Vercel login; launching vercel login.`,
  };

  const loginResult = yield* runCommandWithResult("vercel", ["login"], cwd, {
    foreground: true,
  });
  if (loginResult.status === "failed") {
    yield { status: "failed", error: loginResult.error };
    return "failed";
  }

  yield {
    status: "retrying",
    reason: `${options.commandLabel} after Vercel login`,
    attempt: 1,
  };

  const retryResult = yield* runCommandWithResult("vercel", args, cwd);
  if (retryResult.status === "completed") {
    return "completed";
  }

  yield { status: "failed", error: retryResult.error };
  return "failed";
}

/**
 * Sensitive env pulls require a browser device flow. Re-run the same command
 * without non-interactive flags so Vercel prints the approval URL into the
 * setup stream; parallel callers wait on the first recovery and then retry.
 */
async function* recoverVercelChallenge(
  args: string[],
  cwd: string,
  authState: AuthRecoveryState,
  options: AuthAwareOptions,
): AsyncGenerator<TaskState, AuthAwareResult, undefined> {
  const recoveryCommand = formatInteractiveCommand(args);
  const skipReason =
    `Vercel device authentication did not complete. Run \`${recoveryCommand}\` in the project directory, approve the URL, then run \`wf init retry --repo ${options.repoName}\`. Initialization continued.`;

  if (authState.challengeRecovery) {
    yield {
      status: "log",
      level: "info",
      message: `${options.commandLabel}: waiting for Vercel device authentication started by another step.`,
    };
    const refreshed = await authState.challengeRecovery;
    if (!refreshed) {
      yield { status: "skipped", reason: skipReason };
      return "skipped";
    }

    yield {
      status: "retrying",
      reason: `${options.commandLabel} after Vercel device authentication`,
      attempt: 1,
    };
    const retryResult = yield* runCommandWithResult("vercel", args, cwd);
    if (retryResult.status === "completed") {
      return "completed";
    }
    yield { status: "skipped", reason: skipReason };
    return "skipped";
  }

  let resolveChallenge: (ok: boolean) => void = () => undefined;
  authState.challengeRecovery = new Promise<boolean>((resolve) => {
    resolveChallenge = resolve;
  });

  try {
    yield {
      status: "log",
      level: "warn",
      message: `${options.commandLabel} needs fresh Vercel authentication for sensitive environment variables. Approve the device URL in your browser when it appears.`,
    };
    yield {
      status: "retrying",
      reason: `${options.commandLabel} with interactive device authentication`,
      attempt: 1,
    };

    const interactiveArgs = toInteractiveArgs(args);
    const recoveryResult = yield* runCommandWithResult(
      "vercel",
      interactiveArgs,
      cwd,
      { inactivityTimeoutMs: VERCEL_DEVICE_AUTH_INACTIVITY_MS },
    );
    if (recoveryResult.status === "completed") {
      resolveChallenge(true);
      return "completed";
    }

    resolveChallenge(false);
    yield { status: "skipped", reason: skipReason };
    return "skipped";
  } catch (error) {
    resolveChallenge(false);
    throw error;
  }
}

type CommandResult =
  | { status: "completed" }
  | { status: "failed"; error: Error };

async function* runCommandWithResult(
  command: string,
  args: string[],
  cwd: string,
  options: { foreground?: boolean; inactivityTimeoutMs?: number } = {},
): AsyncGenerator<TaskState, CommandResult, undefined> {
  const task = options.foreground
    ? runForegroundTask(command, args, { cwd })
    : spawnCommand(command, args, {
        cwd,
        inactivityTimeoutMs: options.inactivityTimeoutMs ?? 120_000,
      });

  for await (const state of task) {
    if (state.status === "completed") {
      return { status: "completed" };
    }

    if (state.status === "failed") {
      return { status: "failed", error: state.error };
    }

    yield state;
  }

  return {
    status: "failed",
    error: new Error(`${command} ${args.join(" ")} finished without completion.`),
  };
}

function isVercelAuthError(error: Error): boolean {
  return /\b(auth|authentication|credential|login|logged in|token)\b/i.test(
    error.message,
  );
}

function isVercelChallengeRequiredError(error: Error): boolean {
  return (
    /\bchallenge required\b/i.test(error.message) ||
    /sensitive environment variables require fresh authentication/i.test(
      error.message,
    )
  );
}

function toInteractiveArgs(args: readonly string[]): string[] {
  return args.filter((arg) => arg !== "--yes" && arg !== "--non-interactive");
}

/** The automated form cannot solve a browser challenge, so omit its flags. */
function formatInteractiveCommand(args: readonly string[]): string {
  return ["vercel", ...toInteractiveArgs(args)].join(" ");
}

async function* withEnvPullCwdLabel(
  task: AsyncGenerator<TaskState, unknown, undefined>,
  repoDir: string,
  cwd: string,
): TaskGenerator {
  const resolvedRepoDir = path.resolve(repoDir);
  const resolvedCwd = path.resolve(cwd);
  const relativeCwd = path.relative(resolvedRepoDir, resolvedCwd);
  const cwdLabel =
    relativeCwd === ""
      ? undefined
      : !relativeCwd.startsWith("..") && !path.isAbsolute(relativeCwd)
        ? relativeCwd
        : resolvedCwd;

  for await (const state of task) {
    if (state.status === "running" && state.message && cwdLabel) {
      yield {
        ...state,
        message: `${state.message} (cwd: ${cwdLabel})`,
      };
      continue;
    }

    yield state;
  }
}

type EnvPullTargets =
  | { kind: "pull"; cwd: string[]; warning?: string }
  | { kind: "failed"; error: Error };

async function getEnvPullTargets(repoDir: string): Promise<EnvPullTargets> {
  const repoConfigPath = path.join(repoDir, ".vercel", "repo.json");
  if (await pathExists(repoConfigPath)) {
    return getRepoEnvPullTargets(repoDir, repoConfigPath);
  }

  const projectConfigPath = path.join(repoDir, ".vercel", "project.json");
  if (await pathExists(projectConfigPath)) {
    return { kind: "pull", cwd: [repoDir] };
  }

  return {
    kind: "pull",
    cwd: [repoDir],
    warning:
      "Neither .vercel/repo.json nor .vercel/project.json was found after vercel link; pulling development env at the repo root.",
  };
}

async function getRepoEnvPullTargets(
  repoDir: string,
  repoConfigPath: string,
): Promise<EnvPullTargets> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(repoConfigPath, "utf8"));
  } catch (error) {
    return {
      kind: "failed",
      error: new Error(`Failed to parse ${repoConfigPath}: ${formatError(error)}`),
    };
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { projects?: unknown }).projects)
  ) {
    return {
      kind: "failed",
      error: new Error(`${repoConfigPath} must contain a projects array.`),
    };
  }

  const projects = (parsed as { projects: unknown[] }).projects;
  const directories = projects
    .map((project) =>
      typeof project === "object" && project !== null
        ? (project as { directory?: unknown }).directory
        : undefined,
    )
    .filter((directory): directory is string => typeof directory === "string");

  return {
    kind: "pull",
    cwd: directories.map((directory) => path.join(repoDir, directory)),
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getGitHubSlug(remote: string): string | null {
  const trimmed = remote.trim();
  if (!trimmed) {
    return null;
  }

  const sshMatch = trimmed.match(/^git@github\.com:(.+)$/i);
  if (sshMatch?.[1]) {
    return sshMatch[1].replace(/\.git$/, "");
  }

  const httpsMatch = trimmed.match(/^https?:\/\/github\.com\/(.+)$/i);
  if (httpsMatch?.[1]) {
    return httpsMatch[1].replace(/\.git$/, "");
  }

  return null;
}

function isValidVercelScope(input: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(input);
}
