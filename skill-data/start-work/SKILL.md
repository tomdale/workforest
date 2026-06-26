---
name: start-work
description: Workforest guidance for starting a new change or workspace.
---

# Start Work

Use this skill when you need to begin a change from a repo, a template, or the
current managed context.

```sh
wf start cli-redesign tomdale/workforest
wf start auth-fix @vercel-agent
wf start follow-up
```

Use `wf start --help` for the source forms and branch overrides.

## Pick The Right Start

- One repository source starts a repository change.
- One `@template` source starts a workspace from a template.
- Multiple repository sources start an `_adhoc` workspace.
- A bare change name repeats the current managed context.

## After Starting

- Run `wf status --watch` until setup finishes.
- Move into the new checkout and use the repo's normal project commands.
- If the change needs another repo later, load `coordinate-agents` and use
  `wf add`.

## Safety

- Start from a clean parent checkout when you are delegating follow-up work.
- Do not hand off unfinished work without a clear selector and verification
  command.
