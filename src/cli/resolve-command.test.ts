import { describe, expect, it } from "vitest";
import { commandRegistry } from "./commands.ts";
import { UsageError } from "./errors.ts";
import { resolveCommand } from "./resolve-command.ts";

describe("resolveCommand", () => {
  it.each([
    [["new"], ["new"], "new"],
    [["list"], ["list"], "list"],
    [["worktree", "new", "repo"], ["worktree", "new"], "worktree.new"],
    [
      ["repository", "doctor", "repo"],
      ["repository", "doctor"],
      "repository.doctor",
    ],
    [
      ["dev", "simulate", "new", "--speed", "fast"],
      ["dev", "simulate", "new"],
      "dev.simulate.new",
    ],
  ])("resolves canonical command %j", (argv, canonicalPath, handler) => {
    const resolution = resolveCommand(commandRegistry, argv);

    expect(resolution.kind).toBe("command");
    if (resolution.kind !== "command") return;
    expect(resolution.canonicalPath).toEqual(canonicalPath);
    expect(resolution.leaf.handler).toBe(handler);
  });

  it.each([
    [["ls"], ["list"]],
    [
      ["wt", "new", "repo"],
      ["worktree", "new"],
    ],
    [
      ["templates", "create"],
      ["template", "new"],
    ],
    [
      ["repos", "check"],
      ["repository", "doctor"],
    ],
    [
      ["review", "remove", "123"],
      ["review", "delete"],
    ],
    [
      ["dev", "sim", "confetti"],
      ["dev", "simulate", "confetti"],
    ],
    [["--version"], ["version"]],
    [["-V"], ["version"]],
  ])("canonicalizes aliases for %j", (argv, canonicalPath) => {
    const resolution = resolveCommand(commandRegistry, argv);

    expect(resolution.kind).toBe("command");
    if (resolution.kind !== "command") return;
    expect(resolution.canonicalPath).toEqual(canonicalPath);
    expect(resolution.invokedPath).not.toEqual([]);
  });

  it("uses contextual default leaves without interpreting operands", () => {
    const review = resolveCommand(commandRegistry, [
      "review",
      "vercel/front#123",
    ]);
    const worktree = resolveCommand(commandRegistry, ["worktree", "fix-auth"]);

    expect(review).toMatchObject({
      kind: "command",
      canonicalPath: ["review"],
      argv: ["vercel/front#123"],
    });
    expect(worktree).toMatchObject({
      kind: "command",
      canonicalPath: ["worktree"],
      argv: ["fix-auth"],
    });
  });

  it("does not register help-only worktree aliases", () => {
    const resolution = resolveCommand(commandRegistry, ["worktree", "ls"]);

    expect(resolution).toMatchObject({
      kind: "command",
      canonicalPath: ["worktree"],
      argv: ["ls"],
    });
  });

  it("rejects help-only workspace aliases", () => {
    expect(() =>
      resolveCommand(commandRegistry, ["workspace", "remove"]),
    ).toThrowError(UsageError);
  });

  it.each([
    [[], { kind: "root" }],
    [["--help"], { kind: "root" }],
    [["worktree", "--help"], { kind: "command", command: "worktree" }],
    [["wt", "--help"], { kind: "command", command: "wt" }],
    [
      ["worktree", "delete", "--help"],
      { kind: "nested", command: "worktree", subcommand: "delete" },
    ],
    [
      ["dev", "simulate", "--help"],
      { kind: "dev-simulation", flow: "simulate" },
    ],
  ])("resolves help for %j", (argv, help) => {
    expect(resolveCommand(commandRegistry, argv)).toMatchObject({
      kind: "help",
      help,
    });
  });

  it("stops group traversal at flags and delimiters", () => {
    expect(
      resolveCommand(commandRegistry, ["review", "--force"]),
    ).toMatchObject({
      kind: "command",
      canonicalPath: ["review"],
      argv: ["--force"],
    });
    expect(resolveCommand(commandRegistry, ["review", "--"])).toMatchObject({
      kind: "command",
      canonicalPath: ["review"],
      argv: ["--"],
    });
  });

  it("rejects unknown root and non-contextual subcommands", () => {
    expect(() => resolveCommand(commandRegistry, ["wat"])).toThrow(
      "Unknown command: wat",
    );
    expect(() =>
      resolveCommand(commandRegistry, ["repository", "wat"]),
    ).toThrow("Unknown wf repository subcommand: wat");
  });
});
