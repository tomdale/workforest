import {
  CONFIGURATION_EXAMPLE,
  CONFIGURATION_REGISTRY,
} from "./configuration-registry.ts";
import {
  ENVIRONMENT_VARIABLE_REGISTRY,
  type EnvironmentVariableAudience,
} from "./environment.ts";

const GENERATED_NOTICE =
  "<!-- Generated from the executable registry. Do not edit directly. -->";

export const CONFIGURATION_REFERENCE_PATH =
  "skill-data/setup-and-configuration/references/configuration.md";
export const ENVIRONMENT_REFERENCE_PATH =
  "skill-data/setup-and-configuration/references/environment-variables.md";

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
