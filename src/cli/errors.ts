import type { ExitCode } from "./types.ts";

export abstract class CliError extends Error {
  abstract readonly exitCode: Exclude<ExitCode, 0>;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class UsageError extends CliError {
  readonly exitCode = 2;
}

export class OperationalError extends CliError {
  readonly exitCode = 1;
}

export function isCliError(error: unknown): error is CliError {
  return error instanceof CliError;
}

export function isArgumentParserError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.name === "ArgError" || error.constructor.name === "ArgError")
  );
}
