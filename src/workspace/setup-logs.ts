import { once } from "node:events";
import { createWriteStream, promises as fs, type WriteStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { ensureWorkspaceMetadataDir } from "./metadata.ts";
import type { RepoPipelineState } from "./pipeline.ts";

export const DEFAULT_REPO_SETUP_LOG_EXCERPT_CHARS = 1200;

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

class RepoSetupLogWriter {
  #stream: WriteStream;

  constructor(logPath: string) {
    this.#stream = createWriteStream(logPath, {
      flags: "a",
      encoding: "utf8",
    });
  }

  async write(contents: string): Promise<void> {
    if (contents.length === 0) {
      return;
    }

    if (!this.#stream.write(contents, "utf8")) {
      await once(this.#stream, "drain");
    }
  }

  async close(): Promise<void> {
    if (this.#stream.closed) {
      return;
    }

    const finished = once(this.#stream, "finish");
    this.#stream.end();
    await finished;
  }
}

export async function removeRepoSetupLog(logPath: string): Promise<void> {
  await fs.rm(logPath, { force: true });
}

export async function readRepoSetupLogExcerpt({
  workspaceDir,
  repoName,
  maxChars = DEFAULT_REPO_SETUP_LOG_EXCERPT_CHARS,
}: Pick<RepoSetupLogOptions, "workspaceDir" | "repoName"> & {
  maxChars?: number;
}): Promise<string | null> {
  const logPath = await getRepoSetupLogPath({ workspaceDir, repoName });

  let handle: FileHandle | undefined;
  try {
    const stat = await fs.stat(logPath);
    const bytesToRead = Math.min(stat.size, maxChars);
    const buffer = Buffer.alloc(bytesToRead);
    handle = await fs.open(logPath, "r");

    await handle.read(buffer, 0, bytesToRead, stat.size - bytesToRead);

    const excerpt = buffer.toString("utf8").trim();
    if (!excerpt) {
      return null;
    }

    if (stat.size > bytesToRead) {
      return `[log truncated to last ${maxChars} characters]\n${excerpt}`;
    }

    return excerpt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  } finally {
    await handle?.close();
  }
}

export async function* withRepoSetupLog(
  pipeline: AsyncGenerator<RepoPipelineState>,
  options: RepoSetupLogOptions,
): AsyncGenerator<RepoPipelineState> {
  const logPath = await startRepoSetupLog(options);
  const logWriter = new RepoSetupLogWriter(logPath);
  let shouldKeepLog = false;

  try {
    for await (const state of pipeline) {
      await logWriter.write(formatState(state));

      if (state.phase === "failed") {
        shouldKeepLog = true;
      }

      yield state;
    }
  } catch (error) {
    shouldKeepLog = true;
    const setupError =
      error instanceof Error ? error : new Error(String(error));
    await logWriter.write(
      [`[thrown] ${setupError.message}`, setupError.stack ?? "", ""].join("\n"),
    );
    yield { phase: "failed", error: setupError, step: "repo pipeline" };
  } finally {
    await logWriter.close();
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
        `[failed${state.step ? `:${state.step}` : ""}] ${state.error.message}`,
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
