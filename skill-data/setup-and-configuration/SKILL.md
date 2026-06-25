---
name: setup-and-configuration
description: Workforest setup and configuration guidance. Use when configuring Workforest directories, creating or editing templates, managing template hooks and default files, understanding automatic initializers, disabling initializers, setting branch prefixes, or troubleshooting reusable multi-repo workspace setup.
---

# Workforest Setup And Configuration

Use this skill when a workflow needs repeatable setup beyond a one-off
`wf start`: global directory config, templates, built-in initializers, hooks,
branch prefixes, Vercel linking, or default files.

## Directory Configuration

The final configuration shape is:

```json
{
  "directory": {
    "base": "~/Code",
    "repos": "Repos",
    "workspaces": "Workspaces",
    "reviews": "Reviews"
  },
  "branchPrefix": "tomdale"
}
```

Rules:

- `directory.base` defaults to `~/Code`.
- `directory.repos` defaults to `Repos`.
- `directory.workspaces` defaults to `Workspaces`.
- `directory.reviews` defaults to `Reviews`.
- Relative child directory values resolve against `directory.base`.
- Absolute child directory values are used as provided.
- Cached bare mirrors live under `~/.cache/workforest` unless
  `WORKFOREST_CACHE_DIR` is set.

This yields:

```text
~/Code/Repos/<repo>/<change>
~/Code/Workspaces/<template>/<change>/<repo>
~/Code/Workspaces/_adhoc/<change>/<repo>
~/Code/Reviews/<repo>/...
~/.cache/workforest/<repo>.git
```

Use `wf config edit` to set the final shape directly. Use `wf config show` to
inspect resolved values and the config path.

For the complete schema:

```sh
wf skills get setup-and-configuration --full
```

## Branch Prefix

`branchPrefix` accepts values with or without a trailing slash. Workforest
normalizes generated branch names so there is exactly one slash between the
prefix and the generated suffix:

```json
{ "branchPrefix": "tomdale" }
```

creates task/change branches such as:

```text
tomdale/cli-redesign
tomdale/fix-tests
```

Use an empty string to disable a global prefix.

## Template Commands

Templates define reusable workspace recipes: repositories, optional branch
prefix, hooks, initializer settings, and bundled files.

```sh
wf template manage
wf template list
wf template show full-stack
wf template new full-stack vercel/front vercel/api
wf template edit full-stack
wf template open full-stack
```

Start a workspace from a template with an `@` source:

```sh
wf start user-avatars @full-stack
```

## Initializers

Workforest automatically detects common setup needs in each repo worktree:

- package manager install
- Vercel project linking
- Turbo linking

Templates can disable all initializers or a specific initializer id when a
workflow requires manual setup. Prefer built-in initializers over shell hooks
when possible because they are easier to inspect and test.

## Hooks

Hooks run after built-in initializers. Use hooks for setup that Workforest
cannot infer:

- repo-specific bootstrap commands
- generated files
- local service preparation
- template-specific validation

Scope hooks with `in` when they apply only to selected repos, and use
`if.fileExists` for optional repo features.

Do not put local machine workarounds in shared hooks. Hooks should work for
other agents and reviewers without relying on private shell aliases or local
absolute paths.

## Default Files

Templates can bundle files into new workspace checkouts, such as `.envrc`,
editor settings, or repo-specific seed files.

Use:

```sh
wf template add-file -t full-stack .envrc
```

Keep default files small and intentional. Avoid committing secrets.

## Troubleshooting

If setup is still running:

```sh
wf status --watch
```

If a repository fails during setup, inspect logs under the workspace's
`.workforest/logs` directory.

If a cached mirror looks stale or unhealthy:

```sh
wf cache doctor
wf cache doctor <repo> --fix
wf cache clean --dry-run
```

If a template is wrong, edit the template directly and start a new change.
Do not add compatibility paths for an unshipped template design.
