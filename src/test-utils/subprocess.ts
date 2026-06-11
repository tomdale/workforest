import { type SpawnOptionsWithoutStdio, spawn } from "node:child_process";

export type SubprocessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export async function runSubprocess(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptionsWithoutStdio = {},
): Promise<SubprocessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}
