import chalk from "chalk";
import { InlineSurface } from "./inline-surface.ts";
import { InputDecoder, type KeyInput } from "./input-decoder.ts";
import type { PromptResult } from "./result.ts";
import { TerminalSession } from "./session.ts";
import { truncate, visibleWidth } from "./text.ts";

export type LineEditorOptions = {
  message: string;
  defaultValue?: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  prefix: {
    active: string;
    done: string;
    bar: string;
    barEnd: string;
    cancel: string;
  };
};

export async function lineEditor({
  message,
  defaultValue,
  placeholder,
  validate,
  stdin = process.stdin,
  stdout = process.stdout,
  prefix,
}: LineEditorOptions): Promise<PromptResult<string>> {
  const decoder = new InputDecoder();
  const surface = new InlineSurface(stdout);
  const chars = Array.from(defaultValue ?? "");
  let cursor = chars.length;
  let errorMessage = "";

  const render = (): void => {
    const value = chars.join("");
    const display = value || chalk.dim(placeholder ?? "");
    const cursorDisplay = renderCursor(display, cursor, value.length === 0);
    const lines = [`  ${prefix.active}  ${message}`];

    if (errorMessage) {
      lines.push(`  ${prefix.bar}  ${chalk.yellow(errorMessage)}`);
    }
    lines.push(`  ${prefix.bar}  ${cursorDisplay}`);
    lines.push(`  ${prefix.barEnd}`);
    surface.render(lines);
  };

  return TerminalSession.run(
    { stdin, stdout, rawMode: true, cursor: "show" },
    () =>
      new Promise<PromptResult<string>>((resolve) => {
        const cleanup = (): void => {
          stdin.removeListener("data", onData);
        };

        const submit = (): void => {
          const value = chars.join("") || defaultValue || "";
          const error = validate?.(value);
          if (error) {
            errorMessage = error;
            render();
            return;
          }

          surface.commit([
            `  ${prefix.done}  ${message} ${chalk.dim("·")} ${value || chalk.dim(defaultValue ?? "")}`,
          ]);
          cleanup();
          resolve({ type: "submitted", value });
        };

        const cancel = (): void => {
          surface.clear();
          cleanup();
          resolve({ type: "cancelled" });
        };

        const applyEvent = (event: KeyInput): boolean => {
          errorMessage = "";
          switch (event.type) {
            case "cancel":
              cancel();
              return false;
            case "submit":
              submit();
              return false;
            case "backspace":
              if (cursor > 0) {
                chars.splice(cursor - 1, 1);
                cursor--;
              }
              return true;
            case "delete":
              if (cursor < chars.length) {
                chars.splice(cursor, 1);
              }
              return true;
            case "arrow":
              if (event.direction === "left") cursor = Math.max(0, cursor - 1);
              if (event.direction === "right") {
                cursor = Math.min(chars.length, cursor + 1);
              }
              return true;
            case "home":
              cursor = 0;
              return true;
            case "end":
              cursor = chars.length;
              return true;
            case "text":
              for (const char of Array.from(event.value)) {
                chars.splice(cursor, 0, char);
                cursor++;
              }
              return true;
            case "space":
              chars.splice(cursor, 0, " ");
              cursor++;
              return true;
            default:
              return false;
          }
        };

        function onData(data: Buffer): void {
          for (const event of decoder.push(data)) {
            if (!applyEvent(event)) return;
          }
          render();
        }

        stdin.on("data", onData);
        render();
      }),
  );
}

function renderCursor(
  displayValue: string,
  cursorIndex: number,
  isPlaceholder: boolean,
): string {
  if (isPlaceholder) return `${chalk.inverse(" ")}${displayValue}`;

  const chars = Array.from(displayValue);
  const before = chars.slice(0, cursorIndex).join("");
  const current = chars[cursorIndex] ?? " ";
  const after = chars.slice(cursorIndex + 1).join("");
  const maxWidth = Math.max((process.stdout.columns ?? 80) - 8, 20);
  const line = `${before}${chalk.inverse(current)}${after}`;

  return visibleWidth(line) > maxWidth ? truncate(line, maxWidth) : line;
}
