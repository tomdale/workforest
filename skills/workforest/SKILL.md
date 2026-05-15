---
name: workforest
description: Workforest CLI guidance for AI agents working across multi-repo workspaces, Git worktrees, temporary subagent worktrees, templates, repo setup, and workspace cleanup. Use when the user asks to create or manage workforest workspaces, coordinate parallel agents with short-lived worktrees, add repos to a workspace, fork a workspace, clean a workspace, configure setup/templates, or inspect Workforest commands. Prefer loading current instructions with `wf skills get core` before running Workforest commands.
hidden: true
---

# workforest

Workforest creates coordinated Git worktree workspaces for agents working across
one or more repositories.

This file is a discovery stub. Before using Workforest for a task, load the
versioned instructions served by the installed CLI:

```sh
wf skills get core
```

Load specialized guidance when relevant:

```sh
wf skills get parallel-worktrees --full
wf skills get setup-and-configuration --full
```

The CLI-served skill content matches the installed Workforest version, so it is
safer than relying on stale copied instructions.
