import { spawn } from "node:child_process";
import { log } from "../logger.ts";
import type { RunCommandOptions } from "../types.ts";

export function runCommand(
  command: string,
  args: string[],
  { cwd, capture = false }: RunCommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  log.info(`$ ${command} ${args.join(" ")}`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: capture
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "inherit", "inherit"],
    });

    let stdout = "";
    let stderr = "";

    if (capture) {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
    }

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

