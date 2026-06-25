# Subagent Task Lifecycle

## 1. Prepare The Parent Change

The parent change is the integration checkout. It can be a single-repo change:

```sh
wf switch workforest/cli-redesign
cd ~/Code/Repos/workforest/cli-redesign
```

Or a repository inside a workspace change:

```sh
wf switch _adhoc/billing
cd ~/Code/Workspaces/_adhoc/billing/front
```

Before creating tasks, make the parent repository clean:

```sh
git status --short
```

Commit or stash unrelated local edits. Task branches start from the parent
repository's committed `HEAD`; uncommitted parent edits are not copied into task
worktrees.

## 2. Create One Task Worktree Per Subtask

From inside the parent repository:

```sh
wf task start fix-tests upgrade-deps
```

From a workspace root, name the parent repo:

```sh
wf task start --repo front fix-tests
```

Expected shapes:

```text
~/Code/Repos/workforest/cli-redesign/_tasks/workforest/fix-tests
~/Code/Workspaces/_adhoc/billing/_tasks/front/fix-tests
```

Task branches use the configured branch prefix:

```text
tomdale/fix-tests
tomdale/upgrade-deps
```

List tasks and paths:

```sh
wf task list
```

## 3. Delegate Carefully

Each subagent should get:

- one task worktree path
- one narrow task
- one verification command
- the parent change selector for context
- instruction not to edit the parent checkout
- instruction not to touch sibling task worktrees
- instruction not to revert unrelated changes

Good delegation prompt:

```text
Work only in:
~/Code/Repos/workforest/cli-redesign/_tasks/workforest/fix-tests

Task:
Update parser tests for the final command surface.

Verify:
pnpm exec vitest run src/cli/parse-invocation.test.ts

Do not edit the parent checkout or any sibling _tasks worktree.
Do not revert unrelated edits.
```

## 4. Review And Integrate

Inspect each task in its own worktree:

```sh
cd ~/Code/Repos/workforest/cli-redesign/_tasks/workforest/fix-tests
git status --short
git diff
pnpm exec vitest run src/cli/parse-invocation.test.ts
```

Commit accepted task work on the task branch:

```sh
git add .
git commit -m "Update parser tests"
```

Integrate into the parent checkout with normal Git:

```sh
cd ~/Code/Repos/workforest/cli-redesign
git merge tomdale/fix-tests
```

Use cherry-pick or a squash merge when that is the chosen integration style.
Workforest does not merge task branches automatically.

## 5. Finish Integrated Tasks

After the task branch is reachable from the parent branch:

```sh
wf task finish fix-tests
```

`finish` removes the nested worktree and local task branch after verifying:

- the task worktree is clean
- the task branch is integrated into the parent branch
- the task belongs to the current managed change

## 6. Delete Abandoned Tasks

Use `delete` for work that is intentionally discarded, squash-merged,
cherry-picked without branch reachability, or otherwise not eligible for
`finish`:

```sh
wf task delete upgrade-deps --force
```

Use `--force` only when the task's changes have already been intentionally
merged, cherry-picked, or abandoned. Without `--force`, deletion refuses dirty
or unmerged task branches.

## 7. Final Parent Verification

After integrating task work, run verification in the parent checkout:

```sh
cd ~/Code/Repos/workforest/cli-redesign
pnpm test
```

Then finish or delete the parent change according to the normal lifecycle:

```sh
wf finish workforest/cli-redesign
```
