import { describe, expect, it } from "vitest";
import { commandRegistry, validateCommandRegistry } from "./commands.ts";
import type {
  CommandGroup,
  CommandLeaf,
  CommandNode,
  CommandRegistry,
} from "./types.ts";

describe("commandRegistry", () => {
  it("defines the exact visible command tree", () => {
    expect(visibleTree(commandRegistry.root)).toEqual({
      start: null,
      list: null,
      status: null,
      add: null,
      switch: null,
      workspace: ["create", "delete", "open", "list", "status", "add"],
      task: ["create", "list", "delete"],
      worktree: ["create", "list", "delete"],
      cache: [
        "list",
        "info",
        "path",
        "add",
        "update",
        "doctor",
        "repair",
        "delete",
        "prune",
        "manage",
      ],
      review: ["open", "checkout"],
      template: [
        "list",
        "open",
        "show",
        "manage",
        "new",
        "edit",
        "add-file",
        "copy",
        "delete",
      ],
      shell: ["init"],
      config: ["show", "init", "edit"],
      skills: ["list", "get", "path"],
      help: ["concepts", "workflow"],
      version: null,
    });
  });

  it("defines only the published root shortcuts", () => {
    expect(commandRegistry.shortcuts).toEqual([
      expect.objectContaining({
        name: "new",
        target: ["workspace", "create"],
      }),
      expect.objectContaining({
        name: "clean",
        target: ["workspace", "delete"],
      }),
    ]);
    expect(
      collectNodes(commandRegistry.root).flatMap((node) => node.aliases),
    ).toEqual([]);
  });

  it("uses explicit resource leaves without contextual defaults", () => {
    for (const name of [
      "workspace",
      "task",
      "worktree",
      "cache",
      "review",
      "template",
      "shell",
    ]) {
      expect(findGroup(commandRegistry.root, name).default).toBeUndefined();
    }
    expect(findGroup(commandRegistry.root, "config").default?.handler).toBe(
      "config.show",
    );
    expect(findGroup(commandRegistry.root, "skills").default?.handler).toBe(
      "skills.list",
    );
    expect(findGroup(commandRegistry.root, "help").default?.handler).toBe(
      "help",
    );
  });

  it("defines complete metadata for every leaf", () => {
    for (const leaf of collectLeaves(commandRegistry)) {
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

  it("rejects shortcut collisions and unknown targets", () => {
    const collision = cloneRegistry();
    firstShortcut(collision).name = "workspace";
    expect(() => validateCommandRegistry(collision)).toThrow(
      'Duplicate command or alias "workspace"',
    );

    const unknownTarget = cloneRegistry();
    firstShortcut(unknownTarget).target = ["workspace", "missing"];
    expect(() => validateCommandRegistry(unknownTarget)).toThrow(
      "targets unknown command wf workspace missing",
    );
  });

  it("rejects paths that disagree with the command tree", () => {
    const registry = cloneRegistry();
    findMutableNode(registry.root, ["workspace", "list"]).path = ["wrong"];

    expect(() => validateCommandRegistry(registry)).toThrow(
      "does not match wf workspace list",
    );
  });

  it("rejects duplicate leaf flags", () => {
    const registry = cloneRegistry();
    const add = findMutableNode(registry.root, ["workspace", "add"]);
    if (add.kind !== "leaf") throw new Error("Expected add command");
    add.flags = [
      ...add.flags,
      { name: "other", long: "--workspace", kind: "boolean" },
    ];

    expect(() => validateCommandRegistry(registry)).toThrow(
      'Duplicate flag "--workspace"',
    );
  });
});

function visibleTree(root: CommandGroup) {
  return Object.fromEntries(
    root.children
      .filter((node) => node.visibility === "visible")
      .map((node) => [
        node.name,
        node.kind === "group"
          ? node.children
              .filter((child) => child.visibility === "visible")
              .map((child) => child.name)
          : null,
      ]),
  );
}

function findGroup(root: CommandGroup, name: string): CommandGroup {
  const node = root.children.find((child) => child.name === name);
  if (!node || node.kind !== "group") {
    throw new Error(`Expected ${name} group`);
  }
  return node;
}

function collectNodes(root: CommandGroup): CommandNode[] {
  const nodes: CommandNode[] = [];
  const visit = (node: CommandNode) => {
    nodes.push(node);
    if (node.kind === "group") {
      node.children.forEach(visit);
    }
  };
  root.children.forEach(visit);
  return nodes;
}

function collectLeaves(registry: CommandRegistry) {
  const leaves: CommandLeaf[] = [];
  const visit = (node: CommandNode) => {
    if (node.kind === "leaf") {
      leaves.push(node);
      return;
    }
    if (node.default) {
      leaves.push(node.default);
    }
    node.children.forEach(visit);
  };
  registry.root.children.forEach(visit);
  return leaves;
}

function cloneRegistry(): MutableCommandRegistry {
  return structuredClone(commandRegistry) as MutableCommandRegistry;
}

function firstShortcut(registry: MutableCommandRegistry) {
  const shortcut = registry.shortcuts[0];
  if (!shortcut) {
    throw new Error("Expected a root shortcut");
  }
  return shortcut;
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

type MutableCommandRegistry = Mutable<CommandRegistry>;

type Mutable<Value> = Value extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : Value extends object
    ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
    : Value;
