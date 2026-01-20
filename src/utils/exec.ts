import { spawn } from "node:child_process";
import { log } from "../logger.ts";
import type { RunCommandOptions } from "../types.ts";

/**
 * Runs a command and captures its output.
 * Always pipes stdout/stderr and returns the captured output.
 * Optionally streams output via callbacks for real-time display.
 */
export function runCommand(
  command: string,
  args: string[],
  { cwd, onStdout, onStderr }: RunCommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      onStdout?.(chunk);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      onStderr?.(chunk);
    });

    child.on("error", (error_: Error) => reject(error_));
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with code ${code}. ${stderr}`,
          ),
        );
      }
    });
  });
}

/**
 * Runs a command with real-time output to the console.
 * Logs the command being executed and streams stdout/stderr.
 */
export function runCommandVerbose(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  log.info(`$ ${command} ${args.join(" ")}`);
  return runCommand(command, args, {
    ...options,
    onStdout: (chunk) => process.stdout.write(chunk),
    onStderr: (chunk) => process.stderr.write(chunk),
  });
}
