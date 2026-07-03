import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown.ts";
import { renderTerminalDocPlain, type TerminalSpan } from "./render-model.ts";

function findSpan(
  doc: ReturnType<typeof renderMarkdown>,
  text: string,
): TerminalSpan | undefined {
  return doc.lines.flatMap((line) => line.spans).find((s) => s.text === text);
}

function plain(md: string): string {
  return renderTerminalDocPlain(renderMarkdown(md));
}

describe("renderMarkdown", () => {
  it("paints headings with the heading role, level via emphasis", () => {
    const doc = renderMarkdown("# Title\n\n## Sub\n\n### Deep");
    expect(findSpan(doc, "Title")).toMatchObject({
      role: "heading",
      emphasis: ["bold"],
    });
    expect(findSpan(doc, "Sub")).toMatchObject({ role: "heading" });
    expect(findSpan(doc, "Sub")?.emphasis).toBeUndefined();
    expect(findSpan(doc, "Deep")).toMatchObject({
      role: "heading",
      emphasis: ["underline"],
    });
  });

  it("renders bullet lists with a muted marker and 1-space indent", () => {
    const doc = renderMarkdown("- one\n- two");
    expect(plain("- one\n- two")).toBe(" • one\n • two");
    expect(findSpan(doc, "• ")).toMatchObject({ role: "muted" });
  });

  it("numbers ordered lists sequentially", () => {
    expect(plain("1. a\n1. b\n1. c")).toBe(" 1. a\n 2. b\n 3. c");
  });

  it("annotates inline code that is a command invocation", () => {
    const doc = renderMarkdown("Run `wf new foo` now.");
    expect(findSpan(doc, "wf")).toMatchObject({ role: "command" });
    expect(findSpan(doc, "new")).toMatchObject({ role: "subcommand" });
    expect(findSpan(doc, "foo")).toMatchObject({ role: "subcommand" });
  });

  it("gives non-command inline code the code role", () => {
    const doc = renderMarkdown("Edit `template.jsonc` by hand.");
    expect(findSpan(doc, "template.jsonc")).toMatchObject({ role: "code" });
  });

  it("bolds **strong** and does not treat `_` as emphasis", () => {
    const doc = renderMarkdown("A **bold** word in the _adhoc group.");
    expect(findSpan(doc, "bold")).toMatchObject({ emphasis: ["bold"] });
    expect(plain("A **bold** word in the _adhoc group.")).toBe(
      "A bold word in the _adhoc group.",
    );
  });

  it("preserves author line breaks and collapses blank runs", () => {
    expect(plain("line one\nline two\n\n\npara two")).toBe(
      "line one\nline two\n\npara two",
    );
  });

  it("keeps <name> literal (no HTML/autolinks)", () => {
    expect(plain("Create `wf new <name>`; names look like <name>.")).toContain(
      "names look like <name>.",
    );
  });

  it("paints a whole-line <wf:role> tag uniformly, flattening inline markup", () => {
    const doc = renderMarkdown(
      "Normal line.\n<wf:muted>Note: run `wf x` please.</wf:muted>",
    );
    const note = doc.lines.at(-1)?.spans ?? [];
    expect(note).toHaveLength(1);
    expect(note[0]).toMatchObject({
      role: "muted",
      text: "Note: run wf x please.",
    });
  });

  it("paints an inline <wf:role>text</wf:role> span with that role", () => {
    const doc = renderMarkdown(
      "This is <wf:error>danger</wf:error> but this is fine.",
    );
    expect(findSpan(doc, "danger")).toMatchObject({ role: "error" });
    expect(findSpan(doc, "danger")?.emphasis).toBeUndefined();
  });

  it("leaves un-namespaced tags, unknown roles, and placeholders literal", () => {
    // A `<muted>` without the wf: namespace, an unknown wf: role, and a bare
    // placeholder all pass through untouched.
    const input =
      "A <muted>x</muted>, a <wf:bogus>y</wf:bogus>, and a bare <name>.";
    expect(plain(input)).toBe(input);
  });
});
