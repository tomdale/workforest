import type { AiProgressEvent } from "@wf-plugin/core";
import { visibleWidth, wrap } from "./text.ts";
import { terminalColor, terminalSymbol } from "./theme.ts";

type Writer = (data: string) => void;

export function createAgentOutputStream(
  writer: Writer = (data) => process.stderr.write(data),
  width = process.stderr.columns ?? process.stdout.columns ?? 80,
): {
  writeEvent: (event: AiProgressEvent) => void;
  finishLine: () => void;
} {
  let atLineStart = true;
  let activityShown = false;
  let messageShown = false;

  function emit(data: string): void {
    writer(data);
    atLineStart = data.endsWith("\n");
  }

  return {
    writeEvent(event) {
      switch (event.type) {
        case "activity": {
          if (activityShown) return;
          activityShown = true;
          const description =
            event.activity === "command"
              ? renderHanging("  $ ", event.description, width)
              : event.activity === "search"
                ? `  ${terminalSymbol.info} Searching ${event.description}`
                : `  ${terminalSymbol.info} Calling ${event.description}`;
          emit(`${terminalColor.muted(description)}\n`);
          return;
        }
        case "message": {
          activityShown = false;
          const message = `${terminalColor.agent(renderMessage(event.text, width))}\n`;
          if (messageShown) {
            emit(`\n${message}`);
          } else {
            messageShown = true;
            emit(message);
          }
          return;
        }
        case "usage":
          emit(
            `${terminalColor.muted(
              `  ${event.source} usage: ${formatNumber(event.inputTokens)} input, ${formatNumber(event.outputTokens)} output tokens`,
            )}\n`,
          );
          return;
        case "diagnostic":
          emit(`${terminalColor.muted(`  ${event.message}`)}\n`);
          return;
        case "error":
          activityShown = false;
          emit(
            `${terminalColor.error(`${terminalSymbol.error} ${event.source}: ${event.message}`)}\n`,
          );
      }
    },
    finishLine() {
      if (!atLineStart) writer("\n");
      atLineStart = true;
    },
  };
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function renderMessage(message: string, width: number): string {
  return renderHanging("• ", message, width);
}

function renderHanging(prefix: string, value: string, width: number): string {
  const contentWidth = Math.max(1, width - visibleWidth(prefix));
  const lines = wrapWords(value, contentWidth);
  const continuation = " ".repeat(visibleWidth(prefix));
  return lines
    .map((line, index) => `${index === 0 ? prefix : continuation}${line}`)
    .join("\n");
}

function wrapWords(value: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }

    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (visibleWidth(candidate) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      const chunks = wrap(word, width);
      lines.push(...chunks.slice(0, -1));
      line = chunks.at(-1) ?? "";
    }
    lines.push(line);
  }
  return lines;
}
