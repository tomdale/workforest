import { afterEach, describe, expect, it } from "vitest";
import { OperationalError, UsageError } from "./errors.ts";
import {
  applyExitCode,
  errorResult,
  jsonFailure,
  jsonSuccess,
  pathOutput,
  renderCommandResult,
  shellOutput,
  success,
} from "./output.ts";

const originalExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = originalExitCode;
});

describe("CLI output", () => {
  it("renders human, path, and shell output through explicit streams", () => {
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
    renderCommandResult(success(pathOutput("/tmp/workspace")), output);
    renderCommandResult(success(shellOutput("cd /tmp/workspace\n")), output);

    expect(stdout).toEqual(["ok\n", "/tmp/workspace\n", "cd /tmp/workspace\n"]);
    expect(stderr).toEqual([]);
  });

  it("renders exact JSON success and failure envelopes", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const output = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };

    renderCommandResult(jsonSuccess({ value: 1 }), output);
    renderCommandResult(jsonSuccess(undefined), output);
    renderCommandResult(jsonFailure("usage", "bad invocation"), output);
    renderCommandResult(jsonFailure("operational", "failed"), output);

    expect(stdout).toEqual([
      '{"ok":true,"data":{"value":1}}\n',
      '{"ok":true,"data":null}\n',
      '{"ok":false,"error":{"kind":"usage","message":"bad invocation"}}\n',
      '{"ok":false,"error":{"kind":"operational","message":"failed"}}\n',
    ]);
    expect(stderr).toEqual([]);
  });

  it("turns unserializable JSON data into an operational failure", () => {
    const data: { self?: unknown } = {};
    data.self = data;
    const result = jsonSuccess(data);
    const stdout: string[] = [];

    renderCommandResult(result, {
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(stdout.join(""))).toEqual({
      ok: false,
      error: {
        kind: "operational",
        message: "Command result could not be serialized as JSON.",
      },
    });
  });

  it("turns expected errors into stack-free command results", () => {
    expect(errorResult(new UsageError("bad invocation"))).toEqual({
      exitCode: 2,
      render: {
        kind: "text",
        value: "bad invocation",
        stream: "stderr",
        outputKind: "human",
      },
    });
    expect(errorResult(new OperationalError("failed"))?.exitCode).toBe(1);
    expect(errorResult(new UsageError("bad invocation"), "json")).toEqual(
      jsonFailure("usage", "bad invocation"),
    );
    expect(errorResult(new Error("unexpected"))).toBeNull();
  });

  it("applies exit status at one process boundary", () => {
    applyExitCode(2);
    expect(process.exitCode).toBe(2);

    applyExitCode(0);
    expect(process.exitCode).toBeUndefined();
  });
});
