import { commandFlags } from "../cli/effective-flags.ts";
import type {
  CommandGroup,
  CommandLeaf,
  CommandNode,
  CommandRegistry,
  FlagDefinition,
} from "../cli/types.ts";

export type ShellCompletionCommand = Readonly<{
  name: string;
  summary: string;
  canonicalPath: readonly string[];
  flags: readonly FlagDefinition[];
  children: readonly ShellCompletionCommand[];
}>;

export type ShellCommandModel = Readonly<{
  commands: readonly ShellCompletionCommand[];
}>;

export function createShellCommandModel(
  registry: CommandRegistry,
): ShellCommandModel {
  const commands = [
    ...registry.shortcuts
      .filter((shortcut) => shortcut.visibility === "visible")
      .map((shortcut) => {
        const target = findLeaf(registry.root, shortcut.target);
        if (!target) {
          throw new Error(
            `Shell shortcut ${shortcut.name} targets an unknown command.`,
          );
        }

        return completionCommand(shortcut.name, shortcut.summary, target);
      }),
    ...visibleInvocations(registry.root.children),
  ];

  return { commands };
}

function visibleInvocations(
  nodes: readonly CommandNode[],
): ShellCompletionCommand[] {
  return nodes.flatMap((node) => {
    if (node.visibility !== "visible") {
      return [];
    }

    return [
      completionCommand(node.name, node.summary, node),
      ...node.aliases
        .filter((alias) => alias.visibility === "visible")
        .map((alias) => completionCommand(alias.name, node.summary, node)),
    ];
  });
}

function completionCommand(
  name: string,
  summary: string,
  node: CommandNode,
): ShellCompletionCommand {
  if (node.kind === "leaf") {
    return {
      name,
      summary,
      canonicalPath: node.path,
      flags: commandFlags(node),
      children: [],
    };
  }

  return {
    name,
    summary,
    canonicalPath: node.path,
    flags: node.default ? commandFlags(node.default) : [],
    children: visibleInvocations(node.children),
  };
}

function findLeaf(
  root: CommandGroup,
  path: readonly string[],
): CommandLeaf | undefined {
  let node: CommandNode = root;

  for (const segment of path) {
    if (node.kind !== "group") {
      return undefined;
    }

    const child: CommandNode | undefined = node.children.find(
      (candidate) => candidate.name === segment,
    );
    if (!child) {
      return undefined;
    }
    node = child;
  }

  return node.kind === "leaf" ? node : node.default;
}
