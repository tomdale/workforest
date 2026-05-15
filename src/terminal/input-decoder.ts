import { StringDecoder } from "node:string_decoder";

export type KeyInput =
  | { type: "text"; value: string }
  | { type: "submit" }
  | { type: "cancel"; source: "ctrl-c" | "escape" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "arrow"; direction: "up" | "down" | "left" | "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "tab" }
  | { type: "space" }
  | { type: "unknown"; sequence: string };

export class InputDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private pendingEscape = "";

  push(chunk: Buffer | string): KeyInput[] {
    const text =
      typeof chunk === "string" ? chunk : this.decoder.write(chunk as Buffer);
    const input = `${this.pendingEscape}${text}`;
    this.pendingEscape = "";
    const events: KeyInput[] = [];

    for (let i = 0; i < input.length; ) {
      const ch = input[i];
      if (ch === undefined) break;

      if (ch === "\x03") {
        events.push({ type: "cancel", source: "ctrl-c" });
        i++;
        continue;
      }

      if (ch === "\r" || ch === "\n") {
        events.push({ type: "submit" });
        i++;
        continue;
      }

      if (ch === "\t") {
        events.push({ type: "tab" });
        i++;
        continue;
      }

      if (ch === " ") {
        events.push({ type: "space" });
        i++;
        continue;
      }

      if (ch === "\x7F" || ch === "\b") {
        events.push({ type: "backspace" });
        i++;
        continue;
      }

      if (ch === "\x01") {
        events.push({ type: "home" });
        i++;
        continue;
      }

      if (ch === "\x05") {
        events.push({ type: "end" });
        i++;
        continue;
      }

      if (ch === "\x1B") {
        const parsed = this.parseEscape(input.slice(i));
        if (parsed.kind === "pending") {
          this.pendingEscape = input.slice(i);
          break;
        }
        events.push(parsed.event);
        i += parsed.length;
        continue;
      }

      if (ch >= " ") {
        let value = ch;
        i++;
        while (i < input.length) {
          const next = input[i];
          if (next === undefined || next < " " || next === "\x7F") break;
          value += next;
          i++;
        }
        events.push({ type: "text", value });
        continue;
      }

      events.push({ type: "unknown", sequence: ch });
      i++;
    }

    return events;
  }

  end(): KeyInput[] {
    const rest = this.decoder.end();
    return rest ? this.push(rest) : [];
  }

  private parseEscape(
    input: string,
  ): { kind: "event"; event: KeyInput; length: number } | { kind: "pending" } {
    if (input === "\x1B") {
      return {
        kind: "event",
        event: { type: "cancel", source: "escape" },
        length: 1,
      };
    }

    if (input.length < 3) {
      return { kind: "pending" };
    }

    const csi = input.slice(0, 3);
    if (csi === "\x1B[A")
      return {
        kind: "event",
        event: { type: "arrow", direction: "up" },
        length: 3,
      };
    if (csi === "\x1B[B")
      return {
        kind: "event",
        event: { type: "arrow", direction: "down" },
        length: 3,
      };
    if (csi === "\x1B[C")
      return {
        kind: "event",
        event: { type: "arrow", direction: "right" },
        length: 3,
      };
    if (csi === "\x1B[D")
      return {
        kind: "event",
        event: { type: "arrow", direction: "left" },
        length: 3,
      };
    if (csi === "\x1B[H" || csi === "\x1BOH")
      return { kind: "event", event: { type: "home" }, length: 3 };
    if (csi === "\x1B[F" || csi === "\x1BOF")
      return { kind: "event", event: { type: "end" }, length: 3 };

    const tilde = parseTildeSequence(input);
    if (tilde?.number === "3") {
      return {
        kind: "event",
        event: { type: "delete" },
        length: tilde.length,
      };
    }
    if (tilde?.number === "1" || tilde?.number === "7") {
      return {
        kind: "event",
        event: { type: "home" },
        length: tilde.length,
      };
    }
    if (tilde?.number === "4" || tilde?.number === "8") {
      return { kind: "event", event: { type: "end" }, length: tilde.length };
    }

    const unknownLength = unknownEscapeLength(input);
    if (unknownLength > 0) {
      return {
        kind: "event",
        event: { type: "unknown", sequence: input.slice(0, unknownLength) },
        length: unknownLength,
      };
    }

    return {
      kind: "event",
      event: { type: "cancel", source: "escape" },
      length: 1,
    };
  }
}

function parseTildeSequence(
  input: string,
): { number: string; length: number } | null {
  if (!input.startsWith("\x1B[")) return null;
  let digits = "";
  let index = 2;
  while (index < input.length && /\d/.test(input[index] ?? "")) {
    digits += input[index];
    index++;
  }
  if (!digits || input[index] !== "~") return null;
  return { number: digits, length: index + 1 };
}

function unknownEscapeLength(input: string): number {
  if (input.startsWith("\x1BO") && input.length >= 3) return 3;
  if (!input.startsWith("\x1B[")) return 0;

  for (let i = 2; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) return i + 1;
  }
  return 0;
}
