import { promises as fs } from "node:fs";
import path from "node:path";
import semver from "semver";
import { runCommand } from "./exec.ts";

export interface NodeVersionPrefix {
  command: string;
  args: string[];
}

/**
 * Check if a command exists in PATH.
 */
async function commandExists(cmd: string): Promise<boolean> {
  try {
    await runCommand("command", ["-v", cmd]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read engines.node from package.json in the given directory.
 * Returns null if package.json doesn't exist or has no engines.node field.
 */
async function getRequiredNodeRange(dir: string): Promise<string | null> {
  try {
    const packageJsonPath = path.join(dir, "package.json");
    const content = await fs.readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(content) as {
      engines?: { node?: string };
    };
    return pkg.engines?.node ?? null;
  } catch {
    return null;
  }
}

/**
 * Detect which version manager is available.
 * Checks for fnm first, then asdf.
 * Returns the name of the first found manager, or null if none found.
 */
async function detectVersionManager(): Promise<"fnm" | "asdf" | null> {
  if (await commandExists("fnm")) {
    return "fnm";
  }
  if (await commandExists("asdf")) {
    return "asdf";
  }
  return null;
}

/**
 * Get the command prefix needed to run commands with the correct Node version.
 * Returns null if no prefix is needed (current version is sufficient or no version manager).
 *
 * @param dir - Directory containing package.json
 * @returns Command prefix to prepend, or null if not needed
 */
export async function getNodeVersionPrefix(
  dir: string,
): Promise<NodeVersionPrefix | null> {
  const requiredRange = await getRequiredNodeRange(dir);
  if (requiredRange === null) {
    return null;
  }

  if (semver.satisfies(process.version, requiredRange)) {
    return null;
  }

  const versionManager = await detectVersionManager();
  if (versionManager === null) {
    return null;
  }

  if (versionManager === "fnm") {
    return { command: "fnm", args: ["exec", "--"] };
  }

  if (versionManager === "asdf") {
    return { command: "asdf", args: ["exec"] };
  }

  return null;
}
