import { EventEmitter } from "node:events";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  confirmPrompt,
  filterFuzzyChoices,
  fuzzySelectPrompt,
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
const fuzzyOptions = [
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
  });
});

describe("filterFuzzyChoices", () => {
  it.each([
    ["", [0, 1, 2]],
    ["BILLING", [1]],
    ["documentation", [2]],
    ["payments", []],
  ])("filters options for %j", (query, expectedIndexes) => {
    expect(filterFuzzyChoices(fuzzyOptions, query)).toEqual(
      expectedIndexes.map((index) => fuzzyOptions[index]),
    );
  });
});

describe("fuzzySelectPrompt", () => {
  it("filters with the initial query before the first render", async () => {
    const stdin = new FakeInput();
    const stdout = new FakeOutput();
    stubProcessStreams(stdin, stdout);

    const promise = fuzzySelectPrompt(
      "Switch to change",
      fuzzyOptions,
      symbols,
      {
        initialQuery: "docs",
      },
    );
    await Promise.resolve();

    const rendered = stripAnsi(stdout.writes.join(""));
    expect(rendered).toContain("docs");
    expect(rendered).toContain("wf-docs");
    expect(rendered).not.toContain("wf-fix-auth");
    expect(rendered).not.toContain("wf-billing-ui");

    stdin.emit("data", Buffer.from("\r"));

    await expect(promise).resolves.toEqual({
      type: "submitted",
      value: "/workspaces/wf-docs",
    });
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
