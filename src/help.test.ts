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
  CONCEPTS,
  commandPathHelp,
  commandUsageLines,
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

  it("explains what workforest is and defines its core concepts", () => {
    const output = stripAnsi(rootHelp(commandRegistry, ROOT_CONTEXT));

    expect(output).toContain("Concepts:");
    for (const { term, summary } of CONCEPTS) {
      expect(output).toContain(term);
      expect(output).toContain(summary);
    }
  });

  it("renders scoped subcommands, operands, and flags from the registry", () => {
    const task = stripAnsi(commandPathHelp(commandRegistry, ["task"]) ?? "");
    const start = stripAnsi(
      commandPathHelp(commandRegistry, ["task", "start"]) ?? "",
    );

    for (const child of findGroup(commandRegistry.root, "task").children) {
      if (child.visibility === "visible") {
        expect(task).toContain(child.name);
        expect(task).toContain(child.summary);
      }
    }
    expect(start).toContain("Usage: wf task start [options] <task names...>");
    expect(start).toContain("--repo <repository>");
    expect(start).toContain("--dry-run");
  });

  it("hides hidden commands and aliases while showing visible aliases", () => {
    const registry = structuredClone(commandRegistry) as MutableCommandRegistry;
    const task = findMutableNode(registry.root, ["task"]);
    const start = findMutableNode(registry.root, ["task", "start"]);
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
    expect(output).toContain("start|make");
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
      commandPathHelp(commandRegistry, ["task", "start"]) ?? "",
    );

    expect(fixed).toContain("<source template> <destination template>");
    expect(unbounded).toContain("<task names...>");
  });

  it("renders explicit usage fragments for distinct operands", () => {
    expect(
      stripAnsi(commandPathHelp(commandRegistry, ["review", "checkout"]) ?? ""),
    ).toContain("<review target> [pull request]");
    expect(
      stripAnsi(commandPathHelp(commandRegistry, ["template", "copy"]) ?? ""),
    ).toContain("<source template> <destination template>");
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
