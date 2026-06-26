---
name: workforest
description: Workforest CLI guidance for AI agents working across multi-repo workspaces, task worktrees, standalone worktrees, templates, repository caches, reviews, and workspace cleanup. Use when the user asks to create or manage Workforest resources, coordinate parallel agents, add repositories, configure setup or templates, or inspect Workforest commands. Prefer loading current instructions with `wf skills get core` before running Workforest commands.
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
wf skills get start-work coordinate-agents finish-work
wf skills get create-templates configure-workforest keep-cache-healthy review-prs
```

The CLI-served skill content matches the installed Workforest version, so it is
safer than relying on stale copied instructions.
