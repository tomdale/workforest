# Incremental Large Work

Use this reference when converting a large refactor or new implementation into
an execution plan.

## Checkpoint Rules

- Every checkpoint should leave the repository in a coherent, reviewable state.
- Prefer vertical slices that preserve behavior over broad mechanical rewrites.
- Put prerequisite discovery, contract clarification, and test harness work
  before risky implementation.
- Keep compatibility shims temporary and name the checkpoint that removes them.
- Avoid dedicated tests for retired behavior unless the product intentionally
  supports a migration or tailored legacy error.

## Lane Design

- Give each lane exactly one responsibility and one path scope.
- Split lanes by stable ownership boundaries: modules, command surfaces, UI
  areas, test harnesses, or data contracts.
- Mark a lane parallelizable only when it can be developed without touching the
  same files or relying on unmerged behavior from another lane.
- State dependency notes even when a lane has no dependencies.
- Use Workforest task worktrees for later execution of independent lanes.

## Verification Gates

- Assign one verification command to each lane prompt.
- Choose the narrowest useful command for lane iteration, then require the
  project-level final gate in the integration plan.
- Include reviewable acceptance criteria alongside commands when behavior is
  hard to verify mechanically.
- Treat passing verification as necessary but not sufficient; final integration
  still needs a semantic diff review.

## Integration Shape

- Integrate prerequisite checkpoints first, then parallel lanes in dependency
  order, then cleanup and removal checkpoints.
- Identify likely conflict hot spots before execution starts.
- Keep a pause criterion for unresolved architecture decisions, failing gates,
  or lanes that expand beyond their stated scope.
- Run the repository's standard final verification command before calling the
  plan executed.
