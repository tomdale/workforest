import { describe, expect, it } from "vitest";
import {
  createCodexEventStream,
  normalizeCodexEvent,
} from "../src/ai-providers/codex-events.ts";

describe("Codex JSONL events", () => {
  it("renders the supported progress surface without command results or final JSON", () => {
    expect(
      normalizeCodexEvent({
        type: "item.started",
        item: {
          type: "command_execution",
          command: '/bin/zsh -lc "rg -n preferences src"',
        },
      }),
    ).toEqual({
      type: "activity",
      source: "Codex",
      activity: "command",
      description: "rg -n preferences src",
    });
    expect(
      normalizeCodexEvent({
        type: "item.completed",
        item: { type: "reasoning", text: "I found the API boundary." },
      }),
    ).toEqual({
      type: "message",
      source: "Codex",
      text: "I found the API boundary.",
    });
    expect(
      normalizeCodexEvent({
        type: "item.completed",
        item: {
          type: "command_execution",
          aggregated_output: "thousands of source lines",
        },
      }),
    ).toBeNull();
    expect(
      normalizeCodexEvent({
        type: "item.completed",
        item: { type: "agent_message", text: '{"markdown":"generated"}' },
      }),
    ).toBeNull();
    expect(
      normalizeCodexEvent({
        type: "turn.completed",
        usage: { input_tokens: 24763, output_tokens: 122 },
      }),
    ).toEqual({
      type: "usage",
      source: "Codex",
      inputTokens: 24763,
      outputTokens: 122,
    });
  });

  it("buffers split lines and keeps diagnostics visible", () => {
    const output: unknown[] = [];
    const events = createCodexEventStream((event) => output.push(event));

    events.write("stdout", '{"type":"item.started","item":{"type":');
    events.write("stdout", '"web_search","query":"preferences API"}}\n');
    events.write("stderr", "Codex diagnostic\n");
    events.finish();

    expect(output).toEqual([
      {
        type: "activity",
        source: "Codex",
        activity: "search",
        description: "preferences API",
      },
      {
        type: "diagnostic",
        source: "Codex",
        message: "Codex diagnostic",
      },
    ]);
  });

  it("can emit compact debug summaries for raw Codex events", () => {
    const output: unknown[] = [];
    const events = createCodexEventStream((event) => output.push(event), {
      debug: true,
    });

    events.write(
      "stdout",
      `${JSON.stringify({
        type: "item.started",
        item: {
          type: "command_execution",
          command: '/bin/zsh -lc "sed -n 1,20p AGENTS.md"',
        },
      })}\n`,
    );
    events.finish();

    expect(output).toEqual([
      {
        type: "diagnostic",
        source: "Codex",
        message: "event: item.started command_execution sed -n 1,20p AGENTS.md",
      },
      {
        type: "activity",
        source: "Codex",
        activity: "command",
        description: "sed -n 1,20p AGENTS.md",
      },
    ]);
  });
});
