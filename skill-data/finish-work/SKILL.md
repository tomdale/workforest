---
name: finish-work
description: Workforest guidance for finishing, deleting, and cleaning up changes.
---

# Finish Work

Use this skill when the work is ready to merge, or when you need to abandon
it explicitly.

```sh
wf status
wf delete workforest/cli-redesign
wf delete _adhoc/experiment --force
```

Use `wf delete --help` and `wf delete --help` for the selector rules.

## Finish Only After Integration

- Delete a worktree or workspace only when Git history shows the work is integrated.
- Prefer `wf delete` over manual directory deletion.
- Use the selector that matches the worktree or workspace you are actually cleaning up.

## Delete Only On Purpose

- Use `wf delete` when the work is intentionally abandoned.
- Do not use `--force` as a shortcut for a missing integration step.
- If it still has useful state, review it before deleting it.
