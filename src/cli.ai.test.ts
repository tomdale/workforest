import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it } from "vitest";
import { renderCommandResult } from "./cli/output.ts";
import { executeCli } from "./cli.ts";

const ORIGINAL_CONFIG_DIR = process.env["WORKFOREST_CONFIG_DIR"];
const ORIGINAL_PATH = process.env["PATH"];
const ORIGINAL_SHELL = process.env["SHELL"];

const tempDirs: string[] = [];

afterEach(async () => {
  restoreEnv("WORKFOREST_CONFIG_DIR", ORIGINAL_CONFIG_DIR);
  restoreEnv("PATH", ORIGINAL_PATH);
  restoreEnv("SHELL", ORIGINAL_SHELL);

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("wf ai status", () => {
  it("renders human status output", async () => {
    await useFakeCodex();

    const output = render(await executeCli(["ai", "status"]));

    expect(stripAnsi(output.stdout)).toContain("AI providers");
    expect(stripAnsi(output.stdout)).toContain("Selected: codex-cli");
    expect(stripAnsi(output.stdout)).toContain("Codex CLI (codex-cli)");
  });

  it("renders JSON status output", async () => {
    await useFakeCodex();

    const output = render(await executeCli(["ai", "status", "--json"]));
    const parsed = JSON.parse(output.stdout) as {
      ok: boolean;
      data: { selectedProvider: string | null };
    };

    expect(parsed).toEqual({
      ok: true,
      data: expect.objectContaining({
        selectedProvider: "codex-cli",
      }),
    });
  });
});

async function useFakeCodex(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "workforest-ai-cli-"));
  tempDirs.push(root);
  const binDir = path.join(root, "bin");
  const configDir = path.join(root, "config");
  await mkdir(binDir);
  await mkdir(configDir);
  await writeFile(
    path.join(binDir, "codex"),
    "#!/bin/sh\nprintf 'codex 1.0.0\\n'\n",
    "utf8",
  );
  await chmod(path.join(binDir, "codex"), 0o755);

  process.env["WORKFOREST_CONFIG_DIR"] = configDir;
  process.env["PATH"] = binDir;
  process.env["SHELL"] = "";
}

function render(result: Awaited<ReturnType<typeof executeCli>>): {
  stdout: string;
  stderr: string;
} {
  const output = { stdout: "", stderr: "" };
  renderCommandResult(result, {
    stdout: (value) => {
      output.stdout += value;
    },
    stderr: (value) => {
      output.stderr += value;
    },
  });
  return output;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
