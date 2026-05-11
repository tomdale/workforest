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

export type SelectOption<T> = {
  value: T;
  label: string;
  hint?: string;
};

export type SelectHotkey<T> = {
  key: string;
  value: T;
  hint: string;
};

export type SelectOptions<T> = PromptBaseOptions & {
  options: SelectOption<T>[];
  hotkeys?: SelectHotkey<T>[];
};

export async function select<T>(
  message: string,
  options: SelectOptions<T>,
): Promise<T> {
  const { options: items, hotkeys, throwOnCancel } = options;
  if (items.length === 0) {
    throw new Error("select requires at least one option.");
  }

  return new Promise((resolve, reject) => {
    const renderer = new FrameRenderer();
    let selectedIndex = 0;

    function renderFrame(): void {
      const lines: string[] = [];
      lines.push(`  ${S_STEP_ACTIVE}  ${message}`);

      for (const [i, item] of items.entries()) {
        const isSelected = i === selectedIndex;
        const radio = isSelected ? S_RADIO_ON : S_RADIO_OFF;
        const label = isSelected ? item.label : chalk.dim(item.label);
        const hint = item.hint ? chalk.dim(` ${item.hint}`) : "";
        lines.push(`  ${barColor(S_BAR)}  ${radio} ${label}${hint}`);
      }

      if (hotkeys && hotkeys.length > 0) {
        lines.push(`  ${barColor(S_BAR)}`);
        for (const hk of hotkeys) {
          lines.push(
            `  ${barColor(S_BAR)}  ${chalk.dim(`${hk.key} to ${hk.hint}`)}`,
          );
        }
      }

      lines.push(`  ${barColor(S_BAR_END)}`);
      renderer.render(lines);
    }

    function commitDone(): void {
      const selected = items[selectedIndex];
      if (!selected) return;
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

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write("\x1B[?25l"); // hide cursor

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
          commitDone();
          cleanup();
          const selected = items[selectedIndex];
          if (!selected) {
            reject(new Error("No option selected."));
            return;
          }
          resolve(selected.value);
          return;
        }

        if (ch === "\x1B") {
          if (input.length - i < 3) {
            pendingEscape = input.slice(i);
            break;
          }
          const seq = input.slice(i, i + 3);
          if (seq === "\x1B[A") {
            selectedIndex = (selectedIndex - 1 + items.length) % items.length;
            changed = true;
            i += 3;
            continue;
          }
          if (seq === "\x1B[B") {
            selectedIndex = (selectedIndex + 1) % items.length;
            changed = true;
            i += 3;
            continue;
          }
          if (seq === "\x1B[H") {
            selectedIndex = 0;
            changed = true;
            i += 3;
            continue;
          }
          if (seq === "\x1B[F") {
            selectedIndex = items.length - 1;
            changed = true;
            i += 3;
            continue;
          }
          // Skip unknown escape sequence
          i++;
          continue;
        }

        if (hotkeys) {
          const hotkey = hotkeys.find((hk) => hk.key === ch);
          if (hotkey) {
            renderer.commit([
              `  ${S_STEP_DONE}  ${message} ${chalk.dim("·")} ${hotkey.hint}`,
            ]);
            cleanup();
            resolve(hotkey.value);
            return;
          }
        }

        if (ch === "k") {
          selectedIndex = (selectedIndex - 1 + items.length) % items.length;
          changed = true;
        } else if (ch === "j") {
          selectedIndex = (selectedIndex + 1) % items.length;
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
      process.stdout.write("\x1B[?25h"); // show cursor
    }

    stdin.on("data", onData);
  });
}
