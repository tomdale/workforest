import { describe, expect, it } from "vitest";
import { commandRegistry } from "./commands.ts";
import { UsageError } from "./errors.ts";
import { resolveCommand } from "./resolve-command.ts";

describe("resolveCommand", () => {
  it.each([
    [["new"], ["new"], "new"],
    [["list"], ["list"], "list"],
    [["worktree", "new", "repo"], ["worktree", "new"], "worktree.new"],
    [["cache", "doctor", "repo"], ["cache", "doctor"], "cache.doctor"],
    [["review", "open", "repo"], ["review", "open"], "review.open"],
    [
      ["review", "checkout", "repo#123"],
      ["review", "checkout"],
      "review.checkout",
    ],
    [["shell", "init", "zsh"], ["shell", "init"], "shell.init"],
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

  it("uses the contextual worktree default without interpreting operands", () => {
    const worktree = resolveCommand(commandRegistry, ["worktree", "fix-auth"]);

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

  it("requires explicit resource subcommands", () => {
    expect(resolveCommand(commandRegistry, ["review"])).toMatchObject({
      kind: "help",
      canonicalPath: ["review"],
    });
    expect(resolveCommand(commandRegistry, ["template"])).toMatchObject({
      kind: "help",
      canonicalPath: ["template"],
    });
    expect(resolveCommand(commandRegistry, ["cache"])).toMatchObject({
      kind: "help",
      canonicalPath: ["cache"],
    });
  });

  it("rejects unknown root and non-contextual subcommands", () => {
    expect(() => resolveCommand(commandRegistry, ["wat"])).toThrow(
      "Unknown command: wat",
    );
    expect(() => resolveCommand(commandRegistry, ["cache", "wat"])).toThrow(
      "Unknown wf cache subcommand: wat",
    );
  });
});
