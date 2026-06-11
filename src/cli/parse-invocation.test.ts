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

  it("accepts long string values as the following token", () => {
    const parsed = parse(["dev", "simulate", "new", "--speed", "fast"]);

    expect(parsed.flags).toEqual({ speed: "fast" });
  });

  it("keeps every token after -- as operand data", () => {
    const parsed = parse([
      "new",
      "--dry-run",
      "vercel/front",
      "--",
      "--fix",
      "auth",
    ]);

    expect(parsed.flags).toEqual({ dryRun: true });
    expect(parsed.beforeDoubleDash).toEqual(["vercel/front"]);
    expect(parsed.afterDoubleDash).toEqual(["--fix", "auth"]);
    expect(parsed.hadDoubleDash).toBe(true);
  });

  it.each([
    [["repository", "list", "--force"], 'Unknown flag "--force"'],
    [["review", "target", "--dry-run"], 'Unknown flag "--dry-run"'],
    [["workspace", "list", "--bogus"], 'Unknown flag "--bogus"'],
    [
      ["worktree", "create", "repo", "name", "--force"],
      'Unknown flag "--force"',
    ],
    [["worktree", "list", "--force"], 'Unknown flag "--force"'],
    [["worktree", "delete", "--dir", "path"], 'Unknown flag "--dir"'],
    [["task", "list", "--dry-run"], 'Unknown flag "--dry-run"'],
  ])("rejects unknown or inapplicable flags for %j", (argv, message) => {
    expect(() => parse(argv)).toThrow(message);
  });

  it("rejects missing string values", () => {
    expect(() => parse(["workspace", "add", "--workspace"])).toThrow(
      'Flag "--workspace" requires dir.',
    );
    expect(() => parse(["workspace", "add", "--workspace", "--help"])).toThrow(
      'Flag "--workspace" requires dir.',
    );
  });

  it("rejects duplicate flags", () => {
    expect(() => parseRaw(["workspace", "list"], ["--help", "-h"])).toThrow(
      'Flag "-h" may only be specified once.',
    );
  });

  it.each([
    [["workspace", "list", "extra"], "Expected no operands"],
    [["template", "copy", "one"], "Expected 2 templates"],
    [["review"], "Expected 1-2 review targets"],
    [["review", "one", "two", "three"], "Expected 1-2 review targets"],
    [["repository", "add"], "Expected 1 or more repositories"],
    [["worktree", "create"], "Expected 2 repository and slug"],
    [
      ["worktree", "create", "repo", "name", "extra"],
      "Expected 2 repository and slug",
    ],
    [["worktree", "list", "one", "extra"], "Expected 0-1 repository"],
    [["worktree", "delete"], "Expected 1 worktree path"],
    [["task", "create"], "Expected 1 or more task names"],
    [["task", "delete"], "Expected 1 or more task names"],
  ])("enforces exact and variadic cardinality for %j", (argv, message) => {
    expect(() => parse(argv)).toThrow(message);
  });

  it("parses each worktree leaf with only its declared flags", () => {
    expect(
      parse([
        "worktree",
        "create",
        "repo",
        "slug",
        "--dir",
        "./target",
        "--dry-run",
      ]).flags,
    ).toEqual({
      dir: "./target",
      dryRun: true,
    });
    expect(parse(["worktree", "delete", "./slug", "-n", "-f"]).flags).toEqual({
      dryRun: true,
      force: true,
    });
    expect(
      parse(["task", "create", "slug", "--repo", "front", "-f"]).flags,
    ).toEqual({
      repo: "front",
      force: true,
    });
  });

  it("supports the interactive and delimited new operand forms", () => {
    expect(parseInteractive(["new"]).beforeDoubleDash).toEqual([]);
    expect(() => parse(["new"])).toThrow(UsageError);
    expect(
      parse(["new", "vercel/front", "--", "fix", "auth"]).afterDoubleDash,
    ).toEqual(["fix", "auth"]);
    expect(() => parse(["new", "vercel/front"])).toThrow(UsageError);
    expect(() => parse(["new", "--", "fix"])).toThrow(UsageError);
  });

  it.each([
    [
      ["workspace", "add"],
      ["workspace", "add", "vercel/front"],
    ],
    [
      ["template", "new"],
      ["template", "new", "demo", "vercel/front"],
    ],
  ])("enforces interactive operand alternatives for %j", (interactiveArgv, nonInteractiveArgv) => {
    expect(() => parse(interactiveArgv)).toThrow(UsageError);
    expect(() => parseInteractive(interactiveArgv)).not.toThrow();
    expect(() => parse(nonInteractiveArgv)).not.toThrow();
  });

  it("accepts zero-operand workspace open for interactive runtime selection", () => {
    expect(() => parse(["workspace", "open"])).not.toThrow();
    expect(() => parseInteractive(["workspace", "open"])).not.toThrow();
  });

  it("allows workspace creation like the current workspace", () => {
    expect(() =>
      parse(["workspace", "create", "--like", "current", "--", "fix auth"]),
    ).not.toThrow();
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
