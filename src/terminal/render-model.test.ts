import path from "node:path";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import {
  literalSpan,
  renderTerminalDocAnsi,
  renderTerminalDocBlessed,
  renderTerminalDocPlain,
  terminalDoc,
  terminalSpan,
} from "./render-model.ts";

describe("terminal render model", () => {
  it("renders semantic spans as plain text without styling", () => {
    const doc = terminalDoc([
      [
        terminalSpan("Status", { role: "primary", emphasis: "bold" }),
        ": ",
        terminalSpan("ready", { role: "success" }),
      ],
      [terminalSpan("Path", { role: "muted" }), ": /tmp/workforest"],
    ]);

    expect(renderTerminalDocPlain(doc)).toBe(
      ["Status: ready", "Path: /tmp/workforest"].join("\n"),
    );
  });

  it("renders semantic spans as ANSI while preserving text content", () => {
    const doc = terminalDoc([
      [
        terminalSpan("Run", { role: "accent", emphasis: "bold" }),
        " ",
        terminalSpan("wf status", { role: "focus", emphasis: "underline" }),
      ],
    ]);
    const output = renderTerminalDocAnsi(doc);

    expect(stripAnsi(output)).toBe("Run wf status");
    expect(output).not.toBe("Run wf status");
    expect(output).toContain("\u001B[");
  });

  it("renders semantic spans as blessed tags", () => {
    const doc = terminalDoc([
      [
        terminalSpan("Queued", {
          role: "warning",
          background: "background",
          emphasis: ["bold", "inverse"],
        }),
      ],
    ]);

    expect(renderTerminalDocBlessed(doc)).toBe(
      "{yellow-fg}{#121416-bg}{bold}{inverse}Queued{/inverse}{/bold}{/#121416-bg}{/yellow-fg}",
    );
  });

  it("renders blessed foregrounds from the fullscreen theme", () => {
    const doc = terminalDoc([[terminalSpan("metadata", { role: "dim" })]]);

    expect(renderTerminalDocBlessed(doc)).toBe(
      "{#825a5a-fg}metadata{/#825a5a-fg}",
    );
  });

  it("renders blessed palette backgrounds from the fullscreen theme", () => {
    const doc = terminalDoc([
      [terminalSpan("badge", { role: "primary", background: "focus" })],
    ]);

    expect(renderTerminalDocBlessed(doc)).toBe(
      "{red-fg}{white-bg}badge{/white-bg}{/red-fg}",
    );
  });

  it("keeps ANSI foregrounds on the inline palette", () => {
    const doc = terminalDoc([[terminalSpan("metadata", { role: "dim" })]]);

    expect(renderTerminalDocAnsi(doc)).toContain("\u001B[90m");
  });

  it("treats literal spans as undecorated content and escapes blessed tags", () => {
    const doc = terminalDoc([
      [
        terminalSpan("stderr: ", { role: "error", emphasis: "bold" }),
        literalSpan("{red-fg}child{/red-fg}"),
      ],
    ]);

    expect(renderTerminalDocPlain(doc)).toBe("stderr: {red-fg}child{/red-fg}");
    expect(stripAnsi(renderTerminalDocAnsi(doc))).toBe(
      "stderr: {red-fg}child{/red-fg}",
    );
    expect(renderTerminalDocBlessed(doc)).toContain(
      "{open}red-fg{close}child{open}/red-fg{close}",
    );
  });

  it("preserves literal span text exactly", () => {
    const literal = path.join(path.parse(process.cwd()).root, "child-output");
    const doc = terminalDoc([[literalSpan(literal)]]);

    expect(renderTerminalDocPlain(doc)).toBe(literal);
  });
});
