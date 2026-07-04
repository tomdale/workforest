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
      new: null,
      adopt: null,
      list: null,
      status: null,
      add: null,
      switch: null,
      delete: null,
      init: ["logs", "retry", "cancel"],
      ai: ["status"],
      migrate: ["workspaces"],
      task: ["new", "list", "delete"],
      cloud: ["list", "status", "attach", "stop", "delete"],
      cache: ["list", "show", "sync", "doctor", "delete", "clean", "worktree"],
      review: null,
      template: [
        "list",
        "open",
        "show",
        "suggest",
        "new",
        "edit",
        "variant",
        "add-file",
        "agents-md",
        "copy",
        "delete",
      ],
      shell: ["init"],
      config: ["show", "init", "edit"],
      skills: ["list", "get"],
      help: ["concepts", "workflow", "templates"],
      version: null,
    });
  });

  it("defines only the published root shortcuts", () => {
    expect(commandRegistry.shortcuts.map((shortcut) => shortcut.name)).toEqual(
      [],
    );
    expect(
      collectNodes(commandRegistry.root).flatMap((node) => node.aliases),
    ).toEqual([]);
  });

  it("uses explicit resource leaves without contextual defaults", () => {
    for (const name of ["migrate", "task", "template", "shell", "cache"]) {
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
    }
  });

  it("accepts the production registry", () => {
    expect(() => validateCommandRegistry(commandRegistry)).not.toThrow();
  });

  it("rejects shortcut collisions and unknown targets", () => {
    const collision = cloneRegistry();
    collision.shortcuts.push({
      name: "cache",
      target: ["start"],
      visibility: "visible",
      summary: "Synthetic shortcut",
      help: { kind: "command", command: "cache" },
    });
    expect(() => validateCommandRegistry(collision)).toThrow(
      'Duplicate command or alias "cache"',
    );

    const unknownTarget = cloneRegistry();
    unknownTarget.shortcuts.push({
      name: "missing-target",
      target: ["missing"],
      visibility: "visible",
      summary: "Synthetic shortcut",
      help: { kind: "command", command: "missing-target" },
    });
    expect(() => validateCommandRegistry(unknownTarget)).toThrow(
      "targets unknown command wf missing",
    );
  });

  it("rejects paths that disagree with the command tree", () => {
    const registry = cloneRegistry();
    findMutableNode(registry.root, ["cache", "list"]).path = ["wrong"];

    expect(() => validateCommandRegistry(registry)).toThrow(
      "does not match wf cache list",
    );
  });

  it("rejects duplicate leaf flags", () => {
    const registry = cloneRegistry();
    const add = findMutableNode(registry.root, ["add"]);
    if (add.kind !== "leaf") throw new Error("Expected add command");
    add.flags = [
      ...add.flags,
      { name: "other", long: "--yes", kind: "boolean" },
    ];

    expect(() => validateCommandRegistry(registry)).toThrow(
      'Duplicate flag "--yes"',
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
