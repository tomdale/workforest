# Template Schema

Templates live under:

```text
~/.config/workforest/templates/<name>/template.jsonc
```

Example:

```jsonc
{
  "repos": ["vercel/next.js", "vercel/turbo"],
  "description": "Open source docs workspace",
  "branchPrefix": "tomdale/",
  "disableInitializers": ["turbo-link"],
  "hooks": [
    {
      "name": "Build documentation site",
      "run": "pnpm build",
      "in": ["turbo"],
      "if": { "fileExists": "package.json" },
      "continueOnError": false
    }
  ]
}
```

## Fields

- `repos`: required list of GitHub slugs or Git URLs.
- `description`: optional text shown in template lists.
- `branchPrefix`: optional override for global branch prefix; use `""` to disable.
- `disableInitializers`: `true` to disable all, or a list of initializer ids.
- `hooks`: optional commands run after automatic initializers.

## Hook Fields

- `name`: required label.
- `run`: required shell command.
- `in`: optional repo name or list of repo names.
- `if.fileExists`: optional path relative to each target repo.
- `continueOnError`: optional boolean.

## Default Files

Files under:

```text
~/.config/workforest/templates/<name>/files/
```

are copied into the workspace before hooks run. Put workspace-root files at the
top level and repo-specific files under a directory named for that repo.
