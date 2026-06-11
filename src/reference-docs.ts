import { commandRegistry } from "./cli/commands.ts";
import type {
  CommandGroup,
  CommandLeaf,
  CommandNode,
  CommandRegistry,
  CommandShortcut,
  FlagDefinition,
} from "./cli/types.ts";
import {
  CONFIGURATION_EXAMPLE,
  CONFIGURATION_REGISTRY,
} from "./configuration-registry.ts";
import {
  ENVIRONMENT_VARIABLE_REGISTRY,
  type EnvironmentVariableAudience,
} from "./environment.ts";
import { CONCEPTS, commandUsageLines, ROOT_OVERVIEW } from "./help.ts";

const GENERATED_NOTICE =
  "<!-- Generated from the executable registry. Do not edit directly. -->";

export const CONFIGURATION_REFERENCE_PATH =
  "skill-data/setup-and-configuration/references/configuration.md";
export const ENVIRONMENT_REFERENCE_PATH =
  "skill-data/setup-and-configuration/references/environment-variables.md";
export const COMMAND_REFERENCE_PATH = "skill-data/core/references/commands.md";

export function renderCommandReference(
  registry: CommandRegistry = commandRegistry,
): string {
  const commands = registry.root.children
    .filter(isVisible)
    .flatMap(renderCommandNode);
  const shortcuts = registry.shortcuts.filter(isVisible);
  const shortcutSection =
    shortcuts.length === 0
      ? []
      : [
          "## Shortcuts",
          "",
          "Shortcuts preserve the published command surface while using the same parser and handler as their canonical commands.",
          "",
          ...shortcuts.flatMap((shortcut) =>
            renderShortcut(registry, shortcut),
          ),
        ];

  return normalizeGeneratedMarkdown(
    [
      "# Workforest Command Reference",
      "",
      GENERATED_NOTICE,
      "",
      "All syntax is generated from the CLI command registry. Use `wf`; `workforest` remains an executable alias.",
      "",
      "## Concepts",
      "",
      ROOT_OVERVIEW,
      "",
      ...CONCEPTS.map(({ term, summary }) => `- **${term}** — ${summary}.`),
      "",
      "## Conventions",
      "",
      "Exit codes: `0` success, `2` usage error (invalid arguments or flags), `1` operational failure.",
      "",
      'Commands whose options include `--json` emit a machine-readable envelope: `{ "ok": true, "data": ... }` on success, or `{ "ok": false, "error": { "kind": "operational" | "usage", "message": ... } }` on failure.',
      "",
      ...commands,
      ...shortcutSection,
    ].join("\n"),
  );
}

export function renderConfigurationReference(): string {
  const fields = CONFIGURATION_REGISTRY.flatMap((field) => {
    const lines = [
      `### \`${field.key}\``,
      "",
      `Type: \`${field.type}\``,
      "",
      field.description,
      "",
      `Default: ${field.defaultBehavior}`,
    ];

    if (field.children) {
      lines.push("", "Nested fields:", "");
      for (const child of field.children) {
        lines.push(
          `- \`${field.key}.${child.key}\` (\`${child.type}\`): ${child.description} Default: ${child.defaultBehavior}`,
        );
      }
    }

    return [...lines, ""];
  });

  return [
    "# Configuration Reference",
    "",
    GENERATED_NOTICE,
    "",
    "Workforest stores global configuration as JSON in `config.json`.",
    "",
    "## File Location",
    "",
    "Configuration path selection follows this order:",
    "",
    "1. `$WORKFOREST_CONFIG_DIR/config.json` when `WORKFOREST_CONFIG_DIR` is set.",
    "2. `$XDG_CONFIG_HOME/workforest/config.json` when `XDG_CONFIG_HOME` is set. If that file does not exist but the legacy file does, Workforest reads the legacy file.",
    "3. `~/.workforest/config.json` when no override or XDG config root is set.",
    "",
    "When both the XDG and legacy files are absent, a new config uses the preferred path from the rules above.",
    "",
    "## Example",
    "",
    "```json",
    JSON.stringify(CONFIGURATION_EXAMPLE, null, 2),
    "```",
    "",
    "## Fields",
    "",
    ...fields,
    "Unknown top-level fields are ignored. String values are trimmed; blank optional paths are treated as unset.",
    "",
  ].join("\n");
}

export function renderEnvironmentReference(): string {
  const sections: Array<{
    audience: EnvironmentVariableAudience;
    title: string;
    introduction: string;
  }> = [
    {
      audience: "user",
      title: "User Variables",
      introduction:
        "These variables are supported inputs for configuring normal CLI behavior.",
    },
    {
      audience: "integration",
      title: "Shell Integration Variables",
      introduction:
        "Generated shell integration manages these variables. They are documented for wrapper authors and debugging.",
    },
    {
      audience: "internal",
      title: "Internal Variables",
      introduction:
        "These variables support diagnostics and are not part of the normal CLI configuration surface.",
    },
  ];

  const renderedSections = sections.flatMap((section) => {
    const definitions = ENVIRONMENT_VARIABLE_REGISTRY.filter(
      (definition) => definition.audience === section.audience,
    );
    const variables = definitions.flatMap((definition) => [
      `### \`${definition.name}\``,
      "",
      `Value: ${definition.value}.`,
      "",
      definition.description,
      "",
      `When unset: ${definition.defaultBehavior}`,
      "",
    ]);

    return [`## ${section.title}`, "", section.introduction, "", ...variables];
  });

  return [
    "# Environment Variable Reference",
    "",
    GENERATED_NOTICE,
    "",
    ...renderedSections,
  ].join("\n");
}

function renderCommandNode(node: CommandNode): string[] {
  if (node.kind === "leaf") {
    return renderLeaf(node, 2);
  }

  const defaultBehavior = node.default
    ? ["", `Without a subcommand: ${node.default.summary.replace(/\.$/, "")}.`]
    : [];
  const children = node.children
    .filter(isVisible)
    .flatMap((child) =>
      child.kind === "leaf" ? renderLeaf(child, 3) : renderCommandNode(child),
    );

  return [
    `## \`${formatCommand(node.path)}\``,
    "",
    `${node.summary.replace(/\.$/, "")}.`,
    ...(node.description ? ["", node.description] : []),
    "",
    "```text",
    `${formatCommand(node.path)} ${node.default ? "[subcommand]" : "<subcommand>"}`,
    "```",
    ...defaultBehavior,
    ...renderAliases(node),
    "",
    ...children,
  ];
}

function renderLeaf(leaf: CommandLeaf, headingLevel: number): string[] {
  const description = leaf.description ? [leaf.description, ""] : [];
  const argumentRows = collectOperands(leaf);
  const argumentsSection =
    argumentRows.length === 0
      ? []
      : [
          "Arguments:",
          "",
          ...argumentRows.map(
            (arg) => `- \`${arg.label}\` — ${arg.description}`,
          ),
          "",
        ];
  const options =
    leaf.flags.length === 0
      ? []
      : [
          "Options:",
          "",
          ...leaf.flags.map((flag) => {
            const reference = formatFlagReference(flag);
            return flag.description
              ? `- ${reference} — ${flag.description}`
              : `- ${reference}`;
          }),
          "",
        ];
  const examples =
    leaf.examples.length === 0
      ? []
      : [
          "Examples:",
          "",
          ...leaf.examples.map((example) =>
            example.description
              ? `- \`${example.command}\` — ${example.description}`
              : `- \`${example.command}\``,
          ),
          "",
        ];

  return [
    `${"#".repeat(headingLevel)} \`${formatCommand(leaf.path)}\``,
    "",
    `${leaf.summary.replace(/\.$/, "")}.`,
    "",
    ...description,
    "```text",
    ...commandUsageLines(leaf),
    "```",
    "",
    ...argumentsSection,
    ...options,
    ...examples,
    ...renderAliases(leaf),
    "",
  ];
}

/**
 * Distinct described operands across all variants, in first-seen order, so each
 * positional argument is documented once even when several variants share it.
 */
function collectOperands(
  leaf: CommandLeaf,
): readonly Readonly<{ label: string; description: string }>[] {
  const described = new Map<string, string>();
  for (const variant of leaf.operands.variants) {
    for (const card of [variant.beforeDoubleDash, variant.afterDoubleDash]) {
      if (card?.description && !described.has(card.label)) {
        described.set(card.label, card.description);
      }
    }
  }
  return [...described].map(([label, description]) => ({ label, description }));
}

function renderShortcut(
  registry: CommandRegistry,
  shortcut: CommandShortcut,
): string[] {
  const target = findLeaf(registry.root, shortcut.target);
  if (!target) {
    throw new Error(
      `Shortcut ${shortcut.name} targets a missing command: ${formatCommand(shortcut.target)}`,
    );
  }

  return [
    `### \`wf ${shortcut.name}\``,
    "",
    `Shortcut for \`${formatCommand(shortcut.target)}\`.`,
    "",
    "```text",
    ...commandUsageLines(target, [shortcut.name]),
    "```",
    "",
  ];
}

function renderAliases(node: CommandNode): string[] {
  const aliases = node.aliases
    .filter(isVisible)
    .map((alias) => `\`${alias.name}\``);
  return aliases.length === 0 ? [] : ["", `Aliases: ${aliases.join(", ")}.`];
}

function findLeaf(
  root: CommandGroup,
  path: readonly string[],
): CommandLeaf | null {
  let node: CommandNode = root;
  for (const segment of path) {
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

function formatFlagReference(flag: FlagDefinition): string {
  const names = [flag.short, flag.long].filter(Boolean).map((name) => {
    if (name === flag.long && flag.kind === "string") {
      return `\`${name} <${flag.valueName}>\``;
    }
    return `\`${name}\``;
  });
  return `${names.join(", ")}${flag.required ? " (required)" : ""}`;
}

function formatCommand(path: readonly string[]): string {
  return path.length === 0 ? "wf" : `wf ${path.join(" ")}`;
}

function isVisible(
  value: CommandNode | CommandShortcut | CommandNode["aliases"][number],
): boolean {
  return value.visibility === "visible";
}

function normalizeGeneratedMarkdown(value: string): string {
  return `${value.trimEnd().replace(/\n{3,}/g, "\n\n")}\n`;
}
