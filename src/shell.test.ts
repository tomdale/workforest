import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commandRegistry } from "./cli/commands.ts";
import type { CommandRegistry } from "./cli/types.ts";
import {
  normalizeShellName,
  renderShellInit,
  reportShellCdTarget,
  WORKFOREST_CD_PATH_ENV,
  writeShellCdPath,
} from "./shell.ts";

const ORIGINAL_CD_PATH_FILE = process.env[WORKFOREST_CD_PATH_ENV];
const tempDirs: string[] = [];

afterEach(async () => {
  if (ORIGINAL_CD_PATH_FILE === undefined) {
    delete process.env[WORKFOREST_CD_PATH_ENV];
  } else {
    process.env[WORKFOREST_CD_PATH_ENV] = ORIGINAL_CD_PATH_FILE;
  }

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workforest-shell-"));
  tempDirs.push(dir);
  return dir;
}

describe("shell integration", () => {
  it("normalizes supported shells", () => {
    expect(normalizeShellName("/bin/zsh")).toBe("zsh");
    expect(normalizeShellName("bash")).toBe("bash");
    expect(normalizeShellName("/opt/homebrew/bin/fish")).toBeNull();
  });

  it("renders shell init with auto-cd wrappers and zsh completion registration", () => {
    const script = renderShellInit("zsh");

    expect(script).toContain("__workforest_invoke()");
    expect(script).toContain("WORKFOREST_CD_PATH_FILE");
    expect(script).toContain("wf() {");
    expect(script).toContain("workforest() {");
    expect(script).toContain("_workforest_complete()");
    expect(script).toContain("compdef _workforest_complete wf workforest");
  });

  it("renders generated bash completion for both executable names", () => {
    const script = renderShellInit("bash");

    expect(script).toContain("_workforest_complete()");
    expect(script).toContain("complete -F _workforest_complete wf workforest");
  });

  it("derives completion commands from the registry", () => {
    const registry = structuredClone(commandRegistry) as MutableCommandRegistry;
    registry.shortcuts.push({
      name: "inspect",
      target: ["cache", "show"],
      visibility: "visible",
      summary: "Inspect a cached repository",
      help: { kind: "command", command: "inspect" },
    });
    registry.shortcuts.push({
      name: "visit",
      target: ["review"],
      visibility: "visible",
      summary: "Visit a review workspace",
      help: { kind: "command", command: "visit" },
    });

    const script = renderShellInit("bash", registry);

    expect(script).toContain("inspect");
    expect(script).toContain("visit");
  });

  it.each(["bash", "zsh"] as const)("renders valid %s syntax", (shell) => {
    const result = spawnSync(shell, ["-n"], {
      input: renderShellInit(shell),
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it("registers and executes bash completion", () => {
    const result = spawnSync("bash", [], {
      input: `${renderShellInit("bash")}
complete -p wf
complete -p workforest
COMP_WORDS=(wf s)
COMP_CWORD=1
_workforest_complete
printf '%s\\n' "\${COMPREPLY[@]}"
`,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("complete -F _workforest_complete wf");
    expect(result.stdout).toContain(
      "complete -F _workforest_complete workforest",
    );
    expect(result.stdout).toContain("status\n");
    expect(result.stdout).toContain("switch\n");
  });

  it("cd's the parent shell for bare wf when a target is reported", async () => {
    const tempDir = await createTempDir();
    const binDir = path.join(tempDir, "bin");
    const target = path.join(tempDir, "target");
    await mkdir(binDir, { recursive: true });
    await mkdir(target, { recursive: true });

    // Stand in for the real CLI: when the wrapper runs us under the cd-path
    // env var, report the change directory so the wrapper can follow it. Bare
    // `wf` must reach this path even though it has no subcommand to allowlist.
    const stub = path.join(binDir, "wf");
    await writeFile(
      stub,
      `#!/bin/sh
if [ -n "$${WORKFOREST_CD_PATH_ENV}" ]; then
  printf '%s\\n' "$WF_STUB_TARGET" > "$${WORKFOREST_CD_PATH_ENV}"
fi
`,
      "utf8",
    );
    await chmod(stub, 0o755);

    const result = spawnSync("bash", [], {
      input: `${renderShellInit("bash")}
wf
pwd -P
`,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
        WF_STUB_TARGET: target,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(await realpath(target));
  });

  it("cd's the parent shell on failure when a target is reported", async () => {
    const tempDir = await createTempDir();
    const binDir = path.join(tempDir, "bin");
    const target = path.join(tempDir, "target");
    await mkdir(binDir, { recursive: true });
    await mkdir(target, { recursive: true });

    const stub = path.join(binDir, "wf");
    await writeFile(
      stub,
      `#!/bin/sh
if [ -n "$${WORKFOREST_CD_PATH_ENV}" ]; then
  printf '%s\\n' "$WF_STUB_TARGET" > "$${WORKFOREST_CD_PATH_ENV}"
fi
exit 1
`,
      "utf8",
    );
    await chmod(stub, 0o755);

    const result = spawnSync("bash", [], {
      input: `${renderShellInit("bash")}
wf
workforest_status=$?
printf 'status=%s\\ncwd=%s\\n' "$workforest_status" "$PWD"
exit "$workforest_status"
`,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
        WF_STUB_TARGET: target,
      },
    });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("status=1\n");
    expect(await realpath(parseValue(result.stdout, "cwd") ?? "")).toBe(
      await realpath(target),
    );
  });

  it("writes the target workspace path for the shell wrapper", async () => {
    const tempDir = await createTempDir();
    const cdPathFile = path.join(tempDir, "cd-target");
    process.env[WORKFOREST_CD_PATH_ENV] = cdPathFile;

    await writeShellCdPath("./examples/demo");

    const written = await readFile(cdPathFile, "utf8");
    expect(written).toBe(`${path.resolve("./examples/demo")}\n`);
  });

  it("reports auto-cd targets through shell integration", async () => {
    const tempDir = await createTempDir();
    const cdPathFile = path.join(tempDir, "cd-target");
    process.env[WORKFOREST_CD_PATH_ENV] = cdPathFile;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await reportShellCdTarget("./examples/demo");

    const written = await readFile(cdPathFile, "utf8");
    expect(written).toBe(`${path.resolve("./examples/demo")}\n`);
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("prints a fallback cd target when auto-cd is unavailable", async () => {
    delete process.env[WORKFOREST_CD_PATH_ENV];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await reportShellCdTarget("/tmp/workforest-demo");

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Run: cd /tmp/workforest-demo"),
    );
    logSpy.mockRestore();
  });

  it("compacts home paths in fallback cd target output", async () => {
    delete process.env[WORKFOREST_CD_PATH_ENV];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const target = path.join(os.homedir(), "Code", "workforest-demo");

    await reportShellCdTarget(target);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `Run: cd ${path.join("~", "Code", "workforest-demo")}`,
      ),
    );
    logSpy.mockRestore();
  });

  it("prints manual cd targets without writing shell integration files", async () => {
    const tempDir = await createTempDir();
    const cdPathFile = path.join(tempDir, "cd-target");
    process.env[WORKFOREST_CD_PATH_ENV] = cdPathFile;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await reportShellCdTarget("/tmp/workforest-demo", { mode: "manual" });

    await expect(readFile(cdPathFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Run: cd /tmp/workforest-demo"),
    );
    logSpy.mockRestore();
  });
});

type MutableCommandRegistry = Mutable<CommandRegistry>;

function parseValue(output: string, key: string): string | undefined {
  return output
    .split("\n")
    .find((line) => line.startsWith(`${key}=`))
    ?.slice(key.length + 1);
}

type Mutable<Value> = Value extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : Value extends object
    ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
    : Value;
