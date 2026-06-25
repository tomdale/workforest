import { describe, expect, it } from "vitest";
import { commandRegistry } from "./commands.ts";
import { resolveCommand } from "./resolve-command.ts";

describe("resolveCommand", () => {
  it.each([
    [["start", "fix-auth", "vercel/front"], ["start"], "change.start"],
    [["add", "vercel/api"], ["add"], "change.add"],
    [["switch", "vercel-agent/auth-fix"], ["switch"], "change.switch"],
    [["finish", "workforest/cli-redesign"], ["finish"], "change.finish"],
    [["delete", "_adhoc/experiment"], ["delete"], "change.delete"],
    [["task", "start", "fix-auth"], ["task", "start"], "task.start"],
    [["task", "finish", "fix-auth"], ["task", "finish"], "task.finish"],
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
    [[], { kind: "root" }],
    [["--help"], { kind: "root" }],
    [["start", "--help"], { kind: "command", command: "start" }],
    [
      ["task", "start", "--help"],
      { kind: "nested", command: "task", subcommand: "start" },
    ],
  ])("resolves help for %j", (argv, help) => {
    expect(resolveCommand(commandRegistry, argv)).toMatchObject({
      kind: "help",
      help,
    });
  });

  it.each([
    "task",
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
    expect(() => resolveCommand(commandRegistry, ["new"])).toThrow(
      "Unknown command: new",
    );
    expect(() => resolveCommand(commandRegistry, ["clean"])).toThrow(
      "Unknown command: clean",
    );
    expect(() => resolveCommand(commandRegistry, ["workspace"])).toThrow(
      "Unknown command: workspace",
    );
    expect(() => resolveCommand(commandRegistry, ["worktree"])).toThrow(
      "Unknown command: worktree",
    );
    expect(() => resolveCommand(commandRegistry, ["task", "create"])).toThrow(
      "Unknown wf task subcommand: create",
    );
    expect(() => resolveCommand(commandRegistry, ["cache", "inspect"])).toThrow(
      "Unknown wf cache subcommand: inspect",
    );
    expect(() => resolveCommand(commandRegistry, ["cache", "info"])).toThrow(
      "Unknown wf cache subcommand: info",
    );
    const privateWorkerCommand = ["_initialize", "repo"].join("-");
    expect(() =>
      resolveCommand(commandRegistry, [privateWorkerCommand]),
    ).toThrow(`Unknown command: ${privateWorkerCommand}`);
  });
});
