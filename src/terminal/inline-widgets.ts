import { InlineSurface } from "./inline-surface.ts";
import { InputDecoder, type KeyInput } from "./input-decoder.ts";
import { lineEditor } from "./line-editor.ts";
import {
  renderTerminalLineAnsi,
  type TerminalLine,
  type TerminalSpanInput,
  terminalLine,
  terminalSpan,
} from "./render-model.ts";
import type { PromptResult } from "./result.ts";
import { TerminalSession } from "./session.ts";
import { truncate, visibleWidth, wrap } from "./text.ts";

export type TerminalSymbols = {
  active: TerminalSpanInput;
  done: TerminalSpanInput;
  cancel: TerminalSpanInput;
  bar: TerminalSpanInput;
  barEnd: TerminalSpanInput;
  barStart: TerminalSpanInput;
  barHorizontal: TerminalSpanInput;
  radioOn: TerminalSpanInput;
  radioOff: TerminalSpanInput;
  checkOn: TerminalSpanInput;
  checkOff: TerminalSpanInput;
  info: TerminalSpanInput;
  warning: TerminalSpanInput;
  error: TerminalSpanInput;
  success: TerminalSpanInput;
};

export type Choice<T> = {
  value: T;
  label: string;
  hint?: string;
};

export type SelectHotkey<T> = {
  key: string;
  value: T;
  hint: string;
};

export async function textPrompt(
  message: string,
  options: {
    validate?: (input: string) => string | undefined;
    defaultValue?: string;
    placeholder?: string;
    symbols: TerminalSymbols;
  },
): Promise<PromptResult<string>> {
  return lineEditor({
    message,
    prefix: {
      active: options.symbols.active,
      done: options.symbols.done,
      bar: options.symbols.bar,
      barEnd: options.symbols.barEnd,
      cancel: options.symbols.cancel,
    },
    ...(options.validate !== undefined ? { validate: options.validate } : {}),
    ...(options.defaultValue !== undefined
      ? { defaultValue: options.defaultValue }
      : {}),
    ...(options.placeholder !== undefined
      ? { placeholder: options.placeholder }
      : {}),
  });
}

export async function confirmPrompt(
  message: string,
  defaultValue: boolean,
  symbols: TerminalSymbols,
): Promise<PromptResult<boolean>> {
  let value = defaultValue;
  return interactivePrompt({
    render: () => {
      const yes = terminalSpan(
        "Yes",
        value ? { emphasis: "underline" } : { role: "muted" },
      );
      const no = terminalSpan(
        "No",
        value ? { role: "muted" } : { emphasis: "underline" },
      );
      return [
        promptLine(symbols.active, message),
        prefixedLine(symbols.bar, [yes, " / ", no]),
        promptLine(symbols.barEnd),
      ];
    },
    done: () => doneLine(symbols.done, message, value ? "Yes" : "No"),
    onKey: (event) => {
      if (event.type === "submit") return { submit: true, value };
      if (event.type === "text") {
        if (/^y$/i.test(event.value)) return { submit: true, value: true };
        if (/^n$/i.test(event.value)) return { submit: true, value: false };
        if (event.value === "h") value = true;
        if (event.value === "l") value = false;
      }
      if (event.type === "tab") value = !value;
      if (event.type === "arrow") {
        if (event.direction === "left") value = true;
        if (event.direction === "right") value = false;
      }
      return {};
    },
  });
}

export async function selectPrompt<T>(
  message: string,
  items: Choice<T>[],
  symbols: TerminalSymbols,
  hotkeys?: SelectHotkey<T>[],
): Promise<PromptResult<T>> {
  if (items.length === 0)
    throw new Error("select requires at least one option.");
  let index = 0;

  return interactivePrompt({
    render: () => {
      const lines = [promptLine(symbols.active, message)];
      for (const [i, item] of items.entries()) {
        const selected = i === index;
        lines.push(
          prefixedLine(symbols.bar, [
            selected ? symbols.radioOn : symbols.radioOff,
            " ",
            ...choiceText(item, selected),
          ]),
        );
      }
      if (hotkeys?.length) {
        lines.push(promptLine(symbols.bar));
        for (const hotkey of hotkeys) {
          lines.push(
            prefixedLine(symbols.bar, [
              terminalSpan(`${hotkey.key} to ${hotkey.hint}`, {
                role: "muted",
              }),
            ]),
          );
        }
      }
      lines.push(promptLine(symbols.barEnd));
      return lines;
    },
    done: (value) => {
      const selected = items.find((item) => Object.is(item.value, value));
      return doneLine(symbols.done, message, selected?.label ?? "");
    },
    onKey: (event) => {
      if (event.type === "submit") {
        const selected = items[index];
        return selected ? { submit: true, value: selected.value } : {};
      }
      if (event.type === "arrow") {
        if (event.direction === "up")
          index = (index - 1 + items.length) % items.length;
        if (event.direction === "down") index = (index + 1) % items.length;
      }
      if (event.type === "home") index = 0;
      if (event.type === "end") index = items.length - 1;
      if (event.type === "text") {
        if (event.value === "k")
          index = (index - 1 + items.length) % items.length;
        if (event.value === "j") index = (index + 1) % items.length;
        const hotkey = hotkeys?.find(
          (candidate) => candidate.key === event.value,
        );
        if (hotkey) return { submit: true, value: hotkey.value };
      }
      return {};
    },
  });
}

export async function multiSelectPrompt<T>(
  message: string,
  items: Choice<T>[],
  options: {
    initialValues?: T[];
    required?: boolean;
    allowAll?: boolean;
    symbols: TerminalSymbols;
  },
): Promise<PromptResult<T[]>> {
  if (items.length === 0) {
    throw new Error("multiSelect requires at least one option.");
  }

  let index = 0;
  const checked = new Set<number>();
  for (const [i, item] of items.entries()) {
    if (options.initialValues?.includes(item.value)) checked.add(i);
  }

  return interactivePrompt({
    render: () => {
      const lines = [promptLine(options.symbols.active, message)];
      for (const [i, item] of items.entries()) {
        const selected = i === index;
        lines.push(
          prefixedLine(options.symbols.bar, [
            checked.has(i) ? options.symbols.checkOn : options.symbols.checkOff,
            " ",
            ...choiceText(item, selected),
          ]),
        );
      }
      lines.push(promptLine(options.symbols.barEnd));
      return lines;
    },
    done: () => {
      const selected = items
        .filter((_, i) => checked.has(i))
        .map((item) => item.label);
      return doneLine(
        options.symbols.done,
        message,
        selected.length > 0 ? selected.join(", ") : "none",
      );
    },
    onKey: (event) => {
      if (event.type === "submit") {
        if (options.required !== false && checked.size === 0) return {};
        return {
          submit: true,
          value: items
            .filter((_, i) => checked.has(i))
            .map((item) => item.value),
        };
      }
      if (event.type === "space") toggle(checked, index);
      if (event.type === "arrow") {
        if (event.direction === "up")
          index = (index - 1 + items.length) % items.length;
        if (event.direction === "down") index = (index + 1) % items.length;
      }
      if (event.type === "home") index = 0;
      if (event.type === "end") index = items.length - 1;
      if (event.type === "text") {
        if (event.value === "k")
          index = (index - 1 + items.length) % items.length;
        if (event.value === "j") index = (index + 1) % items.length;
        if (options.allowAll !== false && event.value === "a") {
          if (checked.size === items.length) checked.clear();
          else for (let i = 0; i < items.length; i++) checked.add(i);
        }
      }
      return {};
    },
  });
}

export function filterFuzzyChoices<T>(
  options: Choice<T>[],
  query: string,
): Choice<T>[] {
  const pattern = Array.from(query.trim().toLocaleLowerCase());
  if (pattern.length === 0) return options;

  return options.filter((option) => {
    const searchable =
      `${option.label} ${option.hint ?? ""}`.toLocaleLowerCase();
    let offset = 0;
    for (const char of pattern) {
      const next = searchable.indexOf(char, offset);
      if (next === -1) return false;
      offset = next + 1;
    }
    return true;
  });
}

export async function fuzzySelectPrompt<T>(
  message: string,
  items: Choice<T>[],
  symbols: TerminalSymbols,
): Promise<PromptResult<T>> {
  if (items.length === 0) {
    throw new Error("fuzzySelect requires at least one option.");
  }

  let query = "";
  let index = 0;
  const filtered = (): Choice<T>[] => filterFuzzyChoices(items, query);

  return interactivePrompt({
    render: () => {
      const choices = filtered();
      if (index >= choices.length) index = Math.max(0, choices.length - 1);
      const lines = [
        promptLine(symbols.active, message),
        prefixedLine(symbols.bar, [
          query || terminalSpan("Type to filter", { role: "muted" }),
        ]),
      ];

      if (choices.length === 0) {
        lines.push(
          prefixedLine(symbols.bar, [
            terminalSpan("No matches", { role: "muted" }),
          ]),
        );
      } else {
        for (const [i, item] of choices.entries()) {
          const selected = i === index;
          lines.push(
            prefixedLine(symbols.bar, [
              selected ? symbols.radioOn : symbols.radioOff,
              " ",
              ...choiceText(item, selected),
            ]),
          );
        }
      }

      lines.push(promptLine(symbols.barEnd));
      return lines;
    },
    done: (value) => {
      const selected = items.find((item) => Object.is(item.value, value));
      return doneLine(symbols.done, message, selected?.label ?? "");
    },
    onKey: (event) => {
      const choices = filtered();
      if (event.type === "submit") {
        const selected = choices[index];
        return selected ? { submit: true, value: selected.value } : {};
      }
      if (event.type === "backspace") {
        query = Array.from(query).slice(0, -1).join("");
        index = 0;
      }
      if (event.type === "arrow") {
        if (event.direction === "up" && choices.length > 0) {
          index = (index - 1 + choices.length) % choices.length;
        }
        if (event.direction === "down" && choices.length > 0) {
          index = (index + 1) % choices.length;
        }
      }
      if (event.type === "home") index = 0;
      if (event.type === "end") index = Math.max(0, choices.length - 1);
      if (event.type === "text") {
        query += event.value;
        index = 0;
      }
      if (event.type === "space") {
        query += " ";
        index = 0;
      }
      return {};
    },
  });
}

export function intro(title: string, symbols: TerminalSymbols): void {
  writeLine(promptLine(symbols.barStart, title));
}

export function outro(message: string, symbols: TerminalSymbols): void {
  writeLine(promptLine(symbols.barEnd, message));
}

export function cancel(message: string, symbols: TerminalSymbols): void {
  writeLine(
    prefixedLine(symbols.cancel, [terminalSpan(message, { role: "error" })]),
  );
}

export function note(
  content: string,
  title: string | undefined,
  symbols: TerminalSymbols,
): void {
  const width = Math.max(20, Math.min(process.stdout.columns ?? 80, 120) - 6);
  const contentLines = content.split("\n").flatMap((line) => wrap(line, width));
  const maxLen = Math.max(
    title ? visibleWidth(title) : 0,
    ...contentLines.map((line) => visibleWidth(line)),
  );
  const pad = Math.min(width, maxLen + 2);

  if (title) {
    const ruleWidth = Math.max(0, pad - visibleWidth(title) - 1);
    writeLine(
      prefixedLine(symbols.barStart, [
        title,
        " ",
        repeatSymbol(symbols.barHorizontal, ruleWidth),
      ]),
    );
  } else {
    writeLine(
      terminalLine([
        "  ",
        symbols.barStart,
        repeatSymbol(symbols.barHorizontal, pad + 1),
      ]),
    );
  }

  writeLine(promptLine(symbols.bar));
  for (const line of contentLines) {
    writeLine(promptLine(symbols.bar, line));
  }
  writeLine(promptLine(symbols.bar));
  writeLine(
    terminalLine([
      "  ",
      symbols.barEnd,
      repeatSymbol(symbols.barHorizontal, pad + 1),
    ]),
  );
}

type InteractivePromptOptions<T> = {
  render: () => TerminalLine[];
  done: (value: T) => TerminalLine;
  onKey: (event: KeyInput) => { submit?: boolean; value?: T };
};

async function interactivePrompt<T>(
  options: InteractivePromptOptions<T>,
): Promise<PromptResult<T>> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const surface = new InlineSurface(stdout);
  const decoder = new InputDecoder();

  return TerminalSession.run(
    { stdin, stdout, rawMode: true, cursor: "hide" },
    () =>
      new Promise<PromptResult<T>>((resolve) => {
        const cleanup = (): void => {
          stdin.removeListener("data", onData);
        };

        function submit(value: T): void {
          surface.commit([renderLine(options.done(value))]);
          cleanup();
          resolve({ type: "submitted", value });
        }

        function cancel(): void {
          surface.clear();
          cleanup();
          resolve({ type: "cancelled" });
        }

        function onData(data: Buffer): void {
          for (const event of decoder.push(data)) {
            if (event.type === "cancel") {
              cancel();
              return;
            }

            const result = options.onKey(event);
            if (result.submit && result.value !== undefined) {
              submit(result.value);
              return;
            }
          }
          surface.render(options.render().map(renderLine));
        }

        stdin.on("data", onData);
        surface.render(options.render().map(renderLine));
      }),
  );
}

function toggle(set: Set<number>, value: number): void {
  if (set.has(value)) set.delete(value);
  else set.add(value);
}

function contentWidth(): number {
  return Math.max(10, (process.stdout.columns ?? 80) - 8);
}

function promptLine(symbol: TerminalSpanInput, text = ""): TerminalLine {
  return text
    ? terminalLine(["  ", symbol, "  ", text])
    : terminalLine(["  ", symbol]);
}

function prefixedLine(
  symbol: TerminalSpanInput,
  spans: readonly TerminalSpanInput[],
): TerminalLine {
  return terminalLine(["  ", symbol, "  ", ...spans]);
}

function doneLine(
  symbol: TerminalSpanInput,
  message: string,
  value: string,
): TerminalLine {
  return terminalLine([
    "  ",
    symbol,
    "  ",
    message,
    " ",
    terminalSpan("·", { role: "muted" }),
    " ",
    value,
  ]);
}

function choiceText<T>(
  item: Choice<T>,
  selected: boolean,
): TerminalSpanInput[] {
  const hint = item.hint ? ` ${item.hint}` : "";
  const rendered = truncate(`${item.label}${hint}`, contentWidth());
  const labelLength = Math.min(item.label.length, rendered.length);
  const label = rendered.slice(0, labelLength);
  const remaining = rendered.slice(labelLength);
  const labelSpan = selected
    ? terminalSpan(label)
    : terminalSpan(label, { role: "muted" });
  return remaining
    ? [labelSpan, terminalSpan(remaining, { role: "muted" })]
    : [labelSpan];
}

function repeatSymbol(
  symbol: TerminalSpanInput,
  count: number,
): TerminalSpanInput {
  if (typeof symbol === "string") return symbol.repeat(count);
  return terminalSpan(symbol.text.repeat(count), {
    ...(symbol.role ? { role: symbol.role } : {}),
    ...(symbol.background ? { background: symbol.background } : {}),
    ...(symbol.emphasis ? { emphasis: symbol.emphasis } : {}),
    ...(symbol.literal ? { literal: symbol.literal } : {}),
  });
}

function renderLine(line: TerminalLine): string {
  return renderTerminalLineAnsi(line);
}

function writeLine(line: TerminalLine): void {
  process.stdout.write(`${renderLine(line)}\n`);
}
