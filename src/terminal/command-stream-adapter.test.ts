import { describe, expect, it } from "vitest";
import {
  CommandStreamAdapter,
  escapeBlessedTags,
} from "./command-stream-adapter.ts";

describe("CommandStreamAdapter", () => {
  it("coalesces chunks and preserves output source", () => {
    const adapter = new CommandStreamAdapter();

    expect(adapter.push("stdout", "hel")).toEqual([]);
    expect(adapter.push("stdout", "lo\nerr")).toEqual([
      { source: "stdout", line: "hello" },
    ]);
    expect(adapter.flush()).toEqual([{ source: "stdout", line: "err" }]);
  });

  it("drops carriage-return progress rewrites", () => {
    const adapter = new CommandStreamAdapter();

    expect(adapter.push("stderr", "Receiving 50%\rReceiving 100%\n")).toEqual([
      { source: "stderr", line: "Receiving 100%" },
    ]);
  });

  it("strips ANSI, OSC, control characters, and escapes blessed tags", () => {
    const adapter = new CommandStreamAdapter();

    expect(
      adapter.push("stdout", "\x1B[31m{red}\x1B[0m\x1B]0;title\x07\x00\n"),
    ).toEqual([{ source: "stdout", line: "{open}red{close}" }]);
  });
});

describe("escapeBlessedTags", () => {
  it("escapes braces with the {open}/{close} tokens @unblessed substitutes", () => {
    expect(escapeBlessedTags("{bold}repo{/bold}")).toBe(
      "{open}bold{close}repo{open}/bold{close}",
    );
  });
});
