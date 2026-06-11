import { describe, expect, it } from "vitest";
import { commandRegistry } from "./commands.ts";
import { UsageError } from "./errors.ts";
import { parseInvocation } from "./parse-invocation.ts";
import { resolveCommand } from "./resolve-command.ts";
import type { ResolvedCommand } from "./types.ts";

describe("parseInvocation", () => {
  it("parses leaf-local boolean and string flags", () => {
    const parsed = parse([
      "workspace",
      "add",
      "-n",
      "--workspace=./demo",
      "vercel/front",
    ]);

    expect(parsed.flags).toEqual({
      dryRun: true,
      workspace: "./demo",
    });
    expect(parsed.beforeDoubleDash).toEqual(["vercel/front"]);
  });

  it("parses root shortcuts using their canonical leaf contract", () => {
    expect(
      parse(["new", "--dry-run", "vercel/front", "--", "fix", "auth"]),
    ).toMatchObject({
      flags: { dryRun: true },
      beforeDoubleDash: ["vercel/front"],
      afterDoubleDash: ["fix", "auth"],
      hadDoubleDash: true,
    });
    expect(parse(["clean", "--force", "demo"])).toMatchObject({
      flags: { force: true },
      beforeDoubleDash: ["demo"],
    });
  });

  it.each([
    [["cache", "list", "--force"], 'Unknown flag "--force"'],
    [["task", "list", "--dry-run"], 'Unknown flag "--dry-run"'],
    [
      ["worktree", "create", "front", "fix", "--repo", "front"],
      'Unknown flag "--repo"',
    ],
    [["review", "open", "front", "--force"], 'Unknown flag "--force"'],
    [["template", "show", "base", "--json"], 'Unknown flag "--json"'],
    [["workspace", "open", "--force"], 'Unknown flag "--force"'],
  ])("rejects unknown or inapplicable flags for %j", (argv, message) => {
    expect(() => parse(argv)).toThrow(message);
  });

  it("rejects missing and duplicate flag values", () => {
    expect(() => parse(["workspace", "add", "--workspace"])).toThrow(
      'Flag "--workspace" requires dir.',
    );
    expect(() => parseRaw(["workspace", "list"], ["--help", "-h"])).toThrow(
      'Flag "-h" may only be specified once.',
    );
  });

  it.each([
    [["workspace", "list", "extra"], "Expected no operands"],
    [["workspace", "delete"], "Expected 1 workspace"],
    [["workspace", "delete", "one", "two"], "Expected 1 workspace"],
    [["task", "create"], "Expected 1 or more task names"],
    [["task", "delete"], "Expected 1 or more task names"],
    [
      ["worktree", "create", "front"],
      "Expected 2 repository and worktree name",
    ],
    [
      ["worktree", "create", "front", "fix", "extra"],
      "Expected 2 repository and worktree name",
    ],
    [["worktree", "delete"], "Expected 1 worktree path"],
    [["cache", "add"], "Expected 1 or more repositories"],
    [["cache", "delete"], "Expected 1 or more repositories"],
    [["review", "open"], "Expected 1 repository"],
    [["review", "checkout"], "Expected 1-2 review targets"],
    [
      ["review", "checkout", "one", "two", "three"],
      "Expected 1-2 review targets",
    ],
    [["template", "copy", "one"], "Expected 2 templates"],
    [["template", "delete"], "Expected 1 template"],
    [["shell", "init", "zsh", "bash"], "Expected 0-1 shell"],
  ])("enforces exact positional cardinality for %j", (argv, message) => {
    expect(() => parse(argv)).toThrow(message);
  });

  it("supports explicit workspace creation modes", () => {
    expect(parseInteractive(["workspace", "create"]).beforeDoubleDash).toEqual(
      [],
    );
    expect(() => parse(["workspace", "create"])).toThrow(UsageError);
    expect(
      parse(["workspace", "create", "vercel/front", "--", "fix", "auth"])
        .afterDoubleDash,
    ).toEqual(["fix", "auth"]);
    expect(
      parse(["workspace", "create", "--like", "current", "--", "fix-auth"]),
    ).toMatchObject({
      flags: { like: "current" },
      beforeDoubleDash: [],
      afterDoubleDash: ["fix-auth"],
    });
  });

  it("requires --search to be used without a workspace name", () => {
    expect(parse(["workspace", "open", "--search"]).flags).toEqual({
      search: true,
    });
    expect(parse(["workspace", "open", "demo"]).beforeDoubleDash).toEqual([
      "demo",
    ]);
    expect(() => parse(["workspace", "open", "--search", "demo"])).toThrow(
      UsageError,
    );
  });

  it("parses task and standalone worktree flags independently", () => {
    expect(
      parse(["task", "create", "fix", "--repo", "front", "-n", "-f"]).flags,
    ).toEqual({
      repo: "front",
      dryRun: true,
      force: true,
    });
    expect(
      parse(["worktree", "create", "front", "fix", "--dir", "./target", "-n"])
        .flags,
    ).toEqual({
      dir: "./target",
      dryRun: true,
    });
  });

  it("supports interactive operands only on interactive leaves", () => {
    expect(() => parse(["workspace", "add"])).toThrow(UsageError);
    expect(() => parseInteractive(["workspace", "add"])).not.toThrow();
    expect(() => parse(["template", "new"])).toThrow(UsageError);
    expect(() => parseInteractive(["template", "new"])).not.toThrow();
  });

  it("supports skills get names or --all, but not both", () => {
    expect(parse(["skills", "get", "core"]).beforeDoubleDash).toEqual(["core"]);
    expect(parse(["skills", "get", "--all"]).flags).toEqual({ all: true });
    expect(() => parse(["skills", "get"])).toThrow(UsageError);
    expect(() => parse(["skills", "get", "--all", "core"])).toThrow(UsageError);
  });

  it("enforces required internal-worker flags", () => {
    expect(() => parse(["_initialize-repo"])).toThrow(
      'Missing required flag "--workspace".',
    );
  });

  it("lets help bypass operand cardinality", () => {
    const parsed = parseRaw(["template", "copy"], ["--help"]);

    expect(parsed.helpRequested).toBe(true);
  });
});

function parse(argv: readonly string[]) {
  const resolution = resolveCommand(commandRegistry, argv);
  if (resolution.kind !== "command") {
    throw new Error("Expected command resolution");
  }
  return parseInvocation(resolution as ResolvedCommand);
}

function parseRaw(commandArgv: readonly string[], argv: readonly string[]) {
  const resolution = resolveCommand(commandRegistry, commandArgv);
  if (resolution.kind !== "command") {
    throw new Error("Expected command resolution");
  }
  return parseInvocation({ ...resolution, argv });
}

function parseInteractive(argv: readonly string[]) {
  const resolution = resolveCommand(commandRegistry, argv);
  if (resolution.kind !== "command") {
    throw new Error("Expected command resolution");
  }
  return parseInvocation(resolution, { interactive: true });
}
