---
name: start-work
description: Workforest guidance for starting a new worktree or workspace.
---

# Start Work

Use this skill when you need to begin work from a repo, a template, or the
current managed context.

```sh
wf new cli-redesign tomdale/workforest
wf new auth-fix @vercel-agent
wf new follow-up
```

Use `wf new --help` for the source forms and branch overrides.

## Pick The Right Start

- One repository source creates a worktree.
- One `@template` source starts a workspace from a template.
- Multiple repository sources start an `_adhoc` workspace.
- A bare name repeats the current managed context.

## After Starting

- Run `wf status --watch` until setup finishes.
- Move into the new checkout and use the repo's normal project commands.
- If it needs another repo later, load `coordinate-agents` and use
  `wf add`.

## Safety

- Start from a clean parent checkout when you are delegating follow-up work.
- Do not hand off unfinished work without a clear selector and verification
  command.
