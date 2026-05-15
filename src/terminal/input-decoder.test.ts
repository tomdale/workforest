import { describe, expect, it } from "vitest";
import { InputDecoder } from "./input-decoder.ts";

describe("InputDecoder", () => {
  it("decodes printable text and submit", () => {
    const decoder = new InputDecoder();

    expect(decoder.push(Buffer.from("abc\r"))).toEqual([
      { type: "text", value: "abc" },
      { type: "submit" },
    ]);
  });

  it("decodes UTF-8 split across chunks", () => {
    const decoder = new InputDecoder();
    const bytes = Buffer.from("é");

    expect(decoder.push(bytes.subarray(0, 1))).toEqual([]);
    expect(decoder.push(bytes.subarray(1))).toEqual([
      { type: "text", value: "é" },
    ]);
  });

  it("decodes navigation and editing keys", () => {
    const decoder = new InputDecoder();

    expect(decoder.push("\x1B[A\x1B[B\x1B[C\x1B[D\x1B[H\x1B[F\x1B[3~")).toEqual(
      [
        { type: "arrow", direction: "up" },
        { type: "arrow", direction: "down" },
        { type: "arrow", direction: "right" },
        { type: "arrow", direction: "left" },
        { type: "home" },
        { type: "end" },
        { type: "delete" },
      ],
    );
  });

  it("decodes cancellation", () => {
    const decoder = new InputDecoder();

    expect(decoder.push("\x03\x1B")).toEqual([
      { type: "cancel", source: "ctrl-c" },
      { type: "cancel", source: "escape" },
    ]);
  });
});
