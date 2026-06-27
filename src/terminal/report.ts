import chalk from "chalk";
import { type StatusTone, statusGlyph } from "./status-indicator.ts";
import { terminalColor } from "./theme.ts";

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
  const lines = [terminalColor.primary(chalk.bold(report.title))];

  for (const section of report.sections) {
    lines.push("");
    if (section.title) {
      lines.push(terminalColor.accent(chalk.bold(section.title)));
    }
    if (section.note) {
      lines.push(`  ${terminalColor.muted(section.note)}`);
    }
    if (section.fields) {
      lines.push(...renderFields(section.fields, 2));
    }
    if (section.entries) {
      for (const [index, entry] of section.entries.entries()) {
        if (index > 0) lines.push("");
        const description = entry.description
          ? terminalColor.muted(` - ${entry.description}`)
          : "";
        const glyph = entry.tone ? `${statusGlyph(entry.tone)} ` : "";
        lines.push(`  ${glyph}${chalk.bold(entry.title)}${description}`);
        if (entry.details) {
          lines.push(...renderFields(entry.details, 4));
        }
      }
    }
  }

  if (report.footer) {
    lines.push("", terminalColor.muted(report.footer));
  }

  return lines.join("\n");
}

function renderFields(
  fields: readonly ReportField[],
  indent: number,
): string[] {
  const labelWidth = Math.max(0, ...fields.map((field) => field.label.length));
  const prefix = " ".repeat(indent);

  return fields.map(
    (field) =>
      `${prefix}${terminalColor.muted(`${field.label}:`.padEnd(labelWidth + 1))} ${field.value}`,
  );
}
