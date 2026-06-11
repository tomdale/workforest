import { describe, expect, it } from "vitest";
import { commandRegistry } from "./commands.ts";
import { UsageError } from "./errors.ts";
import { parseInvocation } from "./parse-invocation.ts";
import { resolveCommand } from "./resolve-command.ts";
import type { ResolvedCommand } from "./types.ts";

describe("parseInvocation", () => {
  it("parses leaf-local boolean and string flags", () => {
    const parsed = parse(["add", "-n", "--workspace=./demo", "vercel/front"]);

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
    [["cache", "list", "--force"], 'Unknown flag "--force"'],
    [["status", "cancel", "--json"], 'Unknown flag "--json"'],
    [["review", "checkout", "target", "--dry-run"], 'Unknown flag "--dry-run"'],
    [["list", "--bogus"], 'Unknown flag "--bogus"'],
    [["worktree", "new", "repo", "name", "--force"], 'Unknown flag "--force"'],
    [["worktree", "promote", "--repo", "repo"], 'Unknown flag "--repo"'],
    [["worktree", "list", "--force"], 'Unknown flag "--force"'],
    [["worktree", "delete", "--dir", "path"], 'Unknown flag "--dir"'],
  ])("rejects unknown or inapplicable flags for %j", (argv, message) => {
    expect(() => parse(argv)).toThrow(message);
  });

  it("rejects missing string values", () => {
    expect(() => parse(["add", "--workspace"])).toThrow(
      'Flag "--workspace" requires dir.',
    );
    expect(() => parse(["add", "--workspace", "--help"])).toThrow(
      'Flag "--workspace" requires dir.',
    );
  });

  it("rejects duplicate flags", () => {
    expect(() => parseRaw(["list"], ["--help", "-h"])).toThrow(
      'Flag "-h" may only be specified once.',
    );
  });

  it.each([
    [["list", "extra"], "Expected no operands"],
    [["template", "copy", "one"], "Expected 2 templates"],
    [["review", "open"], "Expected 1 repository"],
    [
      ["review", "checkout", "one", "two", "three"],
      "Expected 1-2 review targets",
    ],
    [["cache", "add"], "Expected 1 or more repositories"],
    [["shell", "init", "zsh", "extra"], "Expected 0-1 shell"],
    [["worktree"], "Expected 1 or more worktree operands"],
    [["worktree", "new"], "Expected 1-2 worktree operands"],
    [
      ["worktree", "new", "repo", "name", "extra"],
      "Expected 1-2 worktree operands",
    ],
    [["worktree", "list", "extra"], "Expected no operands"],
  ])("enforces exact and variadic cardinality for %j", (argv, message) => {
    expect(() => parse(argv)).toThrow(message);
  });

  it("parses each worktree leaf with only its declared flags", () => {
    expect(
      parse([
        "worktree",
        "repo",
        "slug",
        "--dir",
        "./target",
        "--repo",
        "front",
        "--dry-run",
        "--force",
      ]).flags,
    ).toEqual({
      dir: "./target",
      repo: "front",
      dryRun: true,
      force: true,
    });
    expect(parse(["worktree", "new", "repo", "name", "-n"]).flags).toEqual({
      dryRun: true,
    });
    expect(parse(["worktree", "promote", "template", "-n"]).flags).toEqual({
      dryRun: true,
    });
    expect(parse(["worktree", "list", "--repo", "front"]).flags).toEqual({
      repo: "front",
    });
    expect(
      parse(["worktree", "delete", "slug", "--repo", "front", "-n", "-f"])
        .flags,
    ).toEqual({
      repo: "front",
      dryRun: true,
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
    [["cd"], ["cd", "workspace"]],
    [["add"], ["add", "vercel/front"]],
    [["fork"], ["fork", "fix-auth"]],
    [
      ["template", "new"],
      ["template", "new", "demo", "vercel/front"],
    ],
  ])("enforces interactive operand alternatives for %j", (interactiveArgv, nonInteractiveArgv) => {
    expect(() => parse(interactiveArgv)).toThrow(UsageError);
    expect(() => parseInteractive(interactiveArgv)).not.toThrow();
    expect(() => parse(nonInteractiveArgv)).not.toThrow();
  });

  it("allows non-interactive fork creation through --description", () => {
    expect(() => parse(["fork", "--description", "fix auth"])).not.toThrow();
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
