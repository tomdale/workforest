import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { createAgentOutputStream } from "./agent-output.ts";

describe("agent output stream", () => {
  it("groups Codex narration, samples activity, and summarizes usage", () => {
    const output: string[] = [];
    const stream = createAgentOutputStream((data) => output.push(data));

    stream.writeEvent({
      type: "message",
      source: "Codex",
      text: "I’ll inspect the hinted paths.",
    });
    stream.writeEvent({
      type: "activity",
      source: "Codex",
      activity: "command",
      description: "rg --files front",
    });
    stream.writeEvent({
      type: "activity",
      source: "Codex",
      activity: "command",
      description: "sed -n 1,200p file",
    });
    stream.writeEvent({
      type: "message",
      source: "Codex",
      text: "I found the API boundary.",
    });
    stream.writeEvent({
      type: "activity",
      source: "Codex",
      activity: "command",
      description: "rg -n sessions agents",
    });
    stream.writeEvent({
      type: "usage",
      source: "Codex",
      inputTokens: 625684,
      outputTokens: 5345,
    });

    expect(stripAnsi(output.join(""))).toBe(
      [
        "• I’ll inspect the hinted paths.",
        "  $ rg --files front",
        "",
        "• I found the API boundary.",
        "  $ rg -n sessions agents",
        "  Codex usage: 625,684 input, 5,345 output tokens",
        "",
      ].join("\n"),
    );
  });

  it("wraps message continuations beneath the bullet", () => {
    const output: string[] = [];
    const stream = createAgentOutputStream((data) => output.push(data), 20);

    stream.writeEvent({
      type: "message",
      source: "Codex",
      text: "This message wraps cleanly.",
    });

    expect(stripAnsi(output.join(""))).toBe(
      "• This message wraps\n  cleanly.\n",
    );
  });

  it("wraps command continuations beneath the invocation", () => {
    const output: string[] = [];
    const stream = createAgentOutputStream((data) => output.push(data), 20);

    stream.writeEvent({
      type: "activity",
      source: "Codex",
      activity: "command",
      description: "rg --files packages source",
    });

    expect(stripAnsi(output.join(""))).toBe(
      "  $ rg --files\n    packages source\n",
    );
  });
});
