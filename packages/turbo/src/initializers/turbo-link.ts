import {
  canRunForegroundTask,
  runForegroundTask,
  runCommandGenerator,
  type InitializerContext,
  type InitializerDefinition,
  type TaskState,
  type WorkspaceConfig,
} from "@wf-plugin/core";

const TURBO_AUTH_HINT =
  "Run `turbo login`, then rerun setup to link the repository.";

type TurboLinkTarget =
  | { kind: "link"; githubOwner: string; githubSlug: string; team: string }
  | { kind: "skip"; reason: string };

function resolveTurboLinkTarget(
  remote: string,
  config: WorkspaceConfig,
): TurboLinkTarget {
  const githubSlug = getGitHubSlug(remote);
  if (!githubSlug) {
    return {
      kind: "skip",
      reason: "Turbo auto-link only supports GitHub repositories.",
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
      reason: `Turbo auto-link disabled for GitHub repo "${githubSlug}".`,
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
  const target = resolveTurboLinkTarget(
    context.repo.remote,
    context.workspaceConfig ?? {},
  );

  if (target.kind === "skip") {
    yield { status: "skipped" as const, reason: target.reason };
    return;
  }

  const args = ["link", "--yes", "--scope", target.team];

  const firstResult = yield* runCommandWithResult("turbo", args, repoDir);
  if (firstResult.status === "completed") {
    yield { status: "completed" as const };
    return;
  }

  if (!isTurboAuthError(firstResult.error)) {
    yield { status: "failed" as const, error: firstResult.error };
    return;
  }

  if (!canRunForegroundTask()) {
    yield {
      status: "skipped" as const,
      reason: `Turborepo authentication required. ${TURBO_AUTH_HINT}`,
    };
    return;
  }

  yield {
    status: "log" as const,
    level: "warn" as const,
    message: "Turbo link requires Turborepo login; launching turbo login.",
  };

  const loginResult = yield* runCommandWithResult("turbo", ["login"], repoDir, {
    foreground: true,
  });
  if (loginResult.status === "failed") {
    yield { status: "failed" as const, error: loginResult.error };
    return;
  }

  yield {
    status: "retrying" as const,
    reason: "Turbo link after Turborepo login",
    attempt: 1,
  };

  const retryResult = yield* runCommandWithResult("turbo", args, repoDir);
  if (retryResult.status === "completed") {
    yield { status: "completed" as const };
    return;
  }

  yield { status: "failed" as const, error: retryResult.error };
}

const turboLinkInitializer: InitializerDefinition = {
  id: "turbo-link",
  name: "Turbo link",
  execute,
};

export default turboLinkInitializer;

type CommandResult =
  | { status: "completed" }
  | { status: "failed"; error: Error };

async function* runCommandWithResult(
  command: string,
  args: string[],
  cwd: string,
  options: { foreground?: boolean } = {},
): AsyncGenerator<TaskState, CommandResult, undefined> {
  const task = options.foreground
    ? runForegroundTask(command, args, { cwd })
    : runCommandGenerator(command, args, { cwd });

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

function isTurboAuthError(error: Error): boolean {
  return TURBO_AUTH_ERROR_PATTERNS.some((pattern) =>
    pattern.test(error.message),
  );
}

function getGitHubSlug(remote: string): string | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;

  const ssh = trimmed.match(/^git@github\.com:(.+)$/i);
  if (ssh?.[1]) return ssh[1].replace(/\.git$/, "");

  const https = trimmed.match(/^https?:\/\/github\.com\/(.+)$/i);
  if (https?.[1]) return https[1].replace(/\.git$/, "");

  return null;
}

function isValidVercelScope(input: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(input);
}

const TURBO_AUTH_ERROR_PATTERNS = [
  /User not found\. Please login to Turborepo first/i,
  /Could not get user information/i,
  /Try logging in again with\s+`?turbo login`?/i,
  /\bInvalidToken\b|invalid token|token is not active/i,
  /\b403 Forbidden\b|HTTP 403|forbidden from accessing/i,
];
