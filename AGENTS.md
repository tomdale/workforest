# Development Workflow

Workforest is a personal project under very active development. The default
workflow is to commit and push changes to `main` frequently.

Workforest is intentionally opinionated and built around common conventions.
Prefer the standard directory layouts, branch names, and workflows over adding
configuration switches or compatibility paths.

Local feature branches are appropriate for larger, chunkier implementations,
but keep them short-lived and merge or push their work promptly. Do not leave
long-lived branches accumulating changes.

After any source changes are complete, always run `pnpm build` before wrapping
up the work.

## Testing Style

Tests must assert current contracts and invariants, not historical negative
cases. When behavior, commands, fields, files, formats, or configuration options
are removed or renamed, never add or preserve dedicated "does not support X"
tests for the retired name. Instead, assert the complete supported surface or
the current invariant so old behavior fails naturally if it is still present.

Do not use specific removed names in generic invalid-input tests. Use placeholder
names such as `unknown`, `invalid`, or `unsupported`. A real retired name may
appear in a test only when the product intentionally supports a migration,
compatibility warning, or tailored error for that exact legacy input.

## Parallel Multi-Agent Workflow

When a task can be split safely across multiple agents, use Workforest tasks
instead of ad hoc branches or shared directories.

1. Give each coordinating agent its own workspace, worktree, and
   `tomdale/<coordinator-task>` branch. Coordinators must never share a writable
   checkout or local branch.
2. Keep the coordinator checkout clean before creating task worktrees. Commit
   or stash unrelated local edits because task branches start from committed
   `HEAD`.
3. Create one task worktree per independent subtask with `wf task start` from
   inside the workspace repository, or `wf task start --repo <repo>` from the
   workspace root.
4. Namespace task names with the coordinator task so task directories and
   branches are unique across concurrent coordinators. Include the `tomdale/`
   prefix on any git branches you create manually.
5. Hand each subagent exactly one worktree path, one task, and one verification
   command. Tell it not to touch other worktrees or revert unrelated edits.
6. Prefer local iteration inside each task worktree. Do not merge work across
   tasks by editing the primary checkout directly.
7. Review each task's diff and test output in its own worktree, then integrate
   the accepted commits into the coordinator branch with normal Git.
8. Treat local `main` as the primary integration branch. Keep one designated,
   clean integration worktree with `main` checked out; never perform feature
   work there.
9. Serialize all updates to local `main` with `lockf`. Use the shared Git
   directory so every Workforest worktree contends for the same lock:

   ```sh
   git_common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
   lockf -k "$git_common_dir/workforest-main.lock" <integration command>
   ```

   Hold this lock continuously for the complete integration sequence. The
   lock file is persistent, but only an active OS lock indicates ownership.
10. While holding the lock, merge the latest local `main` into the coordinator
   branch, resolve conflicts without discarding either side, and run
   `pnpm build`. Only after verification passes, fast-forward `main` in the
   designated integration worktree to the coordinator branch:

   ```sh
   git merge main
   pnpm build
   # Run in the designated main worktree:
   git merge --ff-only <coordinator-branch>
   ```

   Run the whole sequence as one lock-holding command. If the merge conflicts,
   either resolve it while holding the lock or abort it before releasing the
   lock. If the build fails, leave local `main` unchanged, release the lock,
   fix the coordinator branch, then reacquire the lock and repeat against the
   latest local `main`.
11. Treat the successful fast-forward of local `main` as the integration
   commit point. Do not announce completion or remove task worktrees before it
   succeeds.
12. When network access is available, periodically push the accumulated local
   history with `git push origin main:main` while holding the same integration
   lock. Network failure does not invalidate local integration; report that
   `main` is pending push and retry later.
13. Use only a normal non-force push. If the push is rejected because remote
   `main` advanced elsewhere, fetch it, merge it into a coordinator or
   temporary sync branch, rerun `pnpm build`, fast-forward local `main` under
   the integration lock, and retry. Never use `--force` or
   `--force-with-lease` on `main`.
14. Clean up finished tasks with `wf task list` and `wf task delete <task>`.
   Use `--force` only when work has already been intentionally merged,
   cherry-picked, or abandoned.
15. For orientation, read `wf help workflow` and `wf skills get core --full`
   before starting a new multi-agent session.
