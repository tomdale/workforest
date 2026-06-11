import { describe, expect, it } from "vitest";
import { commandRegistry } from "./commands.ts";
import { UsageError } from "./errors.ts";
import { resolveCommand } from "./resolve-command.ts";

describe("resolveCommand", () => {
  it.each([
    [["new"], ["new"], "workspace.create"],
    [["workspace", "list"], ["workspace", "list"], "workspace.list"],
    [
      ["worktree", "create", "repo", "slug"],
      ["worktree", "create"],
      "worktree.create",
    ],
    [["task", "create", "slug"], ["task", "create"], "task.create"],
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

  it("uses the review default leaf without interpreting operands", () => {
    const review = resolveCommand(commandRegistry, [
      "review",
      "vercel/front#123",
    ]);

    expect(review).toMatchObject({
      kind: "command",
      canonicalPath: ["review"],
      argv: ["vercel/front#123"],
    });
  });

  it("does not register discarded worktree aliases", () => {
    expect(() => resolveCommand(commandRegistry, ["wt", "list"])).toThrowError(
      UsageError,
    );
    expect(() =>
      resolveCommand(commandRegistry, ["worktree", "ls"]),
    ).toThrowError(UsageError);
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
    [["task", "--help"], { kind: "command", command: "task" }],
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
