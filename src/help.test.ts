import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { commandRegistry } from "./cli/commands.ts";
import type {
  CommandGroup,
  CommandLeaf,
  CommandNode,
  CommandRegistry,
} from "./cli/types.ts";
import {
  commandPathHelp,
  commandUsageLines,
  conceptsPage,
  helpDoc,
  renderHelp,
  rootHelp,
} from "./help.ts";

const ROOT_CONTEXT = {
  configPath: "/config/config.json",
  templatesDir: "/config/templates",
  templates: ["demo                  Example template"],
} as const;

describe("registry-derived help", () => {
  it("renders the visible root command tree and supported shortcuts", () => {
    const output = stripAnsi(rootHelp(commandRegistry, ROOT_CONTEXT));

    for (const node of commandRegistry.root.children.filter(isVisible)) {
      expect(output).toContain(node.name);
      expect(output).toContain(node.summary);
    }
    for (const shortcut of commandRegistry.shortcuts.filter(
      (candidate) => candidate.visibility === "visible",
    )) {
      expect(output).toMatch(
        new RegExp(
          `^  ${shortcut.name}\\s+Shortcut for wf ${shortcut.target.join(" ")}$`,
          "m",
        ),
      );
    }

    expect(output).not.toContain(["_initialize", "repo"].join("-"));
    expect(output).not.toContain("Usage: workforest");
    expect(output).toContain("Usage: wf <command> [options]");
  });

  it("renders scoped subcommands, operands, and flags from the registry", () => {
    const task = stripAnsi(commandPathHelp(commandRegistry, ["task"]) ?? "");
    const start = stripAnsi(
      commandPathHelp(commandRegistry, ["task", "new"]) ?? "",
    );

    for (const child of findGroup(commandRegistry.root, "task").children) {
      if (child.visibility === "visible") {
        expect(task).toContain(child.name);
        expect(task).toContain(child.summary);
      }
    }
    expect(start).toContain("Usage: wf task new [options] <task names...>");
    expect(start).toContain("--repo <repository>");
    expect(start).toContain("--dry-run");
    expect(start).toContain("--json");
  });

  it("hides hidden commands and aliases while showing visible aliases", () => {
    const registry = structuredClone(commandRegistry) as MutableCommandRegistry;
    const task = findMutableNode(registry.root, ["task"]);
    const start = findMutableNode(registry.root, ["task", "new"]);
    if (task.kind !== "group") throw new Error("Expected task group");

    start.aliases = [
      { name: "make", visibility: "visible" },
      { name: "internal-create", visibility: "hidden" },
    ];
    task.children.push({
      ...structuredClone(start),
      name: "internal",
      path: ["task", "internal"],
      aliases: [],
      visibility: "hidden",
    });

    const output = stripAnsi(commandPathHelp(registry, ["task"]) ?? "");
    expect(output).toContain("new|make");
    expect(output).not.toContain("internal-create");
    expect(output).not.toContain("internal");
  });

  it("generates usage for every visible leaf with wf", () => {
    for (const leaf of collectVisibleLeaves(commandRegistry.root)) {
      const usage = commandUsageLines(leaf);
      expect(usage.length).toBeGreaterThan(0);
      expect(usage.every((line) => line.startsWith("wf "))).toBe(true);
      expect(usage.join("\n")).not.toContain("workforest ");
    }
  });

  it("uses ellipses only for unbounded operand cardinality", () => {
    const fixed = stripAnsi(
      commandPathHelp(commandRegistry, ["template", "copy"]) ?? "",
    );
    const unbounded = stripAnsi(
      commandPathHelp(commandRegistry, ["task", "new"]) ?? "",
    );

    expect(fixed).toContain("<source template> <destination template>");
    expect(unbounded).toContain("<task names...>");
  });

  it("renders inline markdown code as formatted terminal text", () => {
    const output = stripAnsi(
      renderHelp("Use `wf new <name> @<template>` to build a workspace."),
    );

    expect(output).toBe("Use wf new <name> @<template> to build a workspace.");
    expect(output).not.toContain("`");
  });

  it("does not command-style paths that contain workforest", () => {
    const doc = helpDoc(
      "Stored at `~/.config/workforest/templates/<name>/template.jsonc`. Use `wf new <name>`.",
    );
    const spans = doc.lines.flatMap((line) => line.spans);

    const pathSpan = spans.find((span) =>
      span.text.includes("~/.config/workforest"),
    );
    const commandSpan = spans.find((span) => span.text === "wf");

    expect(pathSpan).toMatchObject({ role: "accent" });
    expect(pathSpan?.emphasis).toBeUndefined();
    expect(commandSpan).toMatchObject({
      role: "focus",
      emphasis: "bold",
    });
  });

  it("does not leak markdown backticks in concept help", () => {
    const output = stripAnsi(conceptsPage());

    expect(output).toContain("wf new <name> @<template>");
    expect(output).not.toContain("`");
  });
});

function findGroup(root: CommandGroup, name: string): CommandGroup {
  const node = root.children.find((child) => child.name === name);
  if (!node || node.kind !== "group") {
    throw new Error(`Expected ${name} group`);
  }
  return node;
}

function collectVisibleLeaves(root: CommandGroup): CommandLeaf[] {
  return root.children.flatMap(function visit(
    node: CommandNode,
  ): CommandLeaf[] {
    if (node.visibility === "hidden") return [];
    if (node.kind === "leaf") return [node];
    return node.children.flatMap(visit);
  });
}

function findMutableNode(
  root: Mutable<CommandGroup>,
  path: readonly string[],
): Mutable<CommandNode> {
  let node: Mutable<CommandNode> = root;
  for (const segment of path) {
    if (node.kind !== "group") {
      throw new Error(`Expected group before ${segment}`);
    }
    const child: Mutable<CommandNode> | undefined = node.children.find(
      (candidate) => candidate.name === segment,
    );
    if (!child) {
      throw new Error(`Missing ${segment}`);
    }
    node = child;
  }
  return node;
}

function isVisible(node: CommandNode): boolean {
  return node.visibility === "visible";
}

type MutableCommandRegistry = Mutable<CommandRegistry>;

type Mutable<Value> = Value extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : Value extends object
    ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
    : Value;
