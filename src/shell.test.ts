import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

  it("renders shell init with auto-cd wrappers", () => {
    const script = renderShellInit("zsh");

    expect(script).toContain("__workforest_invoke()");
    expect(script).toContain('case "$1" in');
    expect(script).toContain(
      "start|add|switch|finish|delete|task|review|template",
    );
    expect(script).toContain("WORKFOREST_CD_PATH_FILE");
    expect(script).toContain("wf() {");
    expect(script).toContain("workforest() {");
    expect(script).toContain("_workforest_complete()");
    expect(script).toContain("(( $+functions[compdef] )) || return 0");
    expect(script).toContain("compdef _workforest_complete wf workforest");
    expect(script).toContain('local root_command="$' + '{words[2]:-}"');
    expect(script).toContain('local subcommand="$' + '{words[3]:-}"');
    expect(script).toContain("'start:Start a change'");
    expect(script).toContain("'task:Manage temporary task worktrees'");
    expect(script).toContain("'start:Start nested task lanes'");
    expect(script).toContain("'--json:option'");
    expect(script).toContain(
      "_workforest_complete_flags '--repo' '-n' '--dry-run' '-f' '--force' '--json'",
    );
    expect(script).toContain(
      "'review:Manage review workspaces and PR worktrees'",
    );
    expect(script).toContain("'checkout:Check out a pull request worktree'");
    expect(script).toContain("'add-file:Add files to a template'");
    expect(script).not.toContain("'fork:");
    expect(script).not.toContain("'wt:");
    expect(script).not.toContain("\n      'init:");
    expect(script).not.toContain(" promote ");
  });

  it("renders generated bash completion for both executable names", () => {
    const script = renderShellInit("bash");

    expect(script).toContain("_workforest_complete()");
    expect(script).toContain("complete -F _workforest_complete wf workforest");
    expect(script).toContain(
      "_workforest_complete_words 'templates tasks reviews dashboard start list status add switch finish delete ai migrate task cache review template shell config skills help version'",
    );
    expect(script).toContain(
      "_workforest_complete_words 'start list finish delete'",
    );
    expect(script).toContain(
      "_workforest_complete_words '--repo -n --dry-run -f --force --json'",
    );
    expect(script).not.toContain("compdef _workforest_complete");
  });

  it("derives completion and handoff commands from the registry", () => {
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

    expect(script).toContain(
      "_workforest_complete_words 'templates tasks reviews inspect visit dashboard start list status add switch finish delete ai migrate task",
    );
    expect(script).toContain(
      "visit|start|add|switch|finish|delete|task|review|template)",
    );
    expect(script).not.toContain("inspect|visit|start");
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
