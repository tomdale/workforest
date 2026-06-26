---
name: create-templates
description: Workforest guidance for creating, editing, and using templates.
---

# Create Templates

Use this skill when you need a reusable workspace recipe for repeatable work.

```sh
wf template manage
wf template new full-stack vercel/front vercel/api
wf template edit full-stack
wf template show full-stack
wf template open full-stack
```

Use `wf template --help` for the exact subcommands and flags.

## What A Template Holds

- The repository set for the workspace.
- Optional hooks and initializer settings.
- Optional default files.
- An optional branch prefix.

## Keep Templates Small

- Put repeatable setup in the template, not in local shell workarounds.
- Add files only when they are meant to ship with every new workspace.
- Use `wf start <change> @<template>` after you have a template you trust.
