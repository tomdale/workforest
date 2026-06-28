import chalk, { Chalk } from "chalk";
import {
  activeTheme,
  inlinePalette,
  type NamedColor,
  type ThemeColor,
  type ThemePalette,
  toBlessed,
} from "./theme-system.ts";

export type TerminalStyleRole = keyof ThemePalette;
export type TerminalBackgroundRole =
  | TerminalStyleRole
  | "background"
  | "border";
export type TerminalEmphasis = "bold" | "underline" | "inverse";

export type TerminalSpan = Readonly<{
  text: string;
  role?: TerminalStyleRole;
  background?: TerminalBackgroundRole;
  emphasis?: TerminalEmphasis | readonly TerminalEmphasis[];
  literal?: boolean;
}>;

export type TerminalLine = Readonly<{
  spans: readonly TerminalSpan[];
}>;

export type TerminalDoc = Readonly<{
  lines: readonly TerminalLine[];
}>;

export type TerminalSpanInput = string | TerminalSpan;
export type TerminalLineInput = string | readonly TerminalSpanInput[];
type ChalkInstance = InstanceType<typeof Chalk>;

export function terminalDoc(lines: readonly TerminalLineInput[]): TerminalDoc {
  return { lines: lines.map(terminalLine) };
}

export function terminalLine(input: TerminalLineInput): TerminalLine {
  if (typeof input === "string") {
    return { spans: [terminalSpan(input)] };
  }
  return {
    spans: input.map((item) =>
      typeof item === "string" ? terminalSpan(item) : item,
    ),
  };
}

export function terminalSpan(
  text: string,
  style: Omit<TerminalSpan, "text"> = {},
): TerminalSpan {
  return { text, ...style };
}

export function literalSpan(text: string): TerminalSpan {
  return { text, literal: true };
}

export function renderTerminalDocPlain(doc: TerminalDoc): string {
  return doc.lines.map((line) => renderPlainLine(line)).join("\n");
}

export function renderTerminalLinePlain(line: TerminalLine): string {
  return renderPlainLine(line);
}

export function renderTerminalDocAnsi(doc: TerminalDoc): string {
  const chalk = new Chalk({ level: 1 });
  return doc.lines.map((line) => renderAnsiLine(line, chalk)).join("\n");
}

export function renderTerminalDocInline(doc: TerminalDoc): string {
  return chalk.level > 0
    ? renderTerminalDocAnsi(doc)
    : renderTerminalDocPlain(doc);
}

export function renderTerminalLineAnsi(line: TerminalLine): string {
  return renderAnsiLine(line, new Chalk({ level: 1 }));
}

export function renderTerminalDocBlessed(doc: TerminalDoc): string {
  return doc.lines.map((line) => renderBlessedLine(line)).join("\n");
}

export function renderTerminalLineBlessed(line: TerminalLine): string {
  return renderBlessedLine(line);
}

function renderPlainLine(line: TerminalLine): string {
  return line.spans.map((span) => span.text).join("");
}

function renderAnsiLine(line: TerminalLine, chalk: ChalkInstance): string {
  return line.spans.map((span) => renderAnsiSpan(span, chalk)).join("");
}

function renderAnsiSpan(span: TerminalSpan, chalk: ChalkInstance): string {
  if (span.literal) return span.text;

  let style = (value: string) => value;
  if (span.role) {
    style = compose(
      style,
      foregroundStyler(resolvePaletteColor(span.role), chalk),
    );
  }
  if (span.background) {
    style = compose(
      style,
      backgroundStyler(resolveBackgroundColor(span.background), chalk),
    );
  }
  for (const emphasis of normalizedEmphasis(span.emphasis)) {
    style = compose(style, emphasisStyler(emphasis, chalk));
  }
  return style(span.text);
}

function renderBlessedLine(line: TerminalLine): string {
  return line.spans.map(renderBlessedSpan).join("");
}

function renderBlessedSpan(span: TerminalSpan): string {
  const text = escapeBlessedText(span.text);
  if (span.literal) return text;

  const open: string[] = [];
  const close: string[] = [];
  if (span.role) {
    const token = toBlessed(resolvePaletteColor(span.role));
    open.push(`{${token}-fg}`);
    close.unshift(`{/${token}-fg}`);
  }
  if (span.background) {
    const token = toBlessed(resolveBackgroundColor(span.background));
    open.push(`{${token}-bg}`);
    close.unshift(`{/${token}-bg}`);
  }
  for (const emphasis of normalizedEmphasis(span.emphasis)) {
    open.push(`{${emphasis}}`);
    close.unshift(`{/${emphasis}}`);
  }
  return `${open.join("")}${text}${close.join("")}`;
}

function normalizedEmphasis(
  emphasis: TerminalSpan["emphasis"],
): readonly TerminalEmphasis[] {
  if (!emphasis) return [];
  return typeof emphasis === "string" ? [emphasis] : emphasis;
}

function resolvePaletteColor(role: TerminalStyleRole): ThemeColor {
  return inlinePalette()[role];
}

function resolveBackgroundColor(role: TerminalBackgroundRole): ThemeColor {
  const theme = activeTheme();
  if (role === "background") return theme.chrome.background;
  if (role === "border") return theme.chrome.border;
  return inlinePalette()[role];
}

function compose(
  left: (value: string) => string,
  right: (value: string) => string,
): (value: string) => string {
  return (value) => left(right(value));
}

function foregroundStyler(
  color: ThemeColor,
  chalk: ChalkInstance,
): (value: string) => string {
  if (color.kind === "rgb") {
    const [r, g, b] = color.rgb;
    return (value) => chalk.rgb(r, g, b)(value);
  }
  return (value) => chalk[color.name](value);
}

function backgroundStyler(
  color: ThemeColor,
  chalk: ChalkInstance,
): (value: string) => string {
  if (color.kind === "rgb") {
    const [r, g, b] = color.rgb;
    return (value) => chalk.bgRgb(r, g, b)(value);
  }
  return (value) => backgroundNamedStyler(color.name, chalk)(value);
}

function emphasisStyler(
  emphasis: TerminalEmphasis,
  chalk: ChalkInstance,
): (value: string) => string {
  return (value) => chalk[emphasis](value);
}

function backgroundNamedStyler(
  name: NamedColor,
  chalk: ChalkInstance,
): (value: string) => string {
  switch (name) {
    case "black":
      return chalk.bgBlack;
    case "red":
      return chalk.bgRed;
    case "green":
      return chalk.bgGreen;
    case "yellow":
      return chalk.bgYellow;
    case "blue":
      return chalk.bgBlue;
    case "magenta":
      return chalk.bgMagenta;
    case "cyan":
      return chalk.bgCyan;
    case "white":
      return chalk.bgWhite;
    case "gray":
      return chalk.bgGray;
    case "redBright":
      return chalk.bgRedBright;
    case "greenBright":
      return chalk.bgGreenBright;
    case "yellowBright":
      return chalk.bgYellowBright;
    case "blueBright":
      return chalk.bgBlueBright;
    case "magentaBright":
      return chalk.bgMagentaBright;
    case "cyanBright":
      return chalk.bgCyanBright;
    case "whiteBright":
      return chalk.bgWhiteBright;
  }
}

function escapeBlessedText(value: string): string {
  return value.replace(/[{}]/g, (char) => (char === "{" ? "\\{" : "\\}"));
}
