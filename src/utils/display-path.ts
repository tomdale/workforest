import os from "node:os";
import path from "node:path";

/**
 * Display-only shorthand: contract a $HOME prefix to `~` for human-readable
 * output. Never use the result as a filesystem path.
 */
export function compactHome(value: string): string {
  const home = os.homedir();
  return value === home
    ? "~"
    : value.startsWith(`${home}${path.sep}`)
      ? path.join("~", path.relative(home, value))
      : value;
}
