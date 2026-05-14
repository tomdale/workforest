import chalk from "chalk";
import { FrameRenderer } from "./renderer.ts";
import {
  barColor,
  S_BAR,
  S_BAR_END,
  S_RADIO_OFF,
  S_RADIO_ON,
  S_STEP_ACTIVE,
  S_STEP_CANCEL,
  S_STEP_DONE,
} from "./symbols.ts";
import { CancelError, type PromptBaseOptions } from "./types.ts";

export type FuzzySelectOption<T> = {
  value: T;
  label: string;
  hint?: string;
};

export type FuzzySelectOptions<T> = PromptBaseOptions & {
  options: FuzzySelectOption<T>[];
};

export function filterFuzzySelectOptions<T>(
  options: FuzzySelectOption<T>[],
  query: string,
): FuzzySelectOption<T>[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return options;
  }

  return options.filter((option) => {
    const searchable =
      `${option.label} ${option.hint ?? ""}`.toLocaleLowerCase();
    return searchable.includes(normalizedQuery);
  });
}

export async function fuzzySelect<T>(
  message: string,
  options: FuzzySelectOptions<T>,
): Promise<T> {
  const { options: items, throwOnCancel } = options;
  if (items.length === 0) {
    throw new Error("fuzzySelect requires at least one option.");
  }

  return new Promise((resolve, reject) => {
    const renderer = new FrameRenderer();
    let query = "";
    let selectedIndex = 0;

    function filteredItems(): FuzzySelectOption<T>[] {
      return filterFuzzySelectOptions(items, query);
    }

    function renderFrame(): void {
      const filtered = filteredItems();
      if (selectedIndex >= filtered.length) {
        selectedIndex = Math.max(0, filtered.length - 1);
      }

      const lines: string[] = [];
      lines.push(`  ${S_STEP_ACTIVE}  ${message}`);
      lines.push(
        `  ${barColor(S_BAR)}  ${query || chalk.dim("Type to filter")}`,
      );

      if (filtered.length === 0) {
        lines.push(`  ${barColor(S_BAR)}  ${chalk.dim("No matches")}`);
      } else {
        for (const [i, item] of filtered.entries()) {
          const isSelected = i === selectedIndex;
          const radio = isSelected ? S_RADIO_ON : S_RADIO_OFF;
          const label = isSelected ? item.label : chalk.dim(item.label);
          const hint = item.hint ? chalk.dim(` ${item.hint}`) : "";
          lines.push(`  ${barColor(S_BAR)}  ${radio} ${label}${hint}`);
        }
      }

      lines.push(`  ${barColor(S_BAR_END)}`);
      renderer.render(lines);
    }

    function commitDone(selected: FuzzySelectOption<T>): void {
      renderer.commit([
        `  ${S_STEP_DONE}  ${message} ${chalk.dim("·")} ${selected.label}`,
      ]);
    }

    function handleCancel(): void {
      renderer.clear();
      if (throwOnCancel) {
        cleanup();
        reject(new CancelError());
      } else {
        process.stdout.write(`  ${S_STEP_CANCEL}  ${chalk.red("Cancelled")}\n`);
        cleanup();
        process.exit(0);
      }
    }

    function submit(): void {
      const selected = filteredItems()[selectedIndex];
      if (!selected) {
        return;
      }

      commitDone(selected);
      cleanup();
      resolve(selected.value);
    }

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write("\x1B[?25l");

    renderFrame();

    let pendingEscape = "";

    function onData(data: Buffer): void {
      const input = pendingEscape + data.toString();
      pendingEscape = "";
      let i = 0;
      let changed = false;

      while (i < input.length) {
        const ch = input[i];
        if (ch === undefined) break;

        if (ch === "\x03") {
          handleCancel();
          return;
        }

        if (ch === "\r" || ch === "\n") {
          submit();
          return;
        }

        if (ch === "\x7F" || ch === "\b") {
          if (query.length > 0) {
            query = query.slice(0, -1);
            selectedIndex = 0;
            changed = true;
          }
          i++;
          continue;
        }

        if (ch === "\x1B") {
          const rest = input.slice(i);

          if (rest === "\x1B") {
            handleCancel();
            return;
          }

          if (input.length - i < 3) {
            pendingEscape = input.slice(i);
            break;
          }

          if (rest.startsWith("\x1B[A")) {
            const filtered = filteredItems();
            if (filtered.length > 0) {
              selectedIndex =
                (selectedIndex - 1 + filtered.length) % filtered.length;
              changed = true;
            }
            i += 3;
            continue;
          }
          if (rest.startsWith("\x1B[B")) {
            const filtered = filteredItems();
            if (filtered.length > 0) {
              selectedIndex = (selectedIndex + 1) % filtered.length;
              changed = true;
            }
            i += 3;
            continue;
          }
          if (rest.startsWith("\x1B[H")) {
            selectedIndex = 0;
            changed = true;
            i += 3;
            continue;
          }
          if (rest.startsWith("\x1B[F")) {
            selectedIndex = Math.max(0, filteredItems().length - 1);
            changed = true;
            i += 3;
            continue;
          }

          i++;
          while (i < input.length) {
            const escapeByte = input[i];
            if (
              escapeByte === undefined ||
              escapeByte < " " ||
              escapeByte > "/"
            ) {
              break;
            }
            i++;
          }
          if (i < input.length) i++;
          continue;
        }

        if (ch >= " ") {
          query += ch;
          selectedIndex = 0;
          changed = true;
        }

        i++;
      }

      if (changed) {
        renderFrame();
      }
    }

    function cleanup(): void {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      process.stdout.write("\x1B[?25h");
    }

    stdin.on("data", onData);
  });
}
