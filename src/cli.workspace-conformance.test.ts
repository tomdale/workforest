import { describe, expect, it } from "vitest";
import { renderCommandResult } from "./cli/output.ts";
import { executeCli } from "./cli.ts";

describe("change CLI conformance", () => {
  it.each([
    [["start", "--help"], "Usage: wf start"],
    [["add", "--help"], "Usage: wf add"],
    [["switch", "--help"], "Usage: wf switch"],
    [["list", "--help"], "Usage: wf list"],
    [["status", "--help"], "Usage: wf status"],
    [["finish", "--help"], "Usage: wf finish"],
    [["delete", "--help"], "Usage: wf delete"],
    [["worktree", "--help"], "Usage: wf worktree"],
  ])("renders scoped help for %j", async (argv, usage) => {
    const result = await executeCli(argv);

    expect(result).toMatchObject({
      exitCode: 0,
      render: { kind: "text", stream: "stdout" },
    });
    if (result.render.kind === "text") {
      expect(result.render.value).toContain(usage);
    }
  });

  it.each([
    [["new"], "Unknown command: new"],
    [["clean"], "Unknown command: clean"],
    [["workspace"], "Unknown command: workspace"],
    [["workspace", "create"], "Unknown command: workspace"],
    [["task", "create"], "Unknown wf task subcommand: create"],
    [["worktree", "create"], "Unknown wf worktree subcommand: create"],
  ])("returns exit 2 for removed invocation %j", async (argv, message) => {
    const result = await executeCli(argv);
    const output = renderResult(result);

    expect(result.exitCode).toBe(2);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain(message);
    expect(output.stderr).not.toMatch(/\n\s+at /);
  });

  it.each([
    [["start"], "Invalid operands for wf start"],
    [["add"], "Invalid operands for wf add"],
    [["delete"], "Invalid operands for wf delete"],
    [["task", "start"], "Invalid operands for wf task start"],
    [["task", "finish"], "Invalid operands for wf task finish"],
    [["task", "delete"], "Invalid operands for wf task delete"],
  ])("returns exit 2 for invalid final invocations %j", async (argv, message) => {
    const result = await executeCli(argv);
    const output = renderResult(result);

    expect(result.exitCode).toBe(2);
    expect(output.stderr).toContain(message);
    expect(output.stderr).not.toMatch(/\n\s+at /);
  });
});

function renderResult(result: Awaited<ReturnType<typeof executeCli>>): {
  stdout: string;
  stderr: string;
} {
  let stdout = "";
  let stderr = "";
  renderCommandResult(result, {
    stdout(value) {
      stdout += value;
    },
    stderr(value) {
      stderr += value;
    },
  });
  return { stdout, stderr };
}
