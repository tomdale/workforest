import { spawn } from "node:child_process";
import { log } from "../logger.ts";
import type { RunCommandOptions } from "../types.ts";
import { createSpawnEnv } from "./spawn-env.ts";

/**
 * Runs a command and captures its output.
 * Always pipes stdout/stderr and returns the captured output.
 * Optionally streams output via callbacks for real-time display.
 */
const FORCE_KILL_DELAY = 5_000;

export function runCommand(
  command: string,
  args: string[],
  { cwd, onStdout, onStderr, timeout }: RunCommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: createSpawnEnv(cwd),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeout) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_DELAY);
      }, timeout);
    }

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

    child.on("error", (error_: Error) => {
      if (timer) clearTimeout(timer);
      reject(error_);
    });
    child.on("close", (code: number | null) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `${command} ${args.join(" ")} timed out after ${timeout}ms`,
          ),
        );
      } else if (code === 0) {
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
 * Runs a command with stdin input.
 * Used for commands that accept input via stdin (e.g., git update-ref --stdin).
 */
export function runCommandWithStdin(
  command: string,
  args: string[],
  stdin: string,
  { cwd }: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: createSpawnEnv(cwd),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
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

    // Write stdin and close
    child.stdin.write(stdin);
    child.stdin.end();
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
