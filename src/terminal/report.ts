import chalk from "chalk";
import {
  literalSpan,
  renderTerminalDocAnsi,
  renderTerminalDocPlain,
  type TerminalDoc,
  type TerminalLineInput,
  type TerminalSpan,
  terminalSpan,
} from "./render-model.ts";
import type { StatusTone } from "./status-indicator.ts";
import { terminalSymbol } from "./theme.ts";

export type ReportField = Readonly<{
  label: string;
  value: string;
}>;

export type ReportEntry = Readonly<{
  title: string;
  description?: string;
  details?: readonly ReportField[];
  /** When set, the entry is prefixed with the tone's colored status glyph. */
  tone?: StatusTone;
}>;

export type ReportSection = Readonly<{
  title?: string;
  fields?: readonly ReportField[];
  entries?: readonly ReportEntry[];
  /** A muted, indented line — used for empty states ("No tasks yet."). */
  note?: string;
}>;

export type Report = Readonly<{
  title: string;
  sections: readonly ReportSection[];
  footer?: string;
}>;

export function printReport(report: Report): void {
  console.log(renderReport(report));
}

export function renderReport(report: Report): string {
  return renderInlineDoc(reportDoc(report));
}

export function reportDoc(report: Report): TerminalDoc {
  const lines: TerminalLineInput[] = [
    [terminalSpan(report.title, { role: "primary", emphasis: "bold" })],
  ];

  for (const section of report.sections) {
    lines.push("");
    if (section.title) {
      lines.push([
        terminalSpan(section.title, { role: "accent", emphasis: "bold" }),
      ]);
    }
    if (section.note) {
      lines.push(["  ", terminalSpan(section.note, { role: "muted" })]);
    }
    if (section.fields) {
      lines.push(...renderFields(section.fields, 2));
    }
    if (section.entries) {
      for (const [index, entry] of section.entries.entries()) {
        if (index > 0) lines.push("");
        const description = entry.description
          ? terminalSpan(` - ${entry.description}`, { role: "muted" })
          : null;
        lines.push([
          "  ",
          ...statusGlyphSpans(entry.tone),
          terminalSpan(entry.title, { emphasis: "bold" }),
          ...(description ? [description] : []),
        ]);
        if (entry.details) {
          lines.push(...renderFields(entry.details, 4));
        }
      }
    }
  }

  if (report.footer) {
    lines.push(
      "",
      ...report.footer
        .split("\n")
        .map((line) => [terminalSpan(line, { role: "muted" })]),
    );
  }

  return { lines: lines.map((line) => normalizeLine(line)) };
}

function renderFields(
  fields: readonly ReportField[],
  indent: number,
): TerminalLineInput[] {
  const labelWidth = Math.max(0, ...fields.map((field) => field.label.length));
  const prefix = " ".repeat(indent);

  return fields.map((field) => [
    prefix,
    terminalSpan(`${field.label}:`.padEnd(labelWidth + 1), { role: "muted" }),
    " ",
    literalSpan(field.value),
  ]);
}

function statusGlyphSpans(tone: StatusTone | undefined): TerminalSpan[] {
  if (!tone) return [];
  return [
    terminalSpan(statusGlyphText(tone), { role: statusRole(tone) }),
    " ",
  ].map((span) => (typeof span === "string" ? terminalSpan(span) : span));
}

function statusGlyphText(tone: StatusTone): string {
  switch (tone) {
    case "success":
      return terminalSymbol.statusComplete;
    case "error":
      return terminalSymbol.statusFailed;
    case "warning":
      return terminalSymbol.warning;
    case "pending":
      return terminalSymbol.statusPending;
    case "cancelled":
      return terminalSymbol.statusCancelled;
    case "info":
      return terminalSymbol.info;
  }
}

function statusRole(tone: StatusTone): NonNullable<TerminalSpan["role"]> {
  switch (tone) {
    case "success":
      return "success";
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "pending":
    case "cancelled":
      return "muted";
    case "info":
      return "accent";
  }
}

function normalizeLine(line: TerminalLineInput): TerminalDoc["lines"][number] {
  if (typeof line === "string") {
    return { spans: [terminalSpan(line)] };
  }
  return {
    spans: line.map((span) =>
      typeof span === "string" ? terminalSpan(span) : span,
    ),
  };
}

function renderInlineDoc(doc: TerminalDoc): string {
  return chalk.level > 0
    ? renderTerminalDocAnsi(doc)
    : renderTerminalDocPlain(doc);
}
