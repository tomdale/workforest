# Configuration Reference

<!-- Generated from the executable registry. Do not edit directly. -->

Workforest stores global configuration as JSON in `config.json`.

## File Location

Configuration path selection follows this order:

1. `$WORKFOREST_CONFIG_DIR/config.json` when `WORKFOREST_CONFIG_DIR` is set.
2. `$XDG_CONFIG_HOME/workforest/config.json` when `XDG_CONFIG_HOME` is set. If that file does not exist but the legacy file does, Workforest reads the legacy file.
3. `~/.workforest/config.json` when no override or XDG config root is set.

When both the XDG and legacy files are absent, a new config uses the preferred path from the rules above.

## Example

```json
{
  "directory": {
    "base": "~/Code",
    "repos": "Repos",
    "workspaces": "Workspaces",
    "reviews": "Reviews"
  },
  "branchPrefix": "feature",
  "vercelLink": {
    "teamByGitHubOwner": {
      "vercel": "vercel",
      "vercel-labs": "vercel-labs"
    },
    "repoOverrides": {
      "vercel/omniagent": {
        "team": "vercel"
      },
      "vercel/internal-only": {
        "disabled": true
      }
    }
  },
  "ai": {
    "provider": "codex-cli",
    "model": "gpt-5",
    "timeoutMs": 120000,
    "disabled": false
  }
}
```

## Fields

### `directory`

Type: `object`

Human-facing Workforest directory layout. Relative child values resolve against directory.base.

Default: Uses ~/Code as the base, with Repos, Workspaces, and Reviews child directories.

Nested fields:

- `directory.base` (`string (path)`): Base directory for Workforest-managed checkouts. Default: ~/Code.
- `directory.repos` (`string (path)`): Directory for single-repository changes. Default: Repos. Relative values resolve against directory.base.
- `directory.workspaces` (`string (path)`): Directory for template and _adhoc workspace changes. Default: Workspaces. Relative values resolve against directory.base.
- `directory.reviews` (`string (path)`): Directory for pull request review checkouts. Default: Reviews. Relative values resolve against directory.base.

### `branchPrefix`

Type: `string`

Global prefix added to generated feature branches. Values with or without a trailing slash are accepted.

Default: The empty string ("").

### `vercelLink`

Type: `object`

Controls automatic Vercel project linking by repository.

Default: Unset. Built-in owner mappings still apply for vercel and vercel-labs.

Nested fields:

- `vercelLink.teamByGitHubOwner` (`object<string, string>`): Maps a GitHub owner to the Vercel team used for repositories from that owner. Default: No custom mappings. Built-in mappings cover vercel and vercel-labs.
- `vercelLink.repoOverrides` (`object<string, { team?: string; disabled?: boolean }>`): Overrides the Vercel team or disables automatic linking for an owner/repository slug. Default: No per-repository overrides.
- `vercelLink.repoOverrides.<owner/repository>.team` (`string`): Selects a Vercel team for one repository. Default: Uses the owner mapping when one exists.
- `vercelLink.repoOverrides.<owner/repository>.disabled` (`boolean`): Disables automatic Vercel linking for one repository. Default: false.

### `ai`

Type: `object`

Controls Workforest-owned AI provider selection and generation defaults.

Default: Unset. Workforest auto-detects built-in providers in priority order when an AI feature requires one.

Nested fields:

- `ai.provider` (`string`): Selects a provider by plugin provider ID, for example codex-cli or claude-cli. Default: Auto-detects available providers, preferring codex-cli then claude-cli.
- `ai.model` (`string`): Passes a model name through to the selected provider when a provider supports model selection. Default: Uses the selected provider's CLI default.
- `ai.timeoutMs` (`positive integer`): Maximum time to wait for a single AI generation. Default: 120000.
- `ai.disabled` (`boolean`): Disables AI-backed Workforest features. Default: false.

Unknown top-level fields are ignored. String values are trimmed; blank optional paths are treated as unset.
