import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  confirmPrompt,
  filterFuzzyChoices,
  type TerminalSymbols,
} from "./inline-widgets.ts";

class FakeInput extends EventEmitter {
  isRaw = false;
  setRawMode = vi.fn((value: boolean) => {
    this.isRaw = value;
  });
  resume = vi.fn();
  pause = vi.fn();
}

class FakeOutput {
  columns = 80;
  writes: string[] = [];
  write = vi.fn((chunk: string) => {
    this.writes.push(chunk);
    return true;
  });
}

const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, "stdout");

afterEach(() => {
  if (stdinDescriptor) {
    Object.defineProperty(process, "stdin", stdinDescriptor);
  }
  if (stdoutDescriptor) {
    Object.defineProperty(process, "stdout", stdoutDescriptor);
  }
});

describe("confirmPrompt", () => {
  it("submits the current yes/no value on enter", async () => {
    const stdin = new FakeInput();
    const stdout = new FakeOutput();
    stubProcessStreams(stdin, stdout);

    const promise = confirmPrompt("Delete workspace?", true, symbols);
    await Promise.resolve();
    stdin.emit("data", Buffer.from("\r"));

    await expect(promise).resolves.toEqual({
      type: "submitted",
      value: true,
    });
    expect(stdout.write).toHaveBeenCalled();
  });
});

describe("filterFuzzyChoices", () => {
  const options = [
    { label: "wf-fix-auth", value: "/workspaces/wf-fix-auth" },
    {
      label: "wf-billing-ui",
      hint: "2 repos (frontend)",
      value: "/workspaces/wf-billing-ui",
    },
    {
      label: "wf-docs",
      hint: "1 repo (documentation)",
      value: "/workspaces/wf-docs",
    },
  ];

  it("returns all options for an empty query", () => {
    expect(filterFuzzyChoices(options, "")).toEqual(options);
  });

  it("matches labels case-insensitively", () => {
    expect(filterFuzzyChoices(options, "BILLING")).toEqual([options[1]]);
  });

  it("matches hints case-insensitively", () => {
    expect(filterFuzzyChoices(options, "documentation")).toEqual([options[2]]);
  });

  it("returns no options when nothing matches", () => {
    expect(filterFuzzyChoices(options, "payments")).toEqual([]);
  });
});

function stubProcessStreams(stdin: FakeInput, stdout: FakeOutput): void {
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: stdin,
  });
  Object.defineProperty(process, "stdout", {
    configurable: true,
    value: stdout,
  });
}

const symbols: TerminalSymbols = {
  active: "?",
  done: "✓",
  cancel: "x",
  bar: "|",
  barEnd: "`",
  barStart: ".",
  barHorizontal: "-",
  radioOn: "●",
  radioOff: "○",
  checkOn: "■",
  checkOff: "□",
  info: "i",
  warning: "!",
  error: "x",
  success: "✓",
};
