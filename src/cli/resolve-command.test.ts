import { describe, expect, it } from "vitest";
import { commandRegistry } from "./commands.ts";
import { resolveCommand } from "./resolve-command.ts";

describe("resolveCommand", () => {
  it.each([
    [["start", "fix-auth", "vercel/front"], ["start"], "change.start"],
    [["add", "vercel/api"], ["add"], "change.add"],
    [["switch", "vercel-agent/auth-fix"], ["switch"], "change.switch"],
    [["workspace", "create"], ["workspace", "create"], "workspace.create"],
    [
      ["workspace", "delete", "demo"],
      ["workspace", "delete"],
      "workspace.delete",
    ],
    [["task", "create", "fix-auth"], ["task", "create"], "task.create"],
    [
      ["worktree", "create", "front", "fix-auth"],
      ["worktree", "create"],
      "worktree.create",
    ],
    [["cache", "doctor", "front"], ["cache", "doctor"], "cache.doctor"],
    [["review", "checkout", "123"], ["review", "checkout"], "review.checkout"],
    [["template", "manage"], ["template", "manage"], "template.manage"],
    [["shell", "init", "zsh"], ["shell", "init"], "shell.init"],
    [["config"], ["config"], "config.show"],
    [["skills"], ["skills"], "skills.list"],
    [["version"], ["version"], "version"],
  ])("resolves canonical command %j", (argv, canonicalPath, handler) => {
    const resolution = resolveCommand(commandRegistry, argv);

    expect(resolution.kind).toBe("command");
    if (resolution.kind !== "command") return;
    expect(resolution.canonicalPath).toEqual(canonicalPath);
    expect(resolution.leaf.handler).toBe(handler);
  });

  it.each([
    [["new"], ["workspace", "create"], "workspace.create"],
    [["clean", "demo"], ["workspace", "delete"], "workspace.delete"],
  ])("canonicalizes root shortcut %j", (argv, canonicalPath, handler) => {
    const resolution = resolveCommand(commandRegistry, argv);

    expect(resolution).toMatchObject({
      kind: "command",
      canonicalPath,
      invokedPath: [argv[0]],
      leaf: { handler },
    });
  });

  it.each([
    [[], { kind: "root" }],
    [["--help"], { kind: "root" }],
    [["workspace", "--help"], { kind: "command", command: "workspace" }],
    [
      ["workspace", "create", "--help"],
      { kind: "nested", command: "workspace", subcommand: "create" },
    ],
    [["new", "--help"], { kind: "command", command: "new" }],
    [["clean", "--help"], { kind: "command", command: "clean" }],
  ])("resolves help for %j", (argv, help) => {
    expect(resolveCommand(commandRegistry, argv)).toMatchObject({
      kind: "help",
      help,
    });
  });

  it.each([
    "workspace",
    "task",
    "worktree",
    "cache",
    "review",
    "template",
    "shell",
  ])("shows scoped help for the bare %s namespace", (command) => {
    expect(resolveCommand(commandRegistry, [command])).toMatchObject({
      kind: "help",
      canonicalPath: [command],
      help: { kind: "command", command },
    });
  });

  it("requires explicit leaves for resource groups", () => {
    expect(() =>
      resolveCommand(commandRegistry, ["workspace", "demo"]),
    ).toThrow("Unknown wf workspace subcommand: demo");
    expect(() => resolveCommand(commandRegistry, ["task", "--force"])).toThrow(
      "Unknown wf task subcommand: --force",
    );
    expect(() => resolveCommand(commandRegistry, ["review", "123"])).toThrow(
      "Unknown wf review subcommand: 123",
    );
  });

  it("rejects unknown root and scoped commands", () => {
    expect(() => resolveCommand(commandRegistry, ["wat"])).toThrow(
      "Unknown command: wat",
    );
    expect(() => resolveCommand(commandRegistry, ["cache", "inspect"])).toThrow(
      "Unknown wf cache subcommand: inspect",
    );
    expect(() => resolveCommand(commandRegistry, ["_initialize-repo"])).toThrow(
      "Unknown command: _initialize-repo",
    );
  });
});
