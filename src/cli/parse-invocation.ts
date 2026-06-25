import { UsageError } from "./errors.ts";
import type {
  Cardinality,
  FlagDefinition,
  InvocationContext,
  OperandVariant,
  ParsedInvocation,
  ResolvedCommand,
} from "./types.ts";

const HELP_FLAGS = new Set(["--help", "-h"]);
const GLOBAL_FLAGS: readonly FlagDefinition[] = [
  {
    name: "json",
    long: "--json",
    kind: "boolean",
    description: "Emit a machine-readable JSON envelope.",
  },
];

export function parseInvocation(
  command: ResolvedCommand,
  context: InvocationContext = { interactive: false },
): ParsedInvocation {
  const byToken = buildFlagTokenMap([...GLOBAL_FLAGS, ...command.leaf.flags]);
  const flags: Record<string, boolean | string | undefined> = {};
  const beforeDoubleDash: string[] = [];
  const afterDoubleDash: string[] = [];
  let hadDoubleDash = false;
  let helpRequested = false;

  for (let index = 0; index < command.argv.length; index += 1) {
    const token = command.argv[index];
    if (token === undefined) {
      continue;
    }

    if (hadDoubleDash) {
      afterDoubleDash.push(token);
      continue;
    }

    if (token === "--") {
      hadDoubleDash = true;
      continue;
    }

    if (HELP_FLAGS.has(token)) {
      if (helpRequested) {
        throw new UsageError(`Flag "${token}" may only be specified once.`);
      }
      helpRequested = true;
      continue;
    }

    if (token.startsWith("-")) {
      const [flagToken, inlineValue] = splitFlagToken(token);
      const flag = byToken.get(flagToken);
      if (!flag) {
        throw new UsageError(
          `Unknown flag "${flagToken}" for ${formatCommand(command.canonicalPath)}.`,
        );
      }
      if (flags[flag.name] !== undefined) {
        throw new UsageError(`Flag "${flag.long}" may only be specified once.`);
      }

      if (flag.kind === "boolean") {
        if (inlineValue !== undefined) {
          throw new UsageError(`Flag "${flag.long}" does not take a value.`);
        }
        flags[flag.name] = true;
        continue;
      }

      const value = inlineValue ?? command.argv[index + 1];
      if (
        value === undefined ||
        (inlineValue === undefined && value.startsWith("-"))
      ) {
        throw new UsageError(
          `Flag "${flag.long}" requires ${flag.valueName ?? "a value"}.`,
        );
      }
      if (inlineValue === undefined) {
        index += 1;
      }
      flags[flag.name] = value;
      continue;
    }

    beforeDoubleDash.push(token);
  }

  for (const flag of command.leaf.flags) {
    if (flag.required && flags[flag.name] === undefined) {
      throw new UsageError(`Missing required flag "${flag.long}".`);
    }
  }

  if (!helpRequested) {
    enforceOperandVariants(
      command,
      flags,
      context,
      beforeDoubleDash,
      afterDoubleDash,
      hadDoubleDash,
    );
  }

  return {
    command,
    flags,
    beforeDoubleDash,
    afterDoubleDash,
    hadDoubleDash,
    helpRequested,
  };
}

function buildFlagTokenMap(
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

function enforceOperandVariants(
  command: ResolvedCommand,
  flags: Readonly<Record<string, boolean | string | undefined>>,
  context: InvocationContext,
  before: readonly string[],
  after: readonly string[],
  hadDoubleDash: boolean,
): void {
  const matchingCondition = command.leaf.operands.variants.filter((variant) =>
    conditionMatches(variant, flags, context),
  );
  const matched = matchingCondition.some((variant) =>
    operandVariantMatches(variant, before, after, hadDoubleDash),
  );
  if (matched) {
    return;
  }

  const commandName = formatCommand(command.canonicalPath);
  const expected = matchingCondition.map(formatOperandVariant).join(" or ");
  throw new UsageError(
    `Invalid operands for ${commandName}. Expected ${expected || "a supported invocation"}.`,
  );
}

function conditionMatches(
  variant: OperandVariant,
  flags: Readonly<Record<string, boolean | string | undefined>>,
  context: InvocationContext,
): boolean {
  if (!variant.when) {
    return true;
  }
  const flagMatches =
    variant.when.flag === undefined ||
    (flags[variant.when.flag] !== undefined) === variant.when.present;
  const ttyMatches =
    variant.when.interactive === undefined ||
    variant.when.interactive === context.interactive;
  return flagMatches && ttyMatches;
}

function operandVariantMatches(
  variant: OperandVariant,
  before: readonly string[],
  after: readonly string[],
  hadDoubleDash: boolean,
): boolean {
  if (variant.delimiter === "required" && !hadDoubleDash) {
    return false;
  }
  if (variant.delimiter === "forbidden" && hadDoubleDash) {
    return false;
  }
  return (
    cardinalityMatches(variant.beforeDoubleDash, before.length) &&
    (variant.afterDoubleDash
      ? cardinalityMatches(variant.afterDoubleDash, after.length)
      : after.length === 0)
  );
}

function cardinalityMatches(cardinality: Cardinality, count: number): boolean {
  return (
    count >= cardinality.min &&
    (cardinality.max === null || count <= cardinality.max)
  );
}

function formatOperandVariant(variant: OperandVariant): string {
  const before = formatCardinality(variant.beforeDoubleDash);
  if (variant.delimiter === "required" && variant.afterDoubleDash) {
    return `${before} -- ${formatCardinality(variant.afterDoubleDash)}`;
  }
  return before;
}

function formatCardinality(cardinality: Cardinality): string {
  if (cardinality.min === cardinality.max) {
    return cardinality.min === 0
      ? "no operands"
      : `${cardinality.min} ${cardinality.label}`;
  }
  if (cardinality.max === null) {
    return `${cardinality.min} or more ${cardinality.label}`;
  }
  return `${cardinality.min}-${cardinality.max} ${cardinality.label}`;
}

function formatCommand(path: readonly string[]): string {
  return `wf ${path.join(" ")}`;
}
