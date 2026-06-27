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
import { afterEach, describe, expect, it } from "vitest";
import { commandRegistry } from "./cli/commands.ts";
import type { CommandRegistry } from "./cli/types.ts";
import {
  normalizeShellName,
  renderShellInit,
  resolveCleanupCdTarget,
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
      target: ["review", "open"],
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

  it("resolves cleanup cd target only when current dir is inside the workspace", () => {
    expect(
      resolveCleanupCdTarget(
        "/tmp/workspaces/feature-name/api",
        "/tmp/workspaces/feature-name",
      ),
    ).toBe("/tmp/workspaces");

    expect(
      resolveCleanupCdTarget(
        "/tmp/workspaces/feature-name",
        "/tmp/workspaces/feature-name",
      ),
    ).toBe("/tmp/workspaces");

    expect(
      resolveCleanupCdTarget("/tmp/elsewhere", "/tmp/workspaces/feature-name"),
    ).toBeNull();
  });

  it("writes the target workspace path for the shell wrapper", async () => {
    const tempDir = await createTempDir();
    const cdPathFile = path.join(tempDir, "cd-target");
    process.env[WORKFOREST_CD_PATH_ENV] = cdPathFile;

    await writeShellCdPath("./examples/demo");

    const written = await readFile(cdPathFile, "utf8");
    expect(written).toBe(`${path.resolve("./examples/demo")}\n`);
  });
});

type MutableCommandRegistry = Mutable<CommandRegistry>;

type Mutable<Value> = Value extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : Value extends object
    ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
    : Value;
