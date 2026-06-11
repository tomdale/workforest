import { describe, expect, it } from "vitest";
import { runSubprocess } from "./subprocess.ts";

describe("runSubprocess", () => {
  it("captures exit code, stdout, and stderr without rejecting", async () => {
    const result = await runSubprocess(process.execPath, [
      "-e",
      "process.stdout.write('output'); process.stderr.write('warning'); process.exit(7);",
    ]);

    expect(result).toEqual({
      exitCode: 7,
      stdout: "output",
      stderr: "warning",
    });
  });
});
