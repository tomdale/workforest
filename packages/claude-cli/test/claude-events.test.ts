import { describe, expect, it } from "vitest";
import {
  createClaudeEventStream,
  normalizeClaudeEvent,
} from "../src/ai-providers/claude-events.ts";

describe("Claude stream-json events", () => {
  it("renders the supported progress surface without final JSON", () => {
    expect(
      normalizeClaudeEvent({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: '/bin/zsh -lc "rg -n preferences src"' },
            },
            { type: "text", text: "I found the API boundary." },
          ],
          usage: {
            input_tokens: 20,
            cache_creation_input_tokens: 30,
            cache_read_input_tokens: 40,
            output_tokens: 5,
          },
        },
      }),
    ).toEqual([
      {
        type: "activity",
        source: "Claude",
        activity: "command",
        description: "rg -n preferences src",
      },
      {
        type: "message",
        source: "Claude",
        text: "I found the API boundary.",
      },
      {
        type: "usage",
        source: "Claude",
        inputTokens: 90,
        outputTokens: 5,
      },
    ]);
    expect(
      normalizeClaudeEvent({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              content: "thousands of source lines",
            },
          ],
        },
      }),
    ).toEqual([]);
    expect(
      normalizeClaudeEvent({
        type: "assistant",
        message: {
          content: [{ type: "text", text: '{"markdown":"generated"}' }],
        },
      }),
    ).toEqual([]);
    expect(
      normalizeClaudeEvent({
        type: "result",
        usage: { input_tokens: 24763, output_tokens: 122 },
      }),
    ).toEqual([
      {
        type: "usage",
        source: "Claude",
        inputTokens: 24763,
        outputTokens: 122,
      },
    ]);
    expect(
      normalizeClaudeEvent({
        type: "assistant",
        message: {
          content: [],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    ).toEqual([]);
  });

  it("buffers split lines, retains final text, and keeps diagnostics visible", () => {
    const output: unknown[] = [];
    const events = createClaudeEventStream((event) => output.push(event));

    events.write("stdout", '{"type":"assistant","message":{"content":[');
    events.write(
      "stdout",
      '{"type":"tool_use","name":"WebSearch","input":{"query":"preferences API"}}]}}\n',
    );
    events.write("stderr", "Claude diagnostic\n");
    events.write(
      "stdout",
      '{"type":"result","subtype":"success","result":"final response"}\n',
    );
    events.finish();

    expect(output).toEqual([
      {
        type: "activity",
        source: "Claude",
        activity: "search",
        description: "preferences API",
      },
      {
        type: "diagnostic",
        source: "Claude",
        message: "Claude diagnostic",
      },
    ]);
    expect(events.text()).toBe("final response");
  });

  it("can emit compact debug summaries for raw Claude events", () => {
    const output: unknown[] = [];
    const events = createClaudeEventStream((event) => output.push(event), {
      debug: true,
    });

    events.write(
      "stdout",
      `${JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: '/bin/zsh -lc "sed -n 1,20p AGENTS.md"' },
            },
          ],
        },
      })}\n`,
    );
    events.finish();

    expect(output).toEqual([
      {
        type: "diagnostic",
        source: "Claude",
        message: "event: assistant tool_use sed -n 1,20p AGENTS.md",
      },
      {
        type: "activity",
        source: "Claude",
        activity: "command",
        description: "sed -n 1,20p AGENTS.md",
      },
    ]);
  });

  it("includes tool inputs in debug summaries", () => {
    const output: unknown[] = [];
    const events = createClaudeEventStream((event) => output.push(event), {
      debug: true,
    });

    events.write(
      "stdout",
      `${JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: "/workspace/front/AGENTS.md" },
            },
          ],
        },
      })}\n`,
    );
    events.finish();

    expect(output[0]).toEqual({
      type: "diagnostic",
      source: "Claude",
      message: "event: assistant tool_use Read /workspace/front/AGENTS.md",
    });
  });
});
