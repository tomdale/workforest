import { describe, expect, it } from "vitest";
import { commandRegistry } from "../cli/commands.ts";
import { createShellCommandModel } from "./command-model.ts";

describe("shell command model", () => {
  it("contains every visible root invocation and excludes internal commands", () => {
    const model = createShellCommandModel(commandRegistry);

    expect(model.commands.map((command) => command.name)).toEqual([
      "templates",
      "tasks",
      "reviews",
      "dashboard",
      "start",
      "list",
      "status",
      "add",
      "switch",
      "finish",
      "delete",
      "ai",
      "migrate",
      "task",
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
    const start = task?.children.find((command) => command.name === "start");

    expect(task?.children.map((command) => command.name)).toEqual([
      "start",
      "list",
      "finish",
      "delete",
    ]);
    expect(start?.flags.map((flag) => flag.long)).toEqual([
      "--repo",
      "--dry-run",
      "--force",
      "--json",
    ]);
  });

  it("derives the wrapper handoff roots from leaf metadata", () => {
    const model = createShellCommandModel(commandRegistry);

    expect(model.handoffCommands).toEqual([
      "start",
      "add",
      "switch",
      "finish",
      "delete",
      "task",
      "review",
      "template",
    ]);
  });
});
