import type { AiProgressEvent } from "@wf-plugin/core";

type JsonObject = Record<string, unknown>;
type EventSink = (event: AiProgressEvent) => void;

const SOURCE = "Codex";

export function createCodexEventStream(output: EventSink): {
  write: (stream: "stdout" | "stderr", data: string) => void;
  finish: () => void;
};
export function createCodexEventStream(
  output: EventSink,
  options: { debug?: boolean },
): {
  write: (stream: "stdout" | "stderr", data: string) => void;
  finish: () => void;
};
export function createCodexEventStream(
  output: EventSink,
  options: { debug?: boolean } = {},
): {
  write: (stream: "stdout" | "stderr", data: string) => void;
  finish: () => void;
} {
  let pending = "";

  function consume(line: string): void {
    if (!line.trim()) return;
    try {
      const raw = JSON.parse(line);
      if (options.debug) {
        output({
          type: "diagnostic",
          source: SOURCE,
          message: summarizeCodexEvent(raw),
        });
      }
      const event = normalizeCodexEvent(raw);
      if (event) output(event);
    } catch {
      output({
        type: "diagnostic",
        source: SOURCE,
        message: compact(line, 600),
      });
    }
  }

  return {
    write(stream, data) {
      if (stream === "stderr") {
        if (data.trim()) {
          output({
            type: "diagnostic",
            source: SOURCE,
            message: compact(data, 600),
          });
        }
        return;
      }
      pending += data;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) consume(line);
    },
    finish() {
      if (pending) consume(pending);
      pending = "";
    },
  };
}

function summarizeCodexEvent(value: unknown): string {
  if (!isObject(value)) return "event: non-object";
  const type = typeof value["type"] === "string" ? value["type"] : "unknown";
  const item = asObject(value["item"]);
  const itemType = typeof item?.["type"] === "string" ? item["type"] : null;
  if (itemType === "command_execution" && typeof item?.["command"] === "string")
    return `event: ${type} ${itemType} ${summarizeCommand(item["command"])}`;
  if (itemType) return `event: ${type} ${itemType}`;
  return `event: ${type}`;
}

export function normalizeCodexEvent(value: unknown): AiProgressEvent | null {
  if (!isObject(value) || typeof value["type"] !== "string") return null;

  if (value["type"] === "item.started") {
    const item = asObject(value["item"]);
    if (
      item?.["type"] === "command_execution" &&
      typeof item["command"] === "string"
    ) {
      return {
        type: "activity",
        source: SOURCE,
        activity: "command",
        description: summarizeCommand(item["command"]),
      };
    }
    if (item?.["type"] === "web_search" && typeof item["query"] === "string") {
      return {
        type: "activity",
        source: SOURCE,
        activity: "search",
        description: compact(item["query"], 240),
      };
    }
    if (item?.["type"] === "mcp_tool_call") {
      const name = [item["server"], item["tool"]]
        .filter((part): part is string => typeof part === "string")
        .join("/");
      return {
        type: "activity",
        source: SOURCE,
        activity: "tool",
        description: compact(name || "tool", 240),
      };
    }
  }

  if (value["type"] === "item.completed") {
    const item = asObject(value["item"]);
    if (
      (item?.["type"] === "reasoning" || item?.["type"] === "agent_message") &&
      typeof item["text"] === "string" &&
      !isJsonDocument(item["text"])
    ) {
      return {
        type: "message",
        source: SOURCE,
        text: compact(item["text"], 600),
      };
    }
  }

  if (value["type"] === "turn.completed") {
    const usage = asObject(value["usage"]);
    const inputTokens = asNumber(usage?.["input_tokens"]);
    const outputTokens = asNumber(usage?.["output_tokens"]);
    if (inputTokens !== null && outputTokens !== null) {
      return { type: "usage", source: SOURCE, inputTokens, outputTokens };
    }
  }

  if (value["type"] === "error" || value["type"] === "turn.failed") {
    const error = asObject(value["error"]);
    const message =
      typeof value["message"] === "string"
        ? value["message"]
        : typeof error?.["message"] === "string"
          ? error["message"]
          : "Agent failed.";
    return { type: "error", source: SOURCE, message: compact(message, 600) };
  }

  return null;
}

function compact(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function summarizeCommand(command: string): string {
  return compact(
    command.replace(/^\/bin\/(?:ba|z)?sh -lc ["']?/, "").replace(/["']$/, ""),
    120,
  );
}

function isJsonDocument(value: string): boolean {
  const text = value.trim();
  if (!(text.startsWith("{") || text.startsWith("["))) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): JsonObject | null {
  return isObject(value) ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
