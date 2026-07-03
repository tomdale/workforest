import {
  annotateCommand,
  looksLikeCommand,
  tokenize,
} from "./command-annotate.ts";
import {
  type TerminalDoc,
  type TerminalEmphasis,
  type TerminalLineInput,
  type TerminalSpanInput,
  type TerminalStyleRole,
  terminalDoc,
  terminalSpan,
} from "./render-model.ts";
import { isThemeRole } from "./theme-system.ts";

/**
 * Renders a Markdown `description` to the terminal through the theme. Block
 * elements (headings, paragraphs, lists) map to {@link ThemePalette} roles via a
 * {@link MarkdownStyle} map, and inline code that reads as a command is annotated
 * with command/subcommand/argument roles (see {@link annotateCommand}) so
 * `` `wf template new` `` colors `wf` and `template new` distinctly.
 *
 * Scope is deliberately a small subset — headings (`#`..`######`), lists
 * (bullet/ordered, one nesting level), inline code, and `**bold**`/`*em*`. `_` is
 * not treated as emphasis so identifiers like `_adhoc` survive intact. Line
 * breaks are preserved (each source line renders on its own line, CLI-help style,
 * rather than CommonMark's soft-break-joins-lines); blank lines separate blocks.
 *
 * Beyond Markdown, a namespaced `<wf:role>text</wf:role>` tag attaches a palette
 * role directly: wrap a phrase for an inline accent (`<wf:error>deprecated</wf:error>`)
 * or a whole line for a de-emphasized note (`<wf:muted>Agents: …</wf:muted>`). The
 * `wf:` prefix keeps these from colliding with `<name>` placeholders or literal
 * XML/HTML in a description.
 */

/** How one Markdown element paints: a palette role and/or added emphasis. */
export type MarkdownSpanStyle = Readonly<{
  role?: TerminalStyleRole;
  emphasis?: readonly TerminalEmphasis[];
}>;

export type MarkdownStyle = Readonly<{
  h1: MarkdownSpanStyle;
  h2: MarkdownSpanStyle;
  h3: MarkdownSpanStyle;
  /** Inline code that is not a command invocation. */
  code: MarkdownSpanStyle;
  /** `**strong**`. */
  strong: MarkdownSpanStyle;
  /** `*emphasis*` (there is no italic terminal weight, so it underlines). */
  emphasis: MarkdownSpanStyle;
  /** The `•`/`1.` marker in front of a list item. */
  listMarker: MarkdownSpanStyle;
}>;

/**
 * All heading levels share the dedicated `heading` role (its color); the level
 * is conveyed by emphasis, so h1 reads boldest and deeper levels recede.
 */
export const DEFAULT_MARKDOWN_STYLE: MarkdownStyle = {
  h1: { role: "heading", emphasis: ["bold"] },
  h2: { role: "heading" },
  h3: { role: "heading", emphasis: ["underline"] },
  code: { role: "code" },
  strong: { emphasis: ["bold"] },
  emphasis: { emphasis: ["underline"] },
  listMarker: { role: "muted" },
};

const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^(\s*)(?:[-*]|\d+\.)\s+(.*)$/;
const ORDERED_ITEM = /^\s*\d+\./;
/**
 * An app-semantic annotation beyond Markdown: `<wf:role>text</wf:role>` paints
 * its content with a palette role. The `wf:` namespace disambiguates it from
 * `<name>` placeholders and literal XML/HTML. The role is validated against
 * {@link isThemeRole}; an unknown role (or any un-namespaced tag) is left
 * literal. {@link ROLE_TAG} re-parses a matched token to pull out role and content.
 */
const ROLE_TAG = /^<wf:([a-z][a-z0-9]*)>([\s\S]*)<\/wf:\1>$/i;
const INLINE =
  /<wf:([a-z][a-z0-9]*)>.*?<\/wf:\1>|`[^`]+`|\*\*[^*]+\*\*|\*(?!\s)[^*]+\*/gi;

export function renderMarkdown(
  markdown: string,
  overrides: Partial<MarkdownStyle> = {},
): TerminalDoc {
  const style: MarkdownStyle = { ...DEFAULT_MARKDOWN_STYLE, ...overrides };
  const rawLines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const lines: TerminalLineInput[] = [];

  // Collapse runs of blank lines to a single separator, and never emit a
  // leading or trailing blank.
  let pendingBlank = false;
  let ordinal = 0;
  let inList = false;
  const push = (line: TerminalLineInput) => {
    if (pendingBlank) {
      lines.push("");
      pendingBlank = false;
    }
    lines.push(line);
  };

  for (const raw of rawLines) {
    if (raw.trim() === "") {
      if (lines.length > 0) pendingBlank = true;
      inList = false;
      continue;
    }

    const heading = raw.match(HEADING);
    if (heading) {
      inList = false;
      push([
        terminalSpan(
          (heading[2] ?? "").trim(),
          headingStyle(heading[1] ?? "", style),
        ),
      ]);
      continue;
    }

    const item = raw.match(LIST_ITEM);
    if (item) {
      if (!inList) {
        inList = true;
        ordinal = 0;
      }
      ordinal += 1;
      const depth = (item[1] ?? "").length >= 2 ? 1 : 0;
      const marker = ORDERED_ITEM.test(raw) ? `${ordinal}.` : "•";
      push([
        " ".repeat(depth + 1),
        terminalSpan(`${marker} `, style.listMarker),
        ...renderInline((item[2] ?? "").trim(), style),
      ]);
      continue;
    }

    inList = false;
    push(renderInline(raw.trim(), style));
  }

  return terminalDoc(lines);
}

/** Strip inline Markdown/annotation markers, leaving plain text. */
function stripInline(text: string): string {
  return text
    .replace(/<wf:([a-z][a-z0-9]*)>([\s\S]*?)<\/wf:\1>/gi, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*(?!\s)([^*]+)\*/g, "$1");
}

function headingStyle(hashes: string, style: MarkdownStyle): MarkdownSpanStyle {
  return hashes.length === 1
    ? style.h1
    : hashes.length === 2
      ? style.h2
      : style.h3;
}

function renderInline(text: string, style: MarkdownStyle): TerminalSpanInput[] {
  const spans = tokenize(text, INLINE, (token) => {
    if (token.startsWith("<")) {
      const tag = token.match(ROLE_TAG);
      const role = tag?.[1];
      if (tag && role && isThemeRole(role)) {
        // Content renders as plain text in that role (inner markup flattened),
        // so the annotation reads as one uniformly-styled span.
        return [terminalSpan(stripInline(tag[2] ?? ""), { role })];
      }
      return [token]; // unknown role: leave the tag literal
    }
    if (token.startsWith("`")) {
      const inner = token.slice(1, -1);
      return looksLikeCommand(inner)
        ? asSpans(annotateCommand(inner))
        : [terminalSpan(inner, style.code)];
    }
    if (token.startsWith("**")) {
      return [terminalSpan(token.slice(2, -2), style.strong)];
    }
    return [terminalSpan(token.slice(1, -1), style.emphasis)];
  });
  return asSpans(spans);
}

/** `tokenize`/`annotateCommand` always build an array; narrow the union. */
function asSpans(value: TerminalLineInput): TerminalSpanInput[] {
  return typeof value === "string" ? [value] : [...value];
}
