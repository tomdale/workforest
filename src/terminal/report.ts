import chalk from "chalk";
import { terminalColor } from "./theme.ts";

export type ReportField = {
  label: string;
  value: string;
};

export type ReportEntry = {
  title: string;
  description?: string;
  details?: ReportField[];
};

export type ReportSection = {
  title?: string;
  fields?: ReportField[];
  entries?: ReportEntry[];
};

export type Report = {
  title: string;
  sections: ReportSection[];
  footer?: string;
};

export function printReport(report: Report): void {
  console.log(renderReport(report));
}

export function renderReport(report: Report): string {
  const lines = [chalk.bold(report.title)];

  for (const section of report.sections) {
    lines.push("");
    if (section.title) {
      lines.push(chalk.bold(section.title));
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
        lines.push(`  ${chalk.bold(entry.title)}${description}`);
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

function renderFields(fields: ReportField[], indent: number): string[] {
  const labelWidth = Math.max(0, ...fields.map((field) => field.label.length));
  const prefix = " ".repeat(indent);

  return fields.map(
    (field) =>
      `${prefix}${terminalColor.muted(`${field.label}:`.padEnd(labelWidth + 1))} ${field.value}`,
  );
}
