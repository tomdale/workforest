import { isCliError } from "./errors.ts";
import type {
  CommandResult,
  ExitCode,
  OutputWriter,
  RenderModel,
} from "./types.ts";

export const processOutput: OutputWriter = {
  stdout(value) {
    if (value.endsWith("\n")) {
      console.log(value.slice(0, -1));
    } else {
      process.stdout.write(value);
    }
  },
  stderr(value) {
    if (value.endsWith("\n")) {
      console.error(value.slice(0, -1));
    } else {
      process.stderr.write(value);
    }
  },
};

export function success(render: RenderModel = { kind: "none" }): CommandResult {
  return { exitCode: 0, render };
}

export function failure(
  exitCode: Exclude<ExitCode, 0>,
  render: RenderModel,
): CommandResult {
  return { exitCode, render };
}

export function errorResult(error: unknown): CommandResult | null {
  if (!isCliError(error)) {
    return null;
  }

  return failure(error.exitCode, {
    kind: "text",
    value: error.message,
    stream: "stderr",
  });
}

export function renderCommandResult(
  result: CommandResult,
  output: OutputWriter = processOutput,
): void {
  switch (result.render.kind) {
    case "none":
      return;
    case "json": {
      const write =
        result.render.stream === "stdout" ? output.stdout : output.stderr;
      write(`${JSON.stringify(result.render.value)}\n`);
      return;
    }
    case "text": {
      const write =
        result.render.stream === "stdout" ? output.stdout : output.stderr;
      const trailingNewline = result.render.trailingNewline ?? true;
      write(
        trailingNewline && !result.render.value.endsWith("\n")
          ? `${result.render.value}\n`
          : result.render.value,
      );
    }
  }
}

export function applyExitCode(exitCode: ExitCode): void {
  process.exitCode = exitCode === 0 ? undefined : exitCode;
}
