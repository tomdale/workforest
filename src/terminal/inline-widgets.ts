import chalk from "chalk";
import { InlineSurface } from "./inline-surface.ts";
import { InputDecoder, type KeyInput } from "./input-decoder.ts";
import { lineEditor } from "./line-editor.ts";
import type { PromptResult } from "./result.ts";
import { TerminalSession } from "./session.ts";
import { truncate, visibleWidth, wrap } from "./text.ts";

export type TerminalSymbols = {
  active: string;
  done: string;
  cancel: string;
  bar: string;
  barEnd: string;
  barStart: string;
  barHorizontal: string;
  radioOn: string;
  radioOff: string;
  checkOn: string;
  checkOff: string;
  info: string;
  warning: string;
  error: string;
  success: string;
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
      const yes = value ? chalk.underline("Yes") : chalk.dim("Yes");
      const no = value ? chalk.dim("No") : chalk.underline("No");
      return [
        `  ${symbols.active}  ${message}`,
        `  ${symbols.bar}  ${yes} / ${no}`,
        `  ${symbols.barEnd}`,
      ];
    },
    done: () =>
      `  ${symbols.done}  ${message} ${chalk.dim("·")} ${value ? "Yes" : "No"}`,
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
      const lines = [`  ${symbols.active}  ${message}`];
      for (const [i, item] of items.entries()) {
        const selected = i === index;
        const label = selected ? item.label : chalk.dim(item.label);
        const hint = item.hint ? chalk.dim(` ${item.hint}`) : "";
        lines.push(
          `  ${symbols.bar}  ${selected ? symbols.radioOn : symbols.radioOff} ${truncate(`${label}${hint}`, contentWidth())}`,
        );
      }
      if (hotkeys?.length) {
        lines.push(`  ${symbols.bar}`);
        for (const hotkey of hotkeys) {
          lines.push(
            `  ${symbols.bar}  ${chalk.dim(`${hotkey.key} to ${hotkey.hint}`)}`,
          );
        }
      }
      lines.push(`  ${symbols.barEnd}`);
      return lines;
    },
    done: (value) => {
      const selected = items.find((item) => Object.is(item.value, value));
      return `  ${symbols.done}  ${message} ${chalk.dim("·")} ${selected?.label ?? ""}`;
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
      const lines = [`  ${options.symbols.active}  ${message}`];
      for (const [i, item] of items.entries()) {
        const selected = i === index;
        const label = selected ? item.label : chalk.dim(item.label);
        const hint = item.hint ? chalk.dim(` ${item.hint}`) : "";
        lines.push(
          `  ${options.symbols.bar}  ${checked.has(i) ? options.symbols.checkOn : options.symbols.checkOff} ${truncate(`${label}${hint}`, contentWidth())}`,
        );
      }
      lines.push(`  ${options.symbols.barEnd}`);
      return lines;
    },
    done: () => {
      const selected = items
        .filter((_, i) => checked.has(i))
        .map((item) => item.label);
      return `  ${options.symbols.done}  ${message} ${chalk.dim("·")} ${selected.length > 0 ? selected.join(", ") : "none"}`;
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
        `  ${symbols.active}  ${message}`,
        `  ${symbols.bar}  ${query || chalk.dim("Type to filter")}`,
      ];

      if (choices.length === 0) {
        lines.push(`  ${symbols.bar}  ${chalk.dim("No matches")}`);
      } else {
        for (const [i, item] of choices.entries()) {
          const selected = i === index;
          const label = selected ? item.label : chalk.dim(item.label);
          const hint = item.hint ? chalk.dim(` ${item.hint}`) : "";
          lines.push(
            `  ${symbols.bar}  ${selected ? symbols.radioOn : symbols.radioOff} ${truncate(`${label}${hint}`, contentWidth())}`,
          );
        }
      }

      lines.push(`  ${symbols.barEnd}`);
      return lines;
    },
    done: (value) => {
      const selected = items.find((item) => Object.is(item.value, value));
      return `  ${symbols.done}  ${message} ${chalk.dim("·")} ${selected?.label ?? ""}`;
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
  process.stdout.write(`  ${symbols.barStart}  ${title}\n`);
}

export function outro(message: string, symbols: TerminalSymbols): void {
  process.stdout.write(`  ${symbols.barEnd}  ${message}\n`);
}

export function cancel(message: string, symbols: TerminalSymbols): void {
  process.stdout.write(`  ${symbols.cancel}  ${chalk.red(message)}\n`);
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
    process.stdout.write(
      `  ${symbols.barStart}  ${title} ${symbols.barHorizontal.repeat(ruleWidth)}\n`,
    );
  } else {
    process.stdout.write(
      `  ${symbols.barStart}${symbols.barHorizontal.repeat(pad + 1)}\n`,
    );
  }

  process.stdout.write(`  ${symbols.bar}\n`);
  for (const line of contentLines) {
    process.stdout.write(`  ${symbols.bar}  ${line}\n`);
  }
  process.stdout.write(`  ${symbols.bar}\n`);
  process.stdout.write(
    `  ${symbols.barEnd}${symbols.barHorizontal.repeat(pad + 1)}\n`,
  );
}

type InteractivePromptOptions<T> = {
  render: () => string[];
  done: (value: T) => string;
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
          surface.commit([options.done(value)]);
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
          surface.render(options.render());
        }

        stdin.on("data", onData);
        surface.render(options.render());
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
