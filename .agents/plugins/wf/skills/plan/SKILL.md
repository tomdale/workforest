---
name: plan
description: Plan large Workforest refactors and new implementations as incremental, independently verifiable checkpoints.
---

# Plan

Use this skill when a large refactor, architecture change, or new implementation
needs a planning packet before execution. The skill produces a plan only; do not
create Workforest tasks, spawn implementation agents, edit product files, or
start execution lanes unless the user explicitly asks for that follow-up work.

## Requirements

1. Inspect the current repository state, user request, local instructions, and
   likely affected files before delegating planning work.
2. Read `references/incremental-large-work.md` before writing the final packet.
3. Delegate broad planning to the registered `plan-architect` agent. Ask it for
   end-state design, major risks, sequencing, checkpoint boundaries, and where
   parallel work is useful.
4. Delegate detailed planning to the registered `plan-detailer` agent. Give it
   the architect output and ask for concrete checkpoints, execution lanes,
   verification gates, integration order, and subagent-ready lane prompts.
5. Reconcile both outputs yourself. Remove speculative work, overlapping lanes,
   unclear dependencies, and any step that cannot be verified independently.
6. Write planning artifacts under `.agent/plans/<slug>/`.
7. Keep the final packet implementation-ready but read-only: it should describe
   work, not perform it.

## Workflow

1. Create a short slug from the user request, using lowercase letters, digits,
   and hyphens.
2. Inspect:
   - `git status --short --branch`
   - local instructions such as `AGENTS.md`
   - existing architecture and tests around the likely affected areas
   - relevant Workforest workflow docs or skills when the plan may use task
     worktrees or integration lanes
3. Ask `plan-architect` to produce the broad plan:
   - target end state
   - domain or module boundaries
   - sequencing strategy
   - risks and unknowns
   - useful parallelization, if any
4. Ask `plan-detailer` to turn the approved broad plan into:
   - small checkpoints
   - dependency-aware lanes
   - verification commands
   - integration gates
   - subagent prompts for each lane
5. Write the final packet:

   ```text
   .agent/plans/<slug>/
     plan.md
     steps.md
     lanes.md
     integration.md
     prompts/
       <lane-id>.md
   ```

6. Review the packet before reporting completion. Confirm that every lane prompt
   is bounded, independently reviewable, and has exactly one verification
   command.

## Output Contract

- `plan.md`: objective, current constraints, target design, non-goals, risks,
  and decisions.
- `steps.md`: ordered checkpoints with expected repository state after each
  checkpoint.
- `lanes.md`: dependency-aware lanes, path scopes, owners, and whether each lane
  is serial or parallelizable.
- `integration.md`: merge order, verification gates, conflict hot spots, and
  rollback or pause criteria.
- `prompts/<lane-id>.md`: one bounded task per file.

Each lane prompt must include:

- one bounded task
- path scope
- explicit exclusions
- expected output
- dependency notes
- one verification command

## Notes

- Prefer Workforest task worktrees for later parallel execution, but do not
  create them during planning.
- Parallelize only when boundaries are clear and useful.
- Prefer small valid checkpoints over large speculative rewrites.
- Use project-level verification commands such as `pnpm check`; do not include
  local environment workarounds in verification steps.
