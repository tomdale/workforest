import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
      "new|fork|clean|cd|find|template|worktree|wt|review|skills",
    );
    expect(script).toContain("WORKFOREST_CD_PATH_FILE");
    expect(script).toContain("wf() {");
    expect(script).toContain("workforest() {");
    expect(script).toContain("_workforest_complete()");
    expect(script).toContain("compdef _workforest_complete wf workforest");
    expect(script).toContain("__workforest_workspace_root()");
    expect(script).toContain('local subcommand="$' + '{words[2]:-}"');
    expect(script).toContain("cd|clean)");
    expect(script).toContain("find:fuzzy-find a workspace");
    expect(script).toContain("review:create or manage PR review worktrees");
    expect(script).toContain("skills:list and retrieve bundled agent skills");
    expect(script).toContain("_workforest_workspace_names");
    expect(script).not.toContain("CURRENT == 3");
  });

  it("does not emit zsh completion helpers for bash", () => {
    const script = renderShellInit("bash");

    expect(script).not.toContain("_workforest_complete()");
    expect(script).not.toContain("compdef _workforest_complete");
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
