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

    expect(renderTerminalDocBlessed(doc)).toMatch(
      /^\{yellow-fg\}\{#[0-9a-f]{6}-bg\}\{bold\}\{inverse\}Queued\{\/inverse\}\{\/bold\}\{\/#[0-9a-f]{6}-bg\}\{\/yellow-fg\}$/u,
    );
  });

  it("treats literal spans as undecorated content and escapes blessed tags", () => {
    const doc = terminalDoc([
      [
        terminalSpan("stderr: ", { role: "error", emphasis: "bold" }),
        literalSpan("{red-fg}child{/red-fg}"),
      ],
    ]);

    expect(renderTerminalDocPlain(doc)).toBe(
      "stderr: {red-fg}child{/red-fg}",
    );
    expect(stripAnsi(renderTerminalDocAnsi(doc))).toBe(
      "stderr: {red-fg}child{/red-fg}",
    );
    expect(renderTerminalDocBlessed(doc)).toContain(
      "\\{red-fg\\}child\\{/red-fg\\}",
    );
  });
});
