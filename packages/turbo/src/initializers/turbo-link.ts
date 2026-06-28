import {
  canRunForegroundTask,
  runForegroundTask,
  runCommandGenerator,
  type InitializerContext,
  type InitializerDefinition,
  type TaskState,
} from "@wf-plugin/core";

const TURBO_AUTH_HINT =
  "Run `turbo login`, then rerun setup to link the repository.";

async function* execute(context: InitializerContext) {
  const { repoDir } = context;
  const args = ["link", "--yes"];

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

const TURBO_AUTH_ERROR_PATTERNS = [
  /User not found\. Please login to Turborepo first/i,
  /Could not get user information/i,
  /Try logging in again with\s+`?turbo login`?/i,
  /\bInvalidToken\b|invalid token|token is not active/i,
  /\b403 Forbidden\b|HTTP 403|forbidden from accessing/i,
];
