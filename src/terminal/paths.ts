import os from "node:os";
import path from "node:path";

export function compactHomePath(value: string, homeDir = os.homedir()): string {
  const home = normalizedHome(homeDir);
  if (!home || !path.isAbsolute(value)) return value;

  const resolved = path.resolve(value);
  if (resolved === home) return "~";
  if (resolved.startsWith(`${home}${path.sep}`)) {
    return path.join("~", path.relative(home, resolved));
  }
  return value;
}

function normalizedHome(homeDir: string): string | null {
  if (!homeDir) return null;
  const resolved = path.resolve(homeDir);
  return resolved === path.parse(resolved).root ? null : resolved;
}
