import { commandFlags } from "../cli/effective-flags.ts";
import type {
  CommandGroup,
  CommandLeaf,
  CommandNode,
  CommandRegistry,
  CommandShortcut,
  FlagDefinition,
} from "../cli/types.ts";
import type { InventoryEntry } from "../workspace/inventory.ts";

export type ShellCompletionOptions = Readonly<{
  selectorCandidates?: () => Promise<readonly string[]>;
}>;

export async function shellCompletionCandidates(
  registry: CommandRegistry,
  cursorIndex: number,
  words: readonly string[],
  options: ShellCompletionOptions = {},
): Promise<readonly string[]> {
  if (!Number.isInteger(cursorIndex) || cursorIndex < 0) {
    return [];
  }

  const paddedWords = [...words];
  while (paddedWords.length <= cursorIndex) {
    paddedWords.push("");
  }

  const current = paddedWords[cursorIndex] ?? "";
  const previous = paddedWords.slice(0, cursorIndex);
  const context = resolveCompletionContext(registry, previous);

  switch (context.kind) {
    case "root":
      return matchingCandidates(rootCandidates(registry), current);
    case "group":
      return matchingCandidates(groupCandidates(context.group), current);
    case "leaf":
      return matchingCandidates(
        await leafCandidates(context.leaf, context.args, current, options),
        current,
      );
    case "none":
      return [];
  }
}

export function selectorCandidateWords(
  entries: readonly InventoryEntry[],
): readonly string[] {
  const changeCounts = new Map<string, number>();
  for (const entry of entries) {
    changeCounts.set(
      entry.changeName,
      (changeCounts.get(entry.changeName) ?? 0) + 1,
    );
  }

  return uniqueSorted([
    ...entries.map((entry) => entry.selector),
    ...entries
      .filter((entry) => changeCounts.get(entry.changeName) === 1)
      .map((entry) => entry.changeName),
  ]);
}

type CompletionContext =
  | Readonly<{ kind: "root" }>
  | Readonly<{ kind: "group"; group: CommandGroup }>
  | Readonly<{ kind: "leaf"; leaf: CommandLeaf; args: readonly string[] }>
  | Readonly<{ kind: "none" }>;

function resolveCompletionContext(
  registry: CommandRegistry,
  previous: readonly string[],
): CompletionContext {
  const shortcut = resolveShortcut(registry, previous);
  if (shortcut) {
    return shortcut;
  }

  if (previous.length === 0) {
    return { kind: "root" };
  }

  let node: CommandNode = registry.root;
  let index = 0;

  while (node.kind === "group") {
    const token = previous[index];
    if (token === undefined) {
      return { kind: "group", group: node };
    }

    const child = findVisibleChild(node, token);
    if (child) {
      node = child;
      index += 1;
      continue;
    }

    if (node.default) {
      return { kind: "leaf", leaf: node.default, args: previous.slice(index) };
    }

    return { kind: "none" };
  }

  return { kind: "leaf", leaf: node, args: previous.slice(index) };
}

function resolveShortcut(
  registry: CommandRegistry,
  previous: readonly string[],
): CompletionContext | null {
  const name = previous[0];
  if (name === undefined) {
    return null;
  }

  const shortcut = registry.shortcuts.find(
    (candidate) =>
      candidate.visibility === "visible" && candidate.name === name,
  );
  if (!shortcut) {
    return null;
  }

  const leaf = findShortcutLeaf(registry.root, shortcut);
  if (!leaf) {
    return { kind: "none" };
  }
  return { kind: "leaf", leaf, args: previous.slice(1) };
}

function rootCandidates(registry: CommandRegistry): readonly string[] {
  return uniqueSorted([
    ...registry.shortcuts
      .filter((shortcut) => shortcut.visibility === "visible")
      .map((shortcut) => shortcut.name),
    ...visibleInvocationNames(registry.root.children),
  ]);
}

function groupCandidates(group: CommandGroup): readonly string[] {
  return uniqueSorted([
    ...visibleInvocationNames(group.children),
    ...(group.default ? flagWords(commandFlags(group.default)) : []),
  ]);
}

async function leafCandidates(
  leaf: CommandLeaf,
  args: readonly string[],
  current: string,
  options: ShellCompletionOptions,
): Promise<readonly string[]> {
  const flags = commandFlags(leaf);
  const parsed = parseCompletionArgs(flags, args);
  if (parsed.expectingFlagValue) {
    return [];
  }

  const candidates: string[] = [];
  if (current === "" || current.startsWith("-")) {
    candidates.push(...flagWords(flags));
  }

  if (
    !current.startsWith("-") &&
    operandCompletionKind(leaf) === "selector" &&
    parsed.beforeDoubleDashCount < maxBeforeDoubleDashOperands(leaf) &&
    !parsed.hadDoubleDash
  ) {
    candidates.push(...((await options.selectorCandidates?.()) ?? []));
  }

  return uniqueSorted(candidates);
}

function parseCompletionArgs(
  flags: readonly FlagDefinition[],
  args: readonly string[],
): Readonly<{
  beforeDoubleDashCount: number;
  hadDoubleDash: boolean;
  expectingFlagValue: boolean;
}> {
  const byToken = flagTokenMap(flags);
  let beforeDoubleDashCount = 0;
  let hadDoubleDash = false;
  let expectingFlagValue = false;

  for (const arg of args) {
    if (expectingFlagValue) {
      expectingFlagValue = false;
      continue;
    }

    if (!hadDoubleDash && arg === "--") {
      hadDoubleDash = true;
      continue;
    }

    if (!hadDoubleDash && arg.startsWith("-")) {
      const [flagToken, inlineValue] = splitFlagToken(arg);
      const flag = byToken.get(flagToken);
      if (flag?.kind === "string" && inlineValue === undefined) {
        expectingFlagValue = true;
      }
      continue;
    }

    if (!hadDoubleDash) {
      beforeDoubleDashCount += 1;
    }
  }

  return { beforeDoubleDashCount, hadDoubleDash, expectingFlagValue };
}

function operandCompletionKind(leaf: CommandLeaf): "selector" | null {
  return leaf.operands.variants.some(
    (variant) => variant.beforeDoubleDash.label === "selector",
  )
    ? "selector"
    : null;
}

function maxBeforeDoubleDashOperands(leaf: CommandLeaf): number {
  return Math.max(
    0,
    ...leaf.operands.variants.map(
      (variant) => variant.beforeDoubleDash.max ?? Number.POSITIVE_INFINITY,
    ),
  );
}

function visibleInvocationNames(
  nodes: readonly CommandNode[],
): readonly string[] {
  return nodes.flatMap((node) => {
    if (node.visibility !== "visible") {
      return [];
    }
    return [
      node.name,
      ...node.aliases
        .filter((alias) => alias.visibility === "visible")
        .map((alias) => alias.name),
    ];
  });
}

function findVisibleChild(
  group: CommandGroup,
  token: string,
): CommandNode | null {
  for (const child of group.children) {
    if (child.visibility !== "visible") {
      continue;
    }
    if (child.name === token) {
      return child;
    }
    if (
      child.aliases.some(
        (alias) => alias.visibility === "visible" && alias.name === token,
      )
    ) {
      return child;
    }
  }
  return null;
}

function findShortcutLeaf(
  root: CommandGroup,
  shortcut: CommandShortcut,
): CommandLeaf | null {
  let node: CommandNode = root;
  for (const segment of shortcut.target) {
    if (node.kind !== "group") {
      return null;
    }
    const child: CommandNode | undefined = node.children.find(
      (candidate) => candidate.name === segment,
    );
    if (!child) {
      return null;
    }
    node = child;
  }
  return node.kind === "leaf" ? node : (node.default ?? null);
}

function flagWords(flags: readonly FlagDefinition[]): readonly string[] {
  return flags.flatMap((flag) =>
    flag.short ? [flag.short, flag.long] : [flag.long],
  );
}

function flagTokenMap(
  flags: readonly FlagDefinition[],
): Map<string, FlagDefinition> {
  const byToken = new Map<string, FlagDefinition>();
  for (const flag of flags) {
    byToken.set(flag.long, flag);
    if (flag.short) {
      byToken.set(flag.short, flag);
    }
  }
  return byToken;
}

function splitFlagToken(token: string): [string, string | undefined] {
  if (!token.startsWith("--")) {
    return [token, undefined];
  }
  const equalsIndex = token.indexOf("=");
  return equalsIndex === -1
    ? [token, undefined]
    : [token.slice(0, equalsIndex), token.slice(equalsIndex + 1)];
}

function matchingCandidates(
  candidates: readonly string[],
  current: string,
): readonly string[] {
  return candidates.filter((candidate) => candidate.startsWith(current));
}

function uniqueSorted(candidates: readonly string[]): readonly string[] {
  return [...new Set(candidates)].sort((left, right) =>
    left.localeCompare(right),
  );
}
