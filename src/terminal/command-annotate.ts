import {
  type TerminalLineInput,
  type TerminalSpanInput,
  terminalSpan,
} from "./render-model.ts";

/**
 * Split `value` on `pattern`, styling each match through `style` and leaving the
 * text between matches as literal spans. The shared primitive behind the
 * command annotator, the help inline stylers, and the Markdown renderer's inline
 * pass — every `style` callback returns an array of spans.
 */
export function tokenize(
  value: string,
  pattern: RegExp,
  style: (token: string) => TerminalLineInput,
): TerminalLineInput {
  const spans: TerminalSpanInput[] = [];
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const token = match[0] ?? "";
    const index = match.index ?? cursor;
    if (index > cursor) {
      spans.push(value.slice(cursor, index));
    }
    spans.push(...style(token));
    cursor = index + token.length;
  }
  if (cursor < value.length) {
    spans.push(value.slice(cursor));
  }
  return spans;
}

/**
 * True when `value` reads as a `wf`/`workforest` command invocation, i.e. its
 * first word is the program name. Inline code that passes this is annotated with
 * command roles; anything else renders as a plain code literal.
 */
export function looksLikeCommand(value: string): boolean {
  return /^(?:wf|workforest)(?:\s|$)/.test(value.trimStart());
}

/**
 * Classify a command string into themed spans: the program name (`wf`) as the
 * {@link ThemePalette.command} role, bare words as {@link ThemePalette.subcommand},
 * `-flags` as {@link ThemePalette.warning}, and `<arg>`/`[opt]` placeholders as
 * {@link ThemePalette.accent}. With `colorBareWords: false` (option syntax, where
 * a bare word is a value name rather than a subcommand) bare words are left
 * unstyled.
 */
export function annotateCommand(
  value: string,
  { colorBareWords = true }: { colorBareWords?: boolean } = {},
): TerminalLineInput {
  const tokens =
    /(?:^|[\s,])--?[a-z][\w-]*|\b(?:wf|workforest)\b|<[^>]+>|\[[^\]]+\]|(?:^|\s)[a-z][\w|.-]*(?=\s|$)/gi;

  return tokenize(value, tokens, (token) => {
    const normalized = token.trimStart();
    const prefix = token.slice(0, token.length - normalized.length);

    if (normalized === "wf" || normalized === "workforest") {
      return [prefix, terminalSpan(normalized, { role: "command" })];
    }
    if (normalized.startsWith("-")) {
      return [prefix, terminalSpan(normalized, { role: "warning" })];
    }
    if (normalized.startsWith("<") || normalized.startsWith("[")) {
      return [prefix, terminalSpan(normalized, { role: "accent" })];
    }
    if (colorBareWords) {
      return [prefix, terminalSpan(normalized, { role: "subcommand" })];
    }
    return [token];
  });
}
