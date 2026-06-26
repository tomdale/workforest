---
name: configure-workforest
description: Workforest guidance for config, branch prefixes, and setup choices.
---

# Configure Workforest

Use this skill when you need to change global Workforest settings.

```sh
wf config show
wf config init
wf config edit
```

Use `wf config --help` for the configuration commands and their options.

## What To Configure

- Directory roots for repos, workspaces, and reviews.
- The branch prefix used when Workforest names branches.
- Vercel linking rules when the workspace needs them.

## Rules To Keep

- Prefer `wf config edit` when you already know the final shape.
- Use `wf config init` for an interactive first-time setup.
- Keep shared config free of local machine workarounds.
