# Cached Repository Jobs to Be Done

Workforest keeps bare Git mirrors in its cache so new workspaces and worktrees
can start without cloning the same repository repeatedly. Repository management
supports these jobs:

## Discover and Reuse

When starting work, identify which repositories are already known so they can be
referenced by short name and reused without another full clone.

```sh
wf repository list
wf repository info vercel/next.js
wf repository path vercel/next.js
wf repositories
```

The interactive manager supports search across slugs, remotes, paths, branches,
issues, and worktrees.

## Warm the Cache

Before creating a workspace, fetch a repository once so later workspace creation
is fast and authentication problems are discovered early.

```sh
wf repository add vercel/next.js vercel/turbo
```

Repositories with the same basename under different owners receive distinct
mirror paths. Existing legacy `<name>.git` mirrors continue to work.

## Inspect Usage and Health

When disk usage is growing or Git behavior is suspicious, inspect mirror size,
origin identity, default branch, last fetch time, active worktrees, stale
registrations, and repository validity.

```sh
wf repository info next.js
wf repository doctor
wf repository doctor next.js --json
```

`doctor` exits unsuccessfully when any selected mirror needs attention, making
it suitable for scripts.

## Refresh Cached Data

Before branching from a cached repository, fetch current remote branches and
prune deleted remote refs.

```sh
wf repository update next.js
wf repository update
```

With no selector, `update` operates on every cached repository.

## Repair Metadata

When a workspace was moved or deleted outside Workforest, prune stale worktree
registrations and verify Git object connectivity.

```sh
wf repository repair next.js
wf repository repair
```

Invalid non-Git cache directories cannot be repaired in place; inspect them,
then delete and add the repository again.

## Reclaim Disk Space

Preview and remove mirrors that have no active worktrees, or delete a selected
mirror explicitly.

```sh
wf repository clean --dry-run
wf repository clean --force
wf repository delete vercel/next.js --dry-run
wf repository delete vercel/next.js --force
```

Deletion refuses mirrors with active worktrees unless `--force` is passed.
Forced deletion breaks those worktrees, so remove tracked workspaces and
worktrees through Workforest first whenever possible.

## Automate

Use JSON output for inventory and health checks, and raw path output for shell
composition.

```sh
wf repository list --json
wf repository info next.js --json
wf repository doctor --json
wf repository path
wf repository path next.js
```
