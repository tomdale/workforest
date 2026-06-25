import { describe, expect, it } from "vitest";
import { commandRegistry } from "./commands.ts";
import { UsageError } from "./errors.ts";
import { parseInvocation } from "./parse-invocation.ts";
import { resolveCommand } from "./resolve-command.ts";
import type { ResolvedCommand } from "./types.ts";

describe("parseInvocation", () => {
  it("parses leaf-local boolean and string flags", () => {
    const parsed = parse(["task", "start", "-n", "--repo=front", "fix-auth"]);

    expect(parsed.flags).toEqual({
      dryRun: true,
      repo: "front",
    });
    expect(parsed.beforeDoubleDash).toEqual(["fix-auth"]);
  });

  it.each([
    [["cache", "list", "--force"], 'Unknown flag "--force"'],
    [["task", "list", "--dry-run"], 'Unknown flag "--dry-run"'],
    [["review", "open", "front", "--force"], 'Unknown flag "--force"'],
    [["template", "show", "base", "--json"], 'Unknown flag "--json"'],
    [["switch", "--force"], 'Unknown flag "--force"'],
  ])("rejects unknown or inapplicable flags for %j", (argv, message) => {
    expect(() => parse(argv)).toThrow(message);
  });

  it("rejects missing and duplicate flag values", () => {
    expect(() => parse(["task", "start", "--repo"])).toThrow(
      'Flag "--repo" requires repository.',
    );
    expect(() => parseRaw(["list"], ["--help", "-h"])).toThrow(
      'Flag "-h" may only be specified once.',
    );
  });

  it.each([
    [["list", "extra"], "Expected no operands"],
    [["start"], "Expected 1 or more arguments"],
    [["status", "one", "two"], "Expected 0-1 selector"],
    [["add"], "Expected 1 or more sources"],
    [["switch", "one", "two"], "Expected 0-1 selector"],
    [["finish", "one", "two"], "Expected 0-1 selector"],
    [["delete"], "Expected 1 selector"],
    [["delete", "one", "two"], "Expected 1 selector"],
    [["task", "start"], "Expected 1 or more task names"],
    [["task", "finish"], "Expected 1 or more task names"],
    [["task", "delete"], "Expected 1 or more task names"],
    [["cache", "show"], "Expected 1 repository"],
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

  it("parses the final change lifecycle command operands", () => {
    expect(parse(["start", "fix-auth", "vercel/front"])).toMatchObject({
      beforeDoubleDash: ["fix-auth", "vercel/front"],
    });
    expect(
      parse(["start", "--branch", "tomdale/custom", "fix-auth", "front"]),
    ).toMatchObject({
      flags: { branch: "tomdale/custom" },
      beforeDoubleDash: ["fix-auth", "front"],
    });
    expect(
      parse(["status", "workforest/cli-redesign"]).beforeDoubleDash,
    ).toEqual(["workforest/cli-redesign"]);
    expect(parse(["finish"]).beforeDoubleDash).toEqual([]);
    expect(parse(["delete", "_adhoc/experiment"]).beforeDoubleDash).toEqual([
      "_adhoc/experiment",
    ]);
  });

  it("parses task flags independently", () => {
    expect(
      parse(["task", "start", "fix", "--repo", "front", "-n", "-f"]).flags,
    ).toEqual({
      repo: "front",
      dryRun: true,
      force: true,
    });
    expect(
      parse(["task", "finish", "fix", "--repo", "front", "-n"]).flags,
    ).toEqual({
      repo: "front",
      dryRun: true,
    });
  });

  it("supports interactive operands only on interactive leaves", () => {
    expect(() => parse(["start"])).toThrow(UsageError);
    expect(() => parseInteractive(["start"])).not.toThrow();
    expect(() => parse(["template", "new"])).toThrow(UsageError);
    expect(() => parseInteractive(["template", "new"])).not.toThrow();
  });

  it("supports skills get names or --all, but not both", () => {
    expect(parse(["skills", "get", "core"]).beforeDoubleDash).toEqual(["core"]);
    expect(parse(["skills", "get", "--all"]).flags).toEqual({ all: true });
    expect(() => parse(["skills", "get"])).toThrow(UsageError);
    expect(() => parse(["skills", "get", "--all", "core"])).toThrow(UsageError);
  });

  it("does not expose the repository initializer worker as a command", () => {
    const privateWorkerCommand = ["_initialize", "repo"].join("-");
    expect(() => parse([privateWorkerCommand])).toThrow(
      `Unknown command: ${privateWorkerCommand}`,
    );
  });

  it.each(
    [["new"], ["clean"], ["workspace"], ["worktree"], ["task", "create"]].map(
      (argv) => ({ argv }),
    ),
  )("does not expose removed command %j", ({ argv }) => {
    expect(() => parse(argv)).toThrow();
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
