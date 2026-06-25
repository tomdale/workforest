# Environment Variable Reference

<!-- Generated from the executable registry. Do not edit directly. -->

## User Variables

These variables are supported inputs for configuring normal CLI behavior.

### `WORKFOREST_CONFIG_DIR`

Value: directory path.

Stores config.json in this directory and bypasses the normal XDG and legacy path selection.

When unset: Uses $XDG_CONFIG_HOME/workforest/config.json when XDG_CONFIG_HOME is set, otherwise ~/.workforest/config.json.

### `WORKFOREST_CACHE_DIR`

Value: directory path.

Stores cached bare repository mirrors in this directory.

When unset: Uses $XDG_CACHE_HOME/workforest, or ~/.cache/workforest when XDG_CACHE_HOME is unset.

### `WORKFOREST_SKILLS_DIR`

Value: directory path.

Loads skills exclusively from this directory instead of discovering the packaged skill-data directory.

When unset: Discovers the skill-data directory beside the installed package.

### `WORKFOREST_NO_TUI`

Value: non-empty value.

Disables fullscreen and grid terminal interfaces and uses their non-TUI fallbacks.

When unset: TUI surfaces are enabled when the terminal supports them and CI is not set.

### `WORKFOREST_AI_PROVIDER`

Value: provider id.

Selects the AI provider for AI-backed Workforest features, overriding ai.provider in config.

When unset: Uses ai.provider from config, or auto-detects available providers.

### `WORKFOREST_AI_MODEL`

Value: model name.

Selects the model passed to the chosen AI provider, overriding ai.model in config.

When unset: Uses ai.model from config, or the provider default.

### `WORKFOREST_AI_TIMEOUT_MS`

Value: positive integer milliseconds.

Sets the timeout for a single AI generation, overriding ai.timeoutMs in config.

When unset: Uses ai.timeoutMs from config, or 120000.

### `WORKFOREST_AI_DISABLED`

Value: true/false.

Disables AI-backed Workforest features, overriding ai.disabled in config.

When unset: Uses ai.disabled from config, or false.

### `XDG_CONFIG_HOME`

Value: directory path.

Selects the XDG config root for Workforest configuration and templates.

When unset: Configuration uses ~/.workforest/config.json; templates use ~/.config/workforest/templates.

### `XDG_CACHE_HOME`

Value: directory path.

Selects the XDG cache root for repository mirrors.

When unset: Uses ~/.cache.

### `SHELL`

Value: executable path.

Selects the shell when shell initialization is requested without an explicit shell name.

When unset: Shell detection fails when no supported shell is specified.

### `EDITOR`

Value: command.

Selects the editor used by config and template editing.

When unset: Uses VISUAL, then vi.

### `VISUAL`

Value: command.

Selects the editor when EDITOR is unset.

When unset: Uses vi.

### `CI`

Value: non-empty value.

Disables terminal interfaces that require an interactive display.

When unset: Interactive terminal capability is detected normally.

## Shell Integration Variables

Generated shell integration manages these variables. They are documented for wrapper authors and debugging.

### `WORKFOREST_CD_PATH_FILE`

Value: file path.

Receives a requested working directory from the CLI for the generated shell wrapper to apply.

When unset: Commands cannot hand a directory change back to the parent shell.

## Internal Variables

These variables support diagnostics and are not part of the normal CLI configuration surface.

### `WORKFOREST_TIMING_FILE`

Value: file path.

Provides an optional timing output path to instrumentation that calls getTimingFilePath().

When unset: Timing instrumentation has no output file.
