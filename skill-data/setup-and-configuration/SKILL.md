---
name: setup-and-configuration
description: Workforest setup and configuration guidance. Use when configuring Workforest, creating or editing templates, managing template hooks and default files, understanding automatic initializers, disabling initializers, setting branch prefixes, or troubleshooting reusable multi-repo workspace setup.
---

# Workforest Setup And Configuration

Use this skill when a workspace needs repeatable setup beyond a one-off `wf new`
command: global config, templates, built-in initializers, hooks, branch prefixes,
Vercel linking, or default files.

## Common Commands

```sh
wf config show
wf config init
wf config edit
wf templates
wf template list
wf template info "oss-docs"
wf template new "oss-docs" vercel/next.js vercel/turbo
wf template edit "oss-docs"
wf template copy "oss-docs" "oss-docs-experiment"
wf template rm "oss-docs-experiment"
```

For the detailed setup schema, load `references/template-schema.md`:

```sh
wf skills get setup-and-configuration --full
```

## Setup Guidance

- Use `wf config init` or `wf config edit` for defaults like `defaultDir`,
  `dirPrefix`, `branchPrefix`, and Vercel link mappings.
- Keep templates focused on a real repeated workflow.
- Prefer built-in initializers for dependency install and Vercel/Turbo linking.
- Use hooks only for setup Workforest cannot infer.
- Use default files for workspace-level config such as `.envrc` or repo-specific
  seed files.
- Do not put local machine workarounds in shared template hooks.

## Initializers

Workforest automatically detects and runs package manager setup plus Vercel and
Turbo linking when matching files are present. Templates can disable all
initializers or specific initializer ids when a workflow requires manual setup.

## Hooks

Hooks run after built-in initializers. Scope hooks with `in` when they only
apply to specific repos, and use `if.fileExists` for optional repo features.
