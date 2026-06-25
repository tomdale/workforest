# Cached Repository Jobs to Be Done

Workforest keeps bare Git mirrors in its cache so new changes and task worktrees
can start without cloning the same repository repeatedly. Repository management
supports these jobs:

## Discover and Reuse

When starting work, identify which repositories are already known so they can be
referenced by short name and reused without another full clone.

```sh
wf cache list
wf cache info vercel/next.js
wf cache path vercel/next.js
wf cache manage
```

The interactive manager supports search across slugs, remotes, paths, branches,
issues, and active worktrees.

## Warm the Cache

Before starting a change, fetch repositories once so later `wf start` and
`wf add` operations are fast and authentication problems are discovered early.

```sh
wf cache add vercel/next.js vercel/turbo
```

Repositories with the same basename under different owners receive distinct
mirror paths. Existing legacy `<name>.git` mirrors continue to work.

## Inspect Usage and Health

When disk usage is growing or Git behavior is suspicious, inspect mirror size,
origin identity, default branch, last fetch time, active worktrees, stale
registrations, and repository validity.

```sh
wf cache info next.js
wf cache doctor
wf cache doctor next.js --json
```

`doctor` exits unsuccessfully when any selected mirror needs attention, making
it suitable for scripts.

## Refresh Cached Data

Before branching from a cached repository, fetch current remote branches and
prune deleted remote refs.

```sh
wf cache update next.js
wf cache update
```

With no selector, `update` operates on every cached repository.

## Repair Metadata

When a managed change was moved or deleted outside Workforest, prune stale
worktree registrations and verify Git object connectivity.

```sh
wf cache repair next.js
wf cache repair
```

Invalid non-Git cache directories cannot be repaired in place; inspect them,
then delete and add the repository again.

## Reclaim Disk Space

Preview and remove mirrors that have no active worktrees, or delete a selected
mirror explicitly.

```sh
wf cache prune --dry-run
wf cache delete vercel/next.js --dry-run
wf cache delete vercel/next.js --force
```

Deletion refuses mirrors with active worktrees unless `--force` is passed.
Forced deletion breaks those worktrees, so finish or delete tracked changes and
tasks through Workforest first whenever possible.

## Automate

Use JSON output for inventory and health checks, and raw path output for shell
composition.

```sh
wf cache list --json
wf cache info next.js --json
wf cache doctor --json
wf cache path
wf cache path next.js
```
