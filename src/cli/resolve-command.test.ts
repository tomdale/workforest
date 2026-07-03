import { describe, expect, it } from "vitest";
import { commandRegistry } from "./commands.ts";
import { resolveCommand } from "./resolve-command.ts";

describe("resolveCommand", () => {
  it.each([
    [["new", "fix-auth", "vercel/front"], ["new"], "new"],
    [["add", "vercel/api"], ["add"], "add"],
    [["switch", "vercel-agent/auth-fix"], ["switch"], "switch"],
    [["delete", "_adhoc/experiment"], ["delete"], "delete"],
    [["task", "new", "fix-auth"], ["task", "new"], "task.new"],
    [["task", "delete", "fix-auth"], ["task", "delete"], "task.delete"],
    [["cache", "doctor", "front"], ["cache", "doctor"], "cache.doctor"],
    [
      ["cache", "worktree", "list", "front"],
      ["cache", "worktree", "list"],
      "cache.worktree.list",
    ],
    [["review", "123"], ["review"], "review"],
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
    [[], { kind: "root" }],
    [["--help"], { kind: "root" }],
    [["cache", "--help"], { kind: "command", command: "cache" }],
    [["new", "--help"], { kind: "command", command: "new" }],
    [
      ["task", "new", "--help"],
      { kind: "nested", command: "task", subcommand: "new" },
    ],
  ])("resolves help for %j", (argv, help) => {
    expect(resolveCommand(commandRegistry, argv)).toMatchObject({
      kind: "help",
      help,
    });
  });

  it.each([
    "cache",
    "task",
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
    expect(() => resolveCommand(commandRegistry, ["task", "--force"])).toThrow(
      "Unknown wf task subcommand: --force",
    );
    expect(resolveCommand(commandRegistry, ["review", "123"])).toMatchObject({
      kind: "command",
      canonicalPath: ["review"],
    });
  });

  it("rejects unknown root and scoped commands", () => {
    expect(() => resolveCommand(commandRegistry, ["wat"])).toThrow(
      "Unknown command: wat",
    );
    expect(() => resolveCommand(commandRegistry, ["cache", "inspect"])).toThrow(
      "Unknown wf cache subcommand: inspect",
    );
    const privateWorkerCommand = ["_initialize", "repo"].join("-");
    expect(() =>
      resolveCommand(commandRegistry, [privateWorkerCommand]),
    ).toThrow(`Unknown command: ${privateWorkerCommand}`);
  });
});
