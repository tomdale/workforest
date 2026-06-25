import { spawn } from "node:child_process";
import { TailBuffer } from "@wf-plugin/core";

export type CliRunOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
};

export type CliRunResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

const STDERR_TAIL_CHARS = 4096;

export async function commandAvailable(
  command: string,
  args: string[],
  options: Pick<CliRunOptions, "cwd" | "env">,
): Promise<boolean> {
  try {
    const result = await runCli(command, args, {
      ...options,
      timeoutMs: 5000,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

export function runCli(
  command: string,
  args: string[],
  options: CliRunOptions,
): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr = new TailBuffer(STDERR_TAIL_CHARS);
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr.append(chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `${command} timed out after ${options.timeoutMs}ms. Increase WORKFOREST_AI_TIMEOUT_MS if this is expected.`,
          ),
        );
        return;
      }
      resolve({ stdout: stdout.join(""), stderr: stderr.toString(), code });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

export function formatCliFailure(
  command: string,
  result: CliRunResult,
  setupHint: string,
): Error {
  const stderr = result.stderr.trim();
  const detail = stderr ? ` ${stderr}` : "";
  return new Error(
    `${command} exited with code ${result.code}.${detail} ${setupHint}`,
  );
}
