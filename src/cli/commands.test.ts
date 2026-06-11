import { describe, expect, it } from "vitest";
import { commandRegistry, validateCommandRegistry } from "./commands.ts";
import type { CommandLeaf, CommandRegistry } from "./types.ts";

describe("commandRegistry", () => {
  it("defines the complete registry metadata for every leaf", () => {
    const leaves = collectLeaves(commandRegistry);

    expect(leaves.length).toBeGreaterThan(30);
    for (const leaf of leaves) {
      expect(leaf.summary).not.toBe("");
      expect(leaf.handler).not.toBe("");
      expect(leaf.operands.variants.length).toBeGreaterThan(0);
      expect(leaf.outputModes.length).toBeGreaterThan(0);
      expect(leaf.tty.kind).toBeTruthy();
      expect(leaf.shellHandoff).toMatch(/^(none|optional-cd)$/);
    }
  });

  it("accepts the production registry", () => {
    expect(() => validateCommandRegistry(commandRegistry)).not.toThrow();
  });

  it("rejects alias collisions", () => {
    const registry = cloneRegistry();
    const clean = registry.root.children.find((node) => node.name === "clean");
    if (!clean) throw new Error("Expected clean command");
    clean.aliases = [{ name: "new", visibility: "visible" }];

    expect(() => validateCommandRegistry(registry)).toThrow(
      'Duplicate command or alias "new"',
    );
  });

  it("rejects paths that disagree with the command tree", () => {
    const registry = cloneRegistry();
    const clean = registry.root.children.find((node) => node.name === "clean");
    if (!clean) throw new Error("Expected clean command");
    clean.path = ["wrong"];

    expect(() => validateCommandRegistry(registry)).toThrow(
      "does not match wf clean",
    );
  });

  it("rejects duplicate leaf flags", () => {
    const registry = cloneRegistry();
    const workspace = registry.root.children.find(
      (node) => node.name === "workspace",
    );
    if (!workspace || workspace.kind !== "group") {
      throw new Error("Expected workspace command");
    }
    const add = workspace.children.find((node) => node.name === "add");
    if (!add || add.kind !== "leaf") throw new Error("Expected add command");
    add.flags = [
      ...add.flags,
      { name: "other", long: "--workspace", kind: "boolean" },
    ];

    expect(() => validateCommandRegistry(registry)).toThrow(
      'Duplicate flag "--workspace"',
    );
  });
});

function collectLeaves(registry: CommandRegistry) {
  const leaves: CommandLeaf[] = [];
  const visit = (node: CommandRegistry["root"]["children"][number]) => {
    if (node.kind === "leaf") {
      leaves.push(node);
      return;
    }
    if (node.default) {
      leaves.push(node.default);
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  for (const child of registry.root.children) {
    visit(child);
  }
  return leaves;
}

function cloneRegistry(): MutableCommandRegistry {
  return structuredClone(commandRegistry) as MutableCommandRegistry;
}

type MutableCommandRegistry = {
  -readonly [Key in keyof CommandRegistry]: Mutable<CommandRegistry[Key]>;
};

type Mutable<Value> = Value extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : Value extends object
    ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
    : Value;
