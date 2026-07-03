import { describe, expect, it } from "vitest";
import { annotateCommand, looksLikeCommand } from "./command-annotate.ts";
import type { TerminalSpan, TerminalSpanInput } from "./render-model.ts";

/** Role assigned to the span whose text is exactly `text`, or undefined. */
function roleOf(
  spans: readonly TerminalSpanInput[],
  text: string,
): string | undefined {
  const span = spans.find(
    (s): s is TerminalSpan => typeof s !== "string" && s.text === text,
  );
  return span?.role;
}

describe("looksLikeCommand", () => {
  it("is true only when the text begins with the program name", () => {
    expect(looksLikeCommand("wf template new")).toBe(true);
    expect(looksLikeCommand("workforest new")).toBe(true);
    expect(looksLikeCommand("  wf status")).toBe(true);
    expect(looksLikeCommand("template.jsonc")).toBe(false);
    expect(looksLikeCommand("branchPrefix")).toBe(false);
    expect(looksLikeCommand("workflow")).toBe(false); // not the whole word
  });
});

describe("annotateCommand", () => {
  it("assigns command / subcommand / flag / argument roles by position", () => {
    const spans = [
      ...(annotateCommand(
        "wf template new --dry-run <name>",
      ) as TerminalSpanInput[]),
    ];
    expect(roleOf(spans, "wf")).toBe("command");
    expect(roleOf(spans, "template")).toBe("subcommand");
    expect(roleOf(spans, "new")).toBe("subcommand");
    expect(roleOf(spans, "--dry-run")).toBe("warning");
    expect(roleOf(spans, "<name>")).toBe("accent");
  });

  it("leaves bare words unstyled for option syntax", () => {
    const spans = [
      ...(annotateCommand("--repo <repository>", {
        colorBareWords: false,
      }) as TerminalSpanInput[]),
    ];
    expect(roleOf(spans, "--repo")).toBe("warning");
    expect(roleOf(spans, "<repository>")).toBe("accent");
  });
});
