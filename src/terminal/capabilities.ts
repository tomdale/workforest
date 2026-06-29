import {
  isEnvironmentVariableSet,
  STANDARD_ENVIRONMENT_VARIABLES,
  WORKFOREST_ENVIRONMENT_VARIABLES,
} from "../environment.ts";

const MIN_FULLSCREEN_COLUMNS = 80;
const MIN_FULLSCREEN_ROWS = 20;

export type FullscreenTerminal = Readonly<{
  stdin: Pick<NodeJS.ReadStream, "isTTY">;
  stdout: Pick<NodeJS.WriteStream, "columns" | "isTTY" | "rows">;
  env: NodeJS.ProcessEnv;
}>;

export function shouldUseFullscreenTui(
  terminal: FullscreenTerminal = {
    stdin: process.stdin,
    stdout: process.stdout,
    env: process.env,
  },
): boolean {
  if (!terminal.stdin.isTTY || !terminal.stdout.isTTY) return false;
  if (
    isEnvironmentVariableSet(STANDARD_ENVIRONMENT_VARIABLES.ci, terminal.env) ||
    isEnvironmentVariableSet(
      WORKFOREST_ENVIRONMENT_VARIABLES.noTui,
      terminal.env,
    )
  ) {
    return false;
  }

  const columns = terminal.stdout.columns ?? 80;
  const rows = terminal.stdout.rows ?? 24;
  return columns >= MIN_FULLSCREEN_COLUMNS && rows >= MIN_FULLSCREEN_ROWS;
}
