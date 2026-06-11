import { isCliError } from "./errors.ts";
import type {
  CliErrorKind,
  CommandResult,
  ExitCode,
  JsonEnvelope,
  OutputWriter,
  RenderModel,
  TextOutputKind,
} from "./types.ts";

const JSON_SERIALIZATION_ERROR =
  "Command result could not be serialized as JSON.";

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

export function humanOutput(
  value: string,
  options: Readonly<{
    stream?: "stdout" | "stderr";
    trailingNewline?: boolean;
  }> = {},
): RenderModel {
  return textOutput("human", value, options);
}

export function reportOutput(value: string): RenderModel {
  return textOutput("report", value);
}

export function pathOutput(value: string): RenderModel {
  return textOutput("path", value);
}

export function shellOutput(value: string): RenderModel {
  return textOutput("shell", value, { trailingNewline: false });
}

export function jsonOutput<Data>(data: Data): RenderModel {
  return { kind: "json", value: data, stream: "stdout" };
}

export function jsonErrorOutput(
  kind: CliErrorKind,
  message: string,
): RenderModel {
  return {
    kind: "json-error",
    error: { kind, message },
    stream: "stdout",
  };
}

export function jsonSuccess<Data>(data: Data): CommandResult {
  if (!isJsonSerializable(data)) {
    return jsonFailure("operational", JSON_SERIALIZATION_ERROR);
  }
  return success(jsonOutput(data));
}

export function jsonFailure(
  kind: CliErrorKind,
  message: string,
): CommandResult {
  return failure(kind === "usage" ? 2 : 1, jsonErrorOutput(kind, message));
}

export function errorResult(
  error: unknown,
  outputMode: "human" | "json" = "human",
): CommandResult | null {
  if (!isCliError(error)) {
    return null;
  }

  return outputMode === "json"
    ? failure(error.exitCode, jsonErrorOutput(error.kind, error.message))
    : failure(error.exitCode, humanOutput(error.message, { stream: "stderr" }));
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
      writeJson(write, {
        ok: true,
        data: result.render.value === undefined ? null : result.render.value,
      });
      return;
    }
    case "json-error": {
      const write =
        result.render.stream === "stdout" ? output.stdout : output.stderr;
      writeJson(write, { ok: false, error: result.render.error });
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

function textOutput(
  outputKind: TextOutputKind,
  value: string,
  options: Readonly<{
    stream?: "stdout" | "stderr";
    trailingNewline?: boolean;
  }> = {},
): RenderModel {
  return {
    kind: "text",
    value,
    stream: options.stream ?? "stdout",
    ...(options.trailingNewline === undefined
      ? {}
      : { trailingNewline: options.trailingNewline }),
    outputKind,
  };
}

function writeJson(
  write: (value: string) => void,
  envelope: JsonEnvelope,
): void {
  try {
    write(`${JSON.stringify(envelope)}\n`);
  } catch {
    write(
      `${JSON.stringify({
        ok: false,
        error: {
          kind: "operational",
          message: JSON_SERIALIZATION_ERROR,
        },
      } satisfies JsonEnvelope)}\n`,
    );
  }
}

function isJsonSerializable(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}
