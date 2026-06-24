import { describe, expect, it } from "vitest";
import { commandRegistry } from "../cli/commands.ts";
import { createShellCommandModel } from "./command-model.ts";

describe("shell command model", () => {
  it("contains every visible root invocation and excludes internal commands", () => {
    const model = createShellCommandModel(commandRegistry);

    expect(model.commands.map((command) => command.name)).toEqual([
      "new",
      "clean",
      "start",
      "list",
      "status",
      "add",
      "switch",
      "finish",
      "delete",
      "workspace",
      "task",
      "worktree",
      "cache",
      "review",
      "template",
      "shell",
      "config",
      "skills",
      "help",
      "version",
    ]);
    expect(model.commands.map((command) => command.name)).not.toContain(
      "_initialize-repo",
    );
  });

  it("derives scoped commands and flags from leaf metadata", () => {
    const model = createShellCommandModel(commandRegistry);
    const workspace = model.commands.find(
      (command) => command.name === "workspace",
    );
    const create = workspace?.children.find(
      (command) => command.name === "create",
    );

    expect(workspace?.children.map((command) => command.name)).toEqual([
      "create",
      "delete",
      "open",
      "list",
      "status",
      "add",
    ]);
    expect(create?.flags.map((flag) => flag.long)).toEqual([
      "--like",
      "--description",
      "--dry-run",
    ]);
  });

  it("derives the wrapper handoff roots from leaf metadata", () => {
    const model = createShellCommandModel(commandRegistry);

    expect(model.handoffCommands).toEqual([
      "new",
      "clean",
      "start",
      "add",
      "switch",
      "finish",
      "delete",
      "workspace",
      "task",
      "worktree",
      "review",
      "template",
    ]);
  });
});
