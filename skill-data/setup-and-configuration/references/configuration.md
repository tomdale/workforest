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
  "defaultDir": "~/Code/workspaces",
  "reviewsDir": "~/Code/reviews",
  "dirPrefix": "workspace-",
  "branchPrefix": "feature/",
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
  }
}
```

## Fields

### `defaultDir`

Type: `string (path)`

Directory under which normal workspaces are created.

Default: Unset. Commands that require a configured workspace root report an error or prompt for one.

### `reviewsDir`

Type: `string (path)`

Directory under which pull request review worktrees are created.

Default: Unset. The first interactive review suggests a reviews directory beside defaultDir, or ~/Code/reviews.

### `dirPrefix`

Type: `string`

Prefix added to generated workspace directory names.

Default: The empty string ("").

### `branchPrefix`

Type: `string`

Global prefix added to generated feature branches. A missing trailing slash is added automatically.

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

Unknown top-level fields are ignored. String values are trimmed; blank optional paths are treated as unset.
