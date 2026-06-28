import { describe, expect, it } from "vitest";
import { renderCommandResult } from "./cli/output.ts";
import { executeCli } from "./cli.ts";

describe("worktree/workspace CLI conformance", () => {
  it.each([
    [["new", "--help"], "Usage: wf new"],
    [["add", "--help"], "Usage: wf add"],
    [["switch", "--help"], "Usage: wf switch"],
    [["list", "--help"], "Usage: wf list"],
    [["status", "--help"], "Usage: wf status"],
    [["delete", "--help"], "Usage: wf delete"],
    [["cache", "worktree", "--help"], "Usage: wf cache worktree"],
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
    [["new"], "Invalid operands for wf new"],
    [["add"], "Invalid operands for wf add"],
    [["task", "new"], "Invalid operands for wf task new"],
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
