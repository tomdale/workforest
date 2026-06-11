import { afterEach, describe, expect, it } from "vitest";
import { OperationalError, UsageError } from "./errors.ts";
import {
  applyExitCode,
  errorResult,
  renderCommandResult,
  success,
} from "./output.ts";

const originalExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = originalExitCode;
});

describe("CLI output", () => {
  it("renders text and JSON through explicit streams", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const output = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };

    renderCommandResult(
      success({ kind: "text", value: "ok", stream: "stdout" }),
      output,
    );
    renderCommandResult(
      {
        exitCode: 1,
        render: { kind: "json", value: { ok: false }, stream: "stderr" },
      },
      output,
    );

    expect(stdout).toEqual(["ok\n"]);
    expect(stderr).toEqual(['{"ok":false}\n']);
  });

  it("turns expected errors into stack-free command results", () => {
    expect(errorResult(new UsageError("bad invocation"))).toEqual({
      exitCode: 2,
      render: {
        kind: "text",
        value: "bad invocation",
        stream: "stderr",
      },
    });
    expect(errorResult(new OperationalError("failed"))?.exitCode).toBe(1);
    expect(errorResult(new Error("unexpected"))).toBeNull();
  });

  it("applies exit status at one process boundary", () => {
    applyExitCode(2);
    expect(process.exitCode).toBe(2);

    applyExitCode(0);
    expect(process.exitCode).toBeUndefined();
  });
});
