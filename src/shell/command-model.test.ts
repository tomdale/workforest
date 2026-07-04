import { describe, expect, it } from "vitest";
import { commandRegistry } from "../cli/commands.ts";
import { createShellCommandModel } from "./command-model.ts";

describe("shell command model", () => {
  it("contains every visible root invocation and excludes internal commands", () => {
    const model = createShellCommandModel(commandRegistry);

    expect(model.commands.map((command) => command.name)).toEqual([
      "new",
      "adopt",
      "list",
      "status",
      "add",
      "switch",
      "delete",
      "init",
      "ai",
      "migrate",
      "task",
      "cloud",
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
      ["_initialize", "repo"].join("-"),
    );
  });

  it("derives scoped commands and flags from leaf metadata", () => {
    const model = createShellCommandModel(commandRegistry);
    const task = model.commands.find((command) => command.name === "task");
    const taskNew = task?.children.find((command) => command.name === "new");
    const cache = model.commands.find((command) => command.name === "cache");
    const worktree = cache?.children.find(
      (command) => command.name === "worktree",
    );

    expect(task?.children.map((command) => command.name)).toEqual([
      "new",
      "list",
      "delete",
    ]);
    expect(taskNew?.flags.map((flag) => flag.long)).toEqual([
      "--repo",
      "--dry-run",
      "--force",
      "--json",
    ]);
    expect(worktree?.children.map((command) => command.name)).toEqual([
      "list",
      "add",
      "move",
      "remove",
    ]);
    expect(worktree?.children.flatMap((command) => command.flags)).toEqual([]);
  });
});
