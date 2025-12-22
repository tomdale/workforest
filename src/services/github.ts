import { log } from "../logger.ts";
import type { RunCommandOptions } from "../types.ts";
import { runCommand } from "../utils/exec.ts";

type DiskUsageResult = {
  diskUsage?: number;
};

export async function fetchRepoDiskUsage(
  slug: string,
  options: RunCommandOptions = { capture: true },
): Promise<number | null> {
  try {
    const { stdout } = await runCommand(
      "gh",
      ["repo", "view", slug, "--json", "diskUsage"],
      { ...options, capture: true },
    );
    const parsed: DiskUsageResult = JSON.parse(stdout);
    if (typeof parsed.diskUsage === "number") {
      return parsed.diskUsage * 1024;
    }
  } catch (error_) {
    log.warn(
      `Unable to fetch disk usage for ${slug} via GitHub CLI. Skipping size warning.`,
    );
    log.warn(String(error_));
  }
  return null;
}
