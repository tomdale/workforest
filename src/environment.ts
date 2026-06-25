export type EnvironmentVariableAudience = "user" | "integration" | "internal";

export type EnvironmentVariableDefinition = Readonly<{
  name: string;
  value: string;
  audience: EnvironmentVariableAudience;
  description: string;
  defaultBehavior: string;
}>;

export const WORKFOREST_ENVIRONMENT_VARIABLES = {
  aiDisabled: "WORKFOREST_AI_DISABLED",
  aiModel: "WORKFOREST_AI_MODEL",
  aiProvider: "WORKFOREST_AI_PROVIDER",
  aiTimeoutMs: "WORKFOREST_AI_TIMEOUT_MS",
  cacheDir: "WORKFOREST_CACHE_DIR",
  cdPathFile: "WORKFOREST_CD_PATH_FILE",
  configDir: "WORKFOREST_CONFIG_DIR",
  noTui: "WORKFOREST_NO_TUI",
  skillsDir: "WORKFOREST_SKILLS_DIR",
  timingFile: "WORKFOREST_TIMING_FILE",
} as const;

export const STANDARD_ENVIRONMENT_VARIABLES = {
  ci: "CI",
  editor: "EDITOR",
  shell: "SHELL",
  visual: "VISUAL",
  xdgCacheHome: "XDG_CACHE_HOME",
  xdgConfigHome: "XDG_CONFIG_HOME",
} as const;

export type EnvironmentVariableName =
  | (typeof WORKFOREST_ENVIRONMENT_VARIABLES)[keyof typeof WORKFOREST_ENVIRONMENT_VARIABLES]
  | (typeof STANDARD_ENVIRONMENT_VARIABLES)[keyof typeof STANDARD_ENVIRONMENT_VARIABLES];

/*
 * Runtime environment inputs and their user-facing semantics. Consumers read
 * through the helpers below so documentation and executable names stay tied
 * to the same definitions.
 */
export const ENVIRONMENT_VARIABLE_REGISTRY: readonly EnvironmentVariableDefinition[] =
  [
    {
      name: WORKFOREST_ENVIRONMENT_VARIABLES.configDir,
      value: "directory path",
      audience: "user",
      description:
        "Stores config.json in this directory and bypasses the normal XDG and legacy path selection.",
      defaultBehavior:
        "Uses $XDG_CONFIG_HOME/workforest/config.json when XDG_CONFIG_HOME is set, otherwise ~/.workforest/config.json.",
    },
    {
      name: WORKFOREST_ENVIRONMENT_VARIABLES.cacheDir,
      value: "directory path",
      audience: "user",
      description: "Stores cached bare repository mirrors in this directory.",
      defaultBehavior:
        "Uses $XDG_CACHE_HOME/workforest, or ~/.cache/workforest when XDG_CACHE_HOME is unset.",
    },
    {
      name: WORKFOREST_ENVIRONMENT_VARIABLES.skillsDir,
      value: "directory path",
      audience: "user",
      description:
        "Loads skills exclusively from this directory instead of discovering the packaged skill-data directory.",
      defaultBehavior:
        "Discovers the skill-data directory beside the installed package.",
    },
    {
      name: WORKFOREST_ENVIRONMENT_VARIABLES.noTui,
      value: "non-empty value",
      audience: "user",
      description:
        "Disables fullscreen and grid terminal interfaces and uses their non-TUI fallbacks.",
      defaultBehavior:
        "TUI surfaces are enabled when the terminal supports them and CI is not set.",
    },
    {
      name: WORKFOREST_ENVIRONMENT_VARIABLES.aiProvider,
      value: "provider id",
      audience: "user",
      description:
        "Selects the AI provider for AI-backed Workforest features, overriding ai.provider in config.",
      defaultBehavior:
        "Uses ai.provider from config, or auto-detects available providers.",
    },
    {
      name: WORKFOREST_ENVIRONMENT_VARIABLES.aiModel,
      value: "model name",
      audience: "user",
      description:
        "Selects the model passed to the chosen AI provider, overriding ai.model in config.",
      defaultBehavior: "Uses ai.model from config, or the provider default.",
    },
    {
      name: WORKFOREST_ENVIRONMENT_VARIABLES.aiTimeoutMs,
      value: "positive integer milliseconds",
      audience: "user",
      description:
        "Sets the timeout for a single AI generation, overriding ai.timeoutMs in config.",
      defaultBehavior: "Uses ai.timeoutMs from config, or 120000.",
    },
    {
      name: WORKFOREST_ENVIRONMENT_VARIABLES.aiDisabled,
      value: "true/false",
      audience: "user",
      description:
        "Disables AI-backed Workforest features, overriding ai.disabled in config.",
      defaultBehavior: "Uses ai.disabled from config, or false.",
    },
    {
      name: WORKFOREST_ENVIRONMENT_VARIABLES.timingFile,
      value: "file path",
      audience: "internal",
      description:
        "Provides an optional timing output path to instrumentation that calls getTimingFilePath().",
      defaultBehavior: "Timing instrumentation has no output file.",
    },
    {
      name: WORKFOREST_ENVIRONMENT_VARIABLES.cdPathFile,
      value: "file path",
      audience: "integration",
      description:
        "Receives a requested working directory from the CLI for the generated shell wrapper to apply.",
      defaultBehavior:
        "Commands cannot hand a directory change back to the parent shell.",
    },
    {
      name: STANDARD_ENVIRONMENT_VARIABLES.xdgConfigHome,
      value: "directory path",
      audience: "user",
      description:
        "Selects the XDG config root for Workforest configuration and templates.",
      defaultBehavior:
        "Configuration uses ~/.workforest/config.json; templates use ~/.config/workforest/templates.",
    },
    {
      name: STANDARD_ENVIRONMENT_VARIABLES.xdgCacheHome,
      value: "directory path",
      audience: "user",
      description: "Selects the XDG cache root for repository mirrors.",
      defaultBehavior: "Uses ~/.cache.",
    },
    {
      name: STANDARD_ENVIRONMENT_VARIABLES.shell,
      value: "executable path",
      audience: "user",
      description:
        "Selects the shell when shell initialization is requested without an explicit shell name.",
      defaultBehavior:
        "Shell detection fails when no supported shell is specified.",
    },
    {
      name: STANDARD_ENVIRONMENT_VARIABLES.editor,
      value: "command",
      audience: "user",
      description: "Selects the editor used by config and template editing.",
      defaultBehavior: "Uses VISUAL, then vi.",
    },
    {
      name: STANDARD_ENVIRONMENT_VARIABLES.visual,
      value: "command",
      audience: "user",
      description: "Selects the editor when EDITOR is unset.",
      defaultBehavior: "Uses vi.",
    },
    {
      name: STANDARD_ENVIRONMENT_VARIABLES.ci,
      value: "non-empty value",
      audience: "user",
      description:
        "Disables terminal interfaces that require an interactive display.",
      defaultBehavior: "Interactive terminal capability is detected normally.",
    },
  ] as const;

export function readEnvironmentVariable(
  name: EnvironmentVariableName,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return environment[name];
}

export function isEnvironmentVariableSet(
  name: EnvironmentVariableName,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(readEnvironmentVariable(name, environment));
}
