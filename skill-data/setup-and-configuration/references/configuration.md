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

Unknown top-level fields are ignored. String values are trimmed; blank optional paths are treated as unset.
