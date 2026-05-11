import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureWorkspaceMetadataDir } from "./metadata.ts";
import type { RepoPipelineState } from "./pipeline.ts";

export type RepoSetupLogOptions = {
  workspaceDir: string;
  repoName: string;
  repoDir: string;
};

export async function getRepoSetupLogPath({
  workspaceDir,
  repoName,
}: Pick<RepoSetupLogOptions, "workspaceDir" | "repoName">): Promise<string> {
  const metadataDir = await ensureWorkspaceMetadataDir(workspaceDir);
  return path.join(metadataDir, "logs", `${sanitizeLogName(repoName)}.log`);
}

export async function startRepoSetupLog(
  options: RepoSetupLogOptions,
): Promise<string> {
  const logPath = await getRepoSetupLogPath(options);
  const logDir = path.dirname(logPath);
  await fs.mkdir(logDir, { recursive: true });
  await fs.rm(logPath, { force: true });

  await appendRepoSetupLog(
    logPath,
    [
      `# workforest repo setup log`,
      `timestamp: ${new Date().toISOString()}`,
      `repo: ${options.repoName}`,
      `workspace: ${options.workspaceDir}`,
      `repoDir: ${options.repoDir}`,
      "",
    ].join("\n"),
  );

  return logPath;
}

export async function appendRepoSetupLog(
  logPath: string,
  contents: string,
): Promise<void> {
  if (contents.length === 0) {
    return;
  }

  await fs.appendFile(logPath, contents, "utf8");
}

export async function removeRepoSetupLog(logPath: string): Promise<void> {
  await fs.rm(logPath, { force: true });
}

export async function* withRepoSetupLog(
  pipeline: AsyncGenerator<RepoPipelineState>,
  options: RepoSetupLogOptions,
): AsyncGenerator<RepoPipelineState> {
  const logPath = await startRepoSetupLog(options);
  let shouldKeepLog = false;

  try {
    for await (const state of pipeline) {
      await appendRepoSetupLog(logPath, formatState(state));

      if (state.phase === "failed") {
        shouldKeepLog = true;
      }

      yield state;
    }
  } catch (error) {
    shouldKeepLog = true;
    const setupError =
      error instanceof Error ? error : new Error(String(error));
    await appendRepoSetupLog(
      logPath,
      [`[thrown] ${setupError.message}`, setupError.stack ?? "", ""].join("\n"),
    );
    throw error;
  } finally {
    if (!shouldKeepLog) {
      await removeRepoSetupLog(logPath);
    }
  }
}

function sanitizeLogName(repoName: string): string {
  return repoName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function formatState(state: RepoPipelineState): string {
  switch (state.phase) {
    case "git":
      return formatTaskLikeState(`git:${state.step}`, state);
    case "initializer":
      return formatTaskLikeState(`initializer:${state.name}`, state);
    case "complete":
      return `[complete] hasLockfile=${String(state.hasLockfile)}\n`;
    case "failed":
      return [
        `[failed] ${state.error.message}`,
        state.error.stack ? `${state.error.stack}\n` : "",
      ].join("\n");
  }
}

function formatTaskLikeState(
  scope: string,
  state: Extract<RepoPipelineState, { phase: "git" | "initializer" }>,
): string {
  switch (state.status) {
    case "output":
      return state.output ?? "";
    case "running":
      return state.message ? `[${scope}] ${state.message}\n` : "";
    case "retrying":
      return state.message ? `[${scope}] ${state.message}\n` : "";
    case "failed":
      return `[${scope}] failed\n`;
    case "completed":
      return `[${scope}] completed\n`;
    case "skipped":
      return state.message ? `[${scope}] skipped: ${state.message}\n` : "";
    case "pending":
      return `[${scope}] pending\n`;
    case "log":
      return state.message ? `[${scope}] log: ${state.message}\n` : "";
  }
}
