import { UsageError } from "./errors.ts";
import type {
  AliasDefinition,
  CommandGroup,
  CommandNode,
  CommandPath,
  CommandRegistry,
  CommandResolution,
  CommandShortcut,
  HelpReference,
  ResolvedCommand,
} from "./types.ts";

const HELP_FLAGS = new Set(["--help", "-h"]);

export function resolveCommand(
  registry: CommandRegistry,
  argv: readonly string[],
): CommandResolution {
  if (argv.length === 0) {
    return helpResolution(registry.root, [], registry.root.help);
  }

  const shortcut = registry.shortcuts.find(
    (candidate) => candidate.name === argv[0],
  );
  if (shortcut) {
    return resolveShortcut(registry, shortcut, argv.slice(1));
  }

  let node: CommandNode = registry.root;
  let index = 0;
  const invokedPath: string[] = [];
  let aliasHelp: HelpReference | undefined;

  while (node.kind === "group") {
    const token = argv[index];
    if (token === undefined) {
      if (node.default) {
        return resolvedDefault(node, invokedPath, [], aliasHelp);
      }
      return helpResolution(node, invokedPath, aliasHelp ?? node.help);
    }

    if (HELP_FLAGS.has(token)) {
      return helpResolution(node, invokedPath, aliasHelp ?? node.help);
    }

    const match = findChild(node, token);
    if (match) {
      node = match.node;
      invokedPath.push(token);
      index += 1;
      aliasHelp = match.alias?.help;
      continue;
    }

    throw unknownCommandError(node.path, token);
  }

  if (HELP_FLAGS.has(argv[index] ?? "")) {
    return helpResolution(node, invokedPath, aliasHelp ?? node.help);
  }

  return {
    kind: "command",
    leaf: node,
    canonicalPath: node.path,
    invokedPath,
    argv: argv.slice(index),
    help: aliasHelp ?? node.help,
  };
}

function resolvedDefault(
  group: CommandGroup,
  invokedPath: readonly string[],
  argv: readonly string[],
  aliasHelp: HelpReference | undefined,
): ResolvedCommand {
  const leaf = group.default;
  if (!leaf) {
    throw new Error(`Command group ${formatPath(group.path)} has no default.`);
  }
  return {
    kind: "command",
    leaf,
    canonicalPath: leaf.path,
    invokedPath,
    argv,
    help: aliasHelp ?? leaf.help,
  };
}

function resolveShortcut(
  registry: CommandRegistry,
  shortcut: CommandShortcut,
  argv: readonly string[],
): CommandResolution {
  const leaf = findLeaf(registry.root, shortcut.target);
  if (!leaf) {
    throw new Error(
      `Shortcut ${shortcut.name} targets unknown command ${formatPath(shortcut.target)}.`,
    );
  }
  if (HELP_FLAGS.has(argv[0] ?? "")) {
    return helpResolution(leaf, [shortcut.name], shortcut.help);
  }
  return {
    kind: "command",
    leaf,
    canonicalPath: leaf.path,
    invokedPath: [shortcut.name],
    argv,
    help: shortcut.help,
  };
}

function findLeaf(
  root: CommandGroup,
  path: CommandPath,
): ResolvedCommand["leaf"] | undefined {
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

function helpResolution(
  node: CommandNode,
  invokedPath: readonly string[],
  help: HelpReference,
): CommandResolution {
  return {
    kind: "help",
    canonicalPath: node.path,
    invokedPath,
    help,
  };
}

function findChild(
  group: CommandGroup,
  token: string,
): { node: CommandNode; alias?: AliasDefinition } | null {
  for (const child of group.children) {
    if (child.name === token) {
      return { node: child };
    }
    const alias = child.aliases.find((candidate) => candidate.name === token);
    if (alias) {
      return { node: child, alias };
    }
  }
  return null;
}

function unknownCommandError(path: CommandPath, token: string): UsageError {
  const scope =
    path.length === 0 ? "command" : `${formatPath(path)} subcommand`;
  return new UsageError(`Unknown ${scope}: ${token}`);
}

function formatPath(path: CommandPath): string {
  return path.length === 0 ? "wf" : `wf ${path.join(" ")}`;
}
