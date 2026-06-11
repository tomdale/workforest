import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderCommandResult } from "./cli/output.ts";
import { executeCli } from "./cli.ts";

type InvocationOutput = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const originalXdgConfigHome = process.env["XDG_CONFIG_HOME"];
const originalStdinIsTty = process.stdin.isTTY;
let configHome: string;

beforeEach(async () => {
  configHome = await mkdtemp(path.join(os.tmpdir(), "wf-template-cli-"));
  process.env["XDG_CONFIG_HOME"] = configHome;
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: false,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalXdgConfigHome === undefined) {
    delete process.env["XDG_CONFIG_HOME"];
  } else {
    process.env["XDG_CONFIG_HOME"] = originalXdgConfigHome;
  }
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: originalStdinIsTty,
  });
  await rm(configHome, { recursive: true, force: true });
});

describe("template command conformance", () => {
  const helpCases = [
    { argv: ["template"], usage: "Usage: wf template" },
    { argv: ["template", "list"], usage: "Usage: wf template list" },
    { argv: ["template", "show"], usage: "Usage: wf template show" },
    { argv: ["template", "info"], usage: "Usage: wf template info" },
    { argv: ["template", "new"], usage: "Usage: wf template new" },
    { argv: ["template", "edit"], usage: "Usage: wf template edit" },
    {
      argv: ["template", "add-file"],
      usage: "Usage: wf template add-file",
    },
    { argv: ["template", "copy"], usage: "Usage: wf template copy" },
    { argv: ["template", "delete"], usage: "Usage: wf template delete" },
  ] as const;

  it.each(helpCases)("renders help for $usage on stdout", async ({
    argv,
    usage,
  }) => {
    const output = await invoke([...argv, "--help"]);

    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain(usage);
    expect(output.stderr).toBe("");
  });

  const aliasCases = [
    { argv: ["templates", "--help"], usage: "Usage: wf templates" },
    {
      argv: ["template", "ls", "--help"],
      usage: "Usage: wf template list",
    },
    {
      argv: ["template", "create", "--help"],
      usage: "Usage: wf template new",
    },
    {
      argv: ["template", "cp", "--help"],
      usage: "Usage: wf template copy",
    },
    {
      argv: ["template", "rm", "--help"],
      usage: "Usage: wf template delete",
    },
  ] as const;

  it.each(aliasCases)("resolves alias $argv to canonical help", async ({
    argv,
    usage,
  }) => {
    const output = await invoke(argv);

    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain(usage);
    expect(output.stderr).toBe("");
  });

  const invalidCases = [
    {
      label: "template default surplus operands",
      argv: ["template", "--", "extra"],
      message: "Invalid operands for wf template",
    },
    {
      label: "template list surplus operands",
      argv: ["template", "list", "extra"],
      message: "Invalid operands for wf template list",
    },
    {
      label: "template show missing operand",
      argv: ["template", "show"],
      message: "Invalid operands for wf template show",
    },
    {
      label: "template show surplus operands",
      argv: ["template", "show", "one", "two"],
      message: "Invalid operands for wf template show",
    },
    {
      label: "template info missing operand",
      argv: ["template", "info"],
      message: "Invalid operands for wf template info",
    },
    {
      label: "template info surplus operands",
      argv: ["template", "info", "one", "two"],
      message: "Invalid operands for wf template info",
    },
    {
      label: "template new missing operands",
      argv: ["template", "new"],
      message: "Invalid operands for wf template new",
    },
    {
      label: "template edit missing operand",
      argv: ["template", "edit"],
      message: "Invalid operands for wf template edit",
    },
    {
      label: "template edit surplus operands",
      argv: ["template", "edit", "one", "two"],
      message: "Invalid operands for wf template edit",
    },
    {
      label: "template add-file missing operand",
      argv: ["template", "add-file"],
      message: "Invalid operands for wf template add-file",
    },
    {
      label: "template copy missing operand",
      argv: ["template", "copy", "one"],
      message: "Invalid operands for wf template copy",
    },
    {
      label: "template copy surplus operands",
      argv: ["template", "copy", "one", "two", "three"],
      message: "Invalid operands for wf template copy",
    },
    {
      label: "template delete missing operand",
      argv: ["template", "delete"],
      message: "Invalid operands for wf template delete",
    },
    {
      label: "template delete surplus operands",
      argv: ["template", "delete", "one", "two"],
      message: "Invalid operands for wf template delete",
    },
  ] as const;

  it.each(invalidCases)("rejects $label on stderr", async ({
    argv,
    message,
  }) => {
    const output = await invoke(argv);

    expect(output.exitCode).toBe(2);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain(message);
    expect(output.stderr).not.toContain("ArgError");
    expect(output.stderr).not.toContain("node_modules/arg");
  });

  const flagScopes = [
    {
      argv: ["template"],
      foreign: ["--description", "foreign"],
    },
    {
      argv: ["template", "list"],
      foreign: ["--force"],
    },
    {
      argv: ["template", "show", "demo"],
      foreign: ["--description", "foreign"],
    },
    {
      argv: ["template", "info", "demo"],
      foreign: ["--force"],
    },
    {
      argv: ["template", "new", "demo", "vercel/front"],
      foreign: ["--force"],
    },
    {
      argv: ["template", "edit", "demo"],
      foreign: ["--force"],
    },
    {
      argv: ["template", "add-file", "file"],
      foreign: ["--description", "foreign"],
    },
    {
      argv: ["template", "copy", "source", "target"],
      foreign: ["--force"],
    },
    {
      argv: ["template", "delete", "demo"],
      foreign: ["--description", "foreign"],
    },
  ] as const;
  const flagCases = flagScopes.flatMap(({ argv, foreign }) => [
    { kind: "unknown", argv: [...argv, "--bogus"] },
    { kind: "foreign", argv: [...argv, ...foreign] },
  ]);

  it.each(flagCases)("rejects $kind flags for $argv", async ({ argv }) => {
    const output = await invoke(argv);

    expect(output.exitCode).toBe(2);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("Unknown flag");
    expect(output.stderr).not.toContain("ArgError");
    expect(output.stderr).not.toContain("node_modules/arg");
  });

  it("keeps operational failures at exit 1", async () => {
    const output = await invoke(["template", "show", "missing"]);

    expect(output.exitCode).toBe(1);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain('Template "missing" not found');
  });

  it("keeps successful list output on stdout", async () => {
    const output = await invoke(["template", "list"]);

    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("No templates configured");
    expect(output.stderr).toBe("");
  });
});

async function invoke(argv: readonly string[]): Promise<InvocationOutput> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutWriter = (value: unknown, ...rest: unknown[]) => {
    stdout.push([value, ...rest].map(String).join(" "));
  };
  const stderrWriter = (value: unknown, ...rest: unknown[]) => {
    stderr.push([value, ...rest].map(String).join(" "));
  };

  const log = vi.spyOn(console, "log").mockImplementation(stdoutWriter);
  const error = vi.spyOn(console, "error").mockImplementation(stderrWriter);
  const warn = vi.spyOn(console, "warn").mockImplementation(stderrWriter);
  const stdoutWrite = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
  const stderrWrite = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });

  try {
    const result = await executeCli(argv);
    renderCommandResult(result, {
      stdout(value) {
        stdout.push(value);
      },
      stderr(value) {
        stderr.push(value);
      },
    });
    return {
      exitCode: result.exitCode,
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
    };
  } finally {
    log.mockRestore();
    error.mockRestore();
    warn.mockRestore();
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  }
}
