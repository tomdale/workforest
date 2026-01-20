import { runCommand } from "../utils/exec.ts";

type DiskUsageResult = {
  diskUsage?: number;
};

type LogMessage = { level: "warn"; message: string };

type FetchRepoDiskUsageResult = {
  sizeBytes: number | null;
  messages: LogMessage[];
};

export async function fetchRepoDiskUsage(
  slug: string,
): Promise<FetchRepoDiskUsageResult> {
  const messages: LogMessage[] = [];

  try {
    const { stdout } = await runCommand("gh", [
      "repo",
      "view",
      slug,
      "--json",
      "diskUsage",
    ]);
    const parsed: DiskUsageResult = JSON.parse(stdout);
    if (typeof parsed.diskUsage === "number") {
      return { sizeBytes: parsed.diskUsage * 1024, messages };
    }
  } catch (error_) {
    messages.push({
      level: "warn",
      message: `Unable to fetch disk usage for ${slug} via GitHub CLI. Skipping size warning.`,
    });
    messages.push({
      level: "warn",
      message: String(error_),
    });
  }
  return { sizeBytes: null, messages };
}
