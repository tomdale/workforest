import process from "node:process";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/ai-providers/cli.ts";

describe("Codex CLI subprocess runner", () => {
  it("force-kills a timed-out process that ignores SIGTERM", async () => {
    const debug: string[] = [];

    await expect(
      runCli(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000);",
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          timeoutMs: 25,
          timeoutKillGraceMs: 25,
          onDebug: (message) => debug.push(message),
        },
      ),
    ).rejects.toThrow("timed out after 25ms");

    expect(debug.some((message) => message.includes("spawned pid"))).toBe(
      true,
    );
    expect(debug.some((message) => message.includes("sending SIGTERM"))).toBe(
      true,
    );
    expect(debug.some((message) => message.includes("sending SIGKILL"))).toBe(
      true,
    );
  });
});
