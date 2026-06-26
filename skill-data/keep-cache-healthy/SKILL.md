---
name: keep-cache-healthy
description: Workforest guidance for listing, checking, and cleaning cached mirrors.
---

# Keep Cache Healthy

Use this skill when you need to inspect or repair the bare mirrors that back
Workforest worktrees.

```sh
wf cache list
wf cache show vercel/front
wf cache doctor
wf cache clean --dry-run
```

Use `wf cache --help` for the exact cache commands.

## Preferred Flow

- List first so you know what exists.
- Run `wf cache doctor` before cleaning a mirror that looks suspicious.
- Use `--dry-run` before any destructive cleanup.

## Safety

- Do not remove active mirrors by hand.
- Use `wf cache doctor <repo> --fix` only when the mirror is clearly broken.
- Keep cache cleanup separate from unrelated change work.
