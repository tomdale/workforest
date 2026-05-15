import stripAnsi from "strip-ansi";

export type CommandOutputSource = "stdout" | "stderr";

export type CommandOutputLine = {
  source: CommandOutputSource;
  line: string;
};

export function escapeBlessedTags(value: string): string {
  return value.replace(/[{}]/g, (char) => (char === "{" ? "\\{" : "\\}"));
}

export class CommandStreamAdapter {
  private readonly buffers = new Map<CommandOutputSource, string>();

  push(source: CommandOutputSource, chunk: string): CommandOutputLine[] {
    const normalized = normalizeControlText(
      `${this.buffers.get(source) ?? ""}${chunk}`,
    );
    const lines: CommandOutputLine[] = [];
    let current = "";

    for (const char of normalized) {
      if (char === "\r") {
        current = "";
        continue;
      }
      if (char === "\n") {
        lines.push({ source, line: escapeBlessedTags(current) });
        current = "";
        continue;
      }
      current += char;
    }

    this.buffers.set(source, current);
    return lines;
  }

  flush(source?: CommandOutputSource): CommandOutputLine[] {
    const sources: CommandOutputSource[] = source
      ? [source]
      : ["stdout", "stderr"];
    const lines: CommandOutputLine[] = [];
    for (const key of sources) {
      const pending = this.buffers.get(key);
      if (!pending) continue;
      lines.push({ source: key, line: escapeBlessedTags(pending) });
      this.buffers.delete(key);
    }
    return lines;
  }
}

export function normalizeControlText(value: string): string {
  const withoutAnsi = stripAnsi(stripOsc(value));
  let output = "";
  for (const char of withoutAnsi) {
    const code = char.charCodeAt(0);
    if (char === "\r" || char === "\n" || char === "\t" || code >= 0x20) {
      output += char;
    }
  }
  return output;
}

function stripOsc(value: string): string {
  let output = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== "\x1B" || value[i + 1] !== "]") {
      output += value[i];
      continue;
    }

    i += 2;
    while (i < value.length) {
      if (value[i] === "\x07") break;
      if (value[i] === "\x1B" && value[i + 1] === "\\") {
        i++;
        break;
      }
      i++;
    }
  }
  return output;
}
