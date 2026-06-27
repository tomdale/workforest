import type { AiProgressEvent } from "@wf-plugin/core";

type JsonObject = Record<string, unknown>;
type EventSink = (event: AiProgressEvent) => void;

const SOURCE = "Claude";

export function createClaudeEventStream(output: EventSink): {
  write: (stream: "stdout" | "stderr", data: string) => void;
  finish: () => void;
  text: () => string | null;
};
export function createClaudeEventStream(
  output: EventSink,
  options: { debug?: boolean },
): {
  write: (stream: "stdout" | "stderr", data: string) => void;
  finish: () => void;
  text: () => string | null;
};
export function createClaudeEventStream(
  output: EventSink,
  options: { debug?: boolean } = {},
): {
  write: (stream: "stdout" | "stderr", data: string) => void;
  finish: () => void;
  text: () => string | null;
} {
  let pending = "";
  let resultText: string | null = null;
  let lastAssistantText: string | null = null;

  function consume(line: string): void {
    if (!line.trim()) return;
    try {
      const raw = JSON.parse(line);
      if (options.debug) {
        output({
          type: "diagnostic",
          source: SOURCE,
          message: summarizeClaudeEvent(raw),
        });
      }
      const text = extractResultText(raw);
      if (text !== null) resultText = text;
      const assistantText = extractAssistantText(raw);
      if (assistantText !== null) lastAssistantText = assistantText;
      for (const event of normalizeClaudeEvent(raw)) {
        output(event);
      }
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
    text() {
      return resultText ?? lastAssistantText;
    },
  };
}

function summarizeClaudeEvent(value: unknown): string {
  if (!isObject(value)) return "event: non-object";
  const type = typeof value["type"] === "string" ? value["type"] : "unknown";
  const subtype =
    typeof value["subtype"] === "string" ? ` ${value["subtype"]}` : "";
  if (type === "assistant") {
    const tool = firstToolUse(value);
    if (tool)
      return `event: assistant tool_use ${summarizeToolUse(tool.name, tool.input, 240)}`;
    if (extractAssistantText(value) !== null) return "event: assistant text";
  }
  return `event: ${type}${subtype}`;
}

export function normalizeClaudeEvent(value: unknown): AiProgressEvent[] {
  if (!isObject(value) || typeof value["type"] !== "string") return [];

  if (value["type"] === "assistant") {
    const events: AiProgressEvent[] = [];
    const message = asObject(value["message"]);
    for (const content of asArray(message?.["content"])) {
      const item = asObject(content);
      if (!item || typeof item["type"] !== "string") continue;
      if (item["type"] === "text" && typeof item["text"] === "string") {
        if (!isJsonDocument(item["text"])) {
          events.push({
            type: "message",
            source: SOURCE,
            text: compact(item["text"], 600),
          });
        }
        continue;
      }
      if (item["type"] === "tool_use") {
        const name =
          typeof item["name"] === "string" ? item["name"] : "tool";
        const input = asObject(item["input"]);
        if (
          name.toLowerCase() === "bash" &&
          typeof input?.["command"] === "string"
        ) {
          events.push({
            type: "activity",
            source: SOURCE,
            activity: "command",
            description: summarizeCommand(input["command"]),
          });
          continue;
        }
        const query = stringValue(input?.["query"] ?? input?.["pattern"]);
        if (name.toLowerCase().includes("search") && query) {
          events.push({
            type: "activity",
            source: SOURCE,
            activity: "search",
            description: compact(query, 240),
          });
          continue;
        }
        events.push({
          type: "activity",
          source: SOURCE,
          activity: "tool",
          description: summarizeToolUse(name, input, 240),
        });
      }
    }

    const usage = usageFromObject(asObject(message?.["usage"]));
    if (usage) events.push(usage);
    return events;
  }

  if (value["type"] === "result") {
    const usage = usageFromObject(asObject(value["usage"]));
    return usage ? [usage] : [];
  }

  if (value["type"] === "error") {
    const error = asObject(value["error"]);
    const message =
      typeof value["message"] === "string"
        ? value["message"]
        : typeof error?.["message"] === "string"
          ? error["message"]
          : "Agent failed.";
    return [{ type: "error", source: SOURCE, message: compact(message, 600) }];
  }

  return [];
}

function usageFromObject(usage: JsonObject | null): AiProgressEvent | null {
  const inputTokens = asNumber(usage?.["input_tokens"]) ?? 0;
  const cacheCreationTokens =
    asNumber(usage?.["cache_creation_input_tokens"]) ?? 0;
  const cacheReadTokens = asNumber(usage?.["cache_read_input_tokens"]) ?? 0;
  const outputTokens = asNumber(usage?.["output_tokens"]);
  if (outputTokens === null) return null;
  const totalInputTokens = inputTokens + cacheCreationTokens + cacheReadTokens;
  if (totalInputTokens === 0 && outputTokens === 0) return null;
  return {
    type: "usage",
    source: SOURCE,
    inputTokens: totalInputTokens,
    outputTokens,
  };
}

function extractResultText(value: unknown): string | null {
  if (!isObject(value) || value["type"] !== "result") return null;
  return typeof value["result"] === "string" ? value["result"] : null;
}

function extractAssistantText(value: unknown): string | null {
  if (!isObject(value) || value["type"] !== "assistant") return null;
  const message = asObject(value["message"]);
  const texts = asArray(message?.["content"])
    .map((content) => asObject(content))
    .filter((content): content is JsonObject => content?.["type"] === "text")
    .map((content) =>
      typeof content["text"] === "string" ? content["text"] : "",
    )
    .filter(Boolean);
  return texts.length > 0 ? texts.join("\n") : null;
}

function firstToolUse(
  value: unknown,
): { name: string; input: JsonObject | null } | null {
  if (!isObject(value) || value["type"] !== "assistant") return null;
  const message = asObject(value["message"]);
  for (const content of asArray(message?.["content"])) {
    const item = asObject(content);
    if (item?.["type"] === "tool_use" && typeof item["name"] === "string") {
      return { name: item["name"], input: asObject(item["input"]) };
    }
  }
  return null;
}

function summarizeToolUse(
  name: string,
  input: JsonObject | null,
  maxLength: number,
): string {
  const lowerName = name.toLowerCase();
  if (lowerName === "bash" && typeof input?.["command"] === "string") {
    return summarizeCommand(input["command"]);
  }
  const path = stringValue(
    input?.["file_path"] ?? input?.["path"] ?? input?.["notebook_path"],
  );
  const pattern = stringValue(input?.["pattern"]);
  const query = stringValue(input?.["query"]);
  const url = stringValue(input?.["url"]);
  if (lowerName === "read" && path) return compact(`Read ${path}`, maxLength);
  if (lowerName === "ls" && path) return compact(`LS ${path}`, maxLength);
  if (lowerName === "glob" && pattern) {
    return compact(
      path ? `Glob ${pattern} in ${path}` : `Glob ${pattern}`,
      maxLength,
    );
  }
  if (lowerName === "grep" && pattern) {
    return compact(
      path ? `Grep ${pattern} in ${path}` : `Grep ${pattern}`,
      maxLength,
    );
  }
  if (query) return compact(`${name} ${query}`, maxLength);
  if (url) return compact(`${name} ${url}`, maxLength);
  if (path) return compact(`${name} ${path}`, maxLength);
  return compact(name, maxLength);
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

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
