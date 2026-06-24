# Workforest Command Reference

<!-- Generated from the executable registry. Do not edit directly. -->

All syntax is generated from the CLI command registry. Use `wf`; `workforest` remains an executable alias.

## Concepts

workforest creates isolated workspaces that span multiple repositories, so a feature can move the frontend, API, docs, and tooling together from cached mirrors without juggling branches in a single checkout.

- **workspace** — A directory of git worktrees, one per repository, branched and set up together.
- **task** — A short-lived extra worktree inside a workspace, on its own branch.
- **standalone worktree** — One repository's worktree on its own, not tied to a workspace (wf worktree).
- **template** — A saved repository set, plus hooks and files, to create workspaces from.
- **cached mirror** — A local bare clone each worktree is built from, kept for fast offline setup.
- **review workspace** — A workspace for reviewing someone's pull request (wf review).

## Conventions

Exit codes: `0` success, `2` usage error (invalid arguments or flags), `1` operational failure.

Commands whose options include `--json` emit a machine-readable envelope: `{ "ok": true, "data": ... }` on success, or `{ "ok": false, "error": { "kind": "operational" | "usage", "message": ... } }` on failure.

## `wf start`

Start a change.

Creates a new Workforest change. A single repository source creates `Repos/<repo>/<change>`, an `@template` source creates `Workspaces/<template>/<change>`, and multiple repository sources create `Workspaces/_adhoc/<change>`. With only a change name, repeats the current Workforest-managed context.

```text
wf start <change> [source...]
```

Arguments:

- `arguments` — A change name, optionally followed by one repository, multiple repositories, or one @template source.

Examples:

- `wf start redesign-cli tomdale/workforest` — Start a repository change.
- `wf start auth-fix @vercel-agent` — Start a workspace change from a template.
- `wf start billing vercel/front vercel/api` — Start an _adhoc workspace from several repositories.
- `wf start follow-up` — Start another change from the current Workforest context.

## `wf list`

List Workforest changes.

Shows a compact inventory of Workforest-managed workspace and repository changes, grouped by their human-facing directory layout.

```text
wf list [options]
```

Options:

- `--repo <repo>` — Show only changes containing this repository.
- `--group <group>` — Show one workspace recipe group, repository group, or _adhoc.
- `--paths` — Include the absolute path for each change.
- `--json` — Emit the change inventory as a JSON envelope instead of the report.

Examples:

- `wf list` — Show all workspace and repository changes.
- `wf list --repo workforest` — Show changes containing the workforest repository.
- `wf list --group _adhoc --paths` — Show _adhoc workspace changes with paths.

## `wf status`

Show change status.

Shows a static report for one Workforest change, resolving the current change from the working directory when no selector is provided.

```text
wf status [options] [selector]
```

Arguments:

- `selector` — Change selector as <group>/<change>, or a bare change name when unique.

Options:

- `--json` — Emit the change status model as a JSON envelope instead of the report.
- `--watch` — Open the initialization watcher for the selected change when setup state exists.

Examples:

- `wf status` — Show status for the current Workforest change.
- `wf status workforest/cli-redesign` — Show a repository change by selector.
- `wf status vercel-agent/auth-fix --json` — Print a workspace change status as JSON.

## `wf add`

Add repositories to the current change.

Adds repositories to the current Workforest change. From a workspace change, missing repositories are added to that workspace. From a repository change, the change is promoted into a workspace and the existing worktree is moved there; pass @template to use the template's repository set.

```text
wf add [options] <repo...|@template>
```

Arguments:

- `sources` — One or more repositories, or one @template when promoting a repository change.

Options:

- `--yes` — Confirm repository-change promotion without prompting.

Examples:

- `wf add vercel/api` — Add one repository to the current workspace change.
- `wf add vercel/api vercel/dashboard` — Add several repositories to the current workspace change.
- `wf add @vercel-agent --yes` — Promote the current repository change into a template workspace.

## `wf switch`

Switch to a Workforest change.

Changes your shell to a Workforest change. Use <group>/<change> to select exactly, a bare change name when unique, or no selector in an interactive terminal to fuzzy-pick from all known changes.

```text
wf switch [selector]
```

Arguments:

- `selector` — Change selector as <group>/<change>, or a bare change name when unique.

Examples:

- `wf switch workforest/cli-redesign` — Switch to a repository change.
- `wf switch vercel-agent/auth-fix` — Switch to a workspace change.
- `wf switch` — Fuzzy-pick from known changes interactively.

## `wf finish`

Finish an integrated change.

Removes a Workforest change after verifying every managed repository is clean, integrated into its remote default branch, and has no unmerged nested tasks. With no selector, resolves the current change from the working directory. Pass --force only for squash merges, cherry-picks, abandoned work, or proof Workforest cannot detect.

```text
wf finish [options] [selector]
```

Arguments:

- `selector` — Change selector as <group>/<change>, or a bare change name when unique. Omit to finish the current change.

Options:

- `-f`, `--force` — Skip finish safety blockers for intentional squash merges, cherry-picks, or abandoned work.

Examples:

- `wf finish workforest/cli-redesign` — Finish a repository change after integration.
- `wf finish vercel-agent/auth-fix` — Finish a workspace change after integration.
- `wf finish workforest/squashed-change --force` — Finish a change integrated in a way Workforest cannot prove.

## `wf delete`

Delete a Workforest change.

Explicitly deletes a Workforest change without integration proof. Requires a selector and confirmation in an interactive terminal; scripts must pass --force. Cached mirrors are preserved.

```text
wf delete [options] <selector>
```

Arguments:

- `selector` — Change selector as <group>/<change>, or a bare change name when unique.

Options:

- `-f`, `--force` — Skip the confirmation prompt; required to proceed without a terminal.

Examples:

- `wf delete _adhoc/experiment` — Delete a change after confirming.
- `wf delete _adhoc/experiment --force` — Delete without prompting.

## `wf workspace`

Manage workspaces.

Create, open, inspect, and delete workspaces — directories holding one git worktree per repository, set up from a template or repo set. See also `wf task` (temporary worktrees inside a workspace), `wf worktree` (standalone worktrees), and `wf review` (review workspaces for PRs).

```text
wf workspace <subcommand>
```

### `wf workspace create`

Create a workspace.

Sets up a workspace directory with a git worktree per repository from a cached bare mirror, then runs the template's hooks; repository setup continues in the background, tracked by `wf workspace status`. In a terminal with no arguments, prompts interactively; without a TTY, arguments are required — one or more repositories or a template, then `--`, then the work words — and omitting them is a usage error. The work words name the workspace and its branch. Changes your shell's directory to the new workspace under shell integration. Also available as `wf new`.

```text
wf workspace create [options]
wf workspace create [options] <templates or repositories...> -- <work words...>
wf workspace create [options] -- <work words...>
```

Arguments:

- `templates or repositories` — A template name, or one or more repositories as a cached repo name, `org/repo` GitHub shorthand, or full git URL.
- `work words` — Free-text after `--` describing the work; becomes the workspace name and branch.

Options:

- `--like <workspace>` — Reuse another workspace's repository set instead of naming repos or a template; pass `current` to reuse the workspace you are in, with the work words after `--`.
- `-d`, `--description <description>` — Set the workspace description; otherwise derived from the work words.
- `-n`, `--dry-run` — Show the workspace, branch, and repositories that would be created without writing anything.

Examples:

- `wf workspace create vercel/next.js -- "update docs"` — Create a workspace with one repository, on a branch named for the work.
- `wf workspace create <template> -- "fix login bug"` — Create a workspace from a saved template's repository set.
- `wf workspace create --like current -- "try another approach"` — Reuse the current workspace's repositories in a fresh workspace.

### `wf workspace delete`

Delete a workspace.

Removes the workspace directory and the git worktrees inside it; with `-r` it also deletes each repository's merged feature branch from its remote, and with `--delete-mirrors` it also removes the cached bare mirrors. Shows a preview and prompts for confirmation in a terminal; without a TTY it refuses unless `--force` is passed, exiting 1. If you delete the workspace you are currently inside, your shell moves to the parent directory under shell integration. Also available as `wf clean`.

```text
wf workspace delete [options] <workspace>
```

Arguments:

- `workspace` — The workspace to delete, as a path to its directory or a workspace name resolved under `defaultDir`.

Options:

- `-n`, `--dry-run` — Show what would be removed without deleting anything.
- `-f`, `--force` — Skip the confirmation prompt; required to proceed without a terminal.
- `--delete-mirrors` — Also remove the cached bare mirror, not just the worktree; it must be re-cloned next time.
- `-r`, `--delete-remote-branches` — Also delete each repository's merged feature branch from its remote.

Examples:

- `wf workspace delete <workspace>` — Preview and confirm removal of a workspace and its worktrees.
- `wf workspace delete <workspace> --force` — Delete without prompting, for scripts or a non-interactive shell.
- `wf workspace delete <workspace> -r --delete-mirrors` — Also delete merged remote branches and the cached mirrors.

### `wf workspace open`

Open a workspace.

Resolves a workspace and changes your shell's directory to it under shell integration; as the bare binary it prints `cd <path>` instead. Given a name, resolves it under `defaultDir`. With no name in a terminal it shows a picker, or `--search` opens a fuzzy finder; without a TTY a name is required.

```text
wf workspace open [options] [workspace]
wf workspace open [options]
```

Arguments:

- `workspace` — The workspace to open, resolved by name under `defaultDir`. Required without a TTY.

Options:

- `--search` — Open a fuzzy finder to pick a workspace; requires an interactive terminal.

Examples:

- `wf workspace open <workspace>` — Switch to the named workspace's directory.
- `wf workspace open --search` — Fuzzy-find a workspace interactively, then switch to it.

### `wf workspace list`

List workspaces.

Prints each workspace found under `defaultDir` with its description, template, branch, and repository count. Entries with unreadable metadata are skipped. Errors if `defaultDir` is unset (set it with `wf config edit`).

```text
wf workspace list
```

Examples:

- `wf workspace list` — Show every workspace under the configured directory.

### `wf workspace status`

Show repository initialization status.

Reports the background initialization state of each repository in a workspace — queued, running, failed, or cancelled — finalizing completed work before reporting. Run from inside a workspace, or target one with `-w`. With no recorded initialization it exits 0 with a message. With `--json` it emits `{ "ok": true, "data": { "workspace": …, "repos": [ … ] } }`.

```text
wf workspace status [options]
```

Options:

- `--json` — Emit the machine-readable envelope instead of human output.
- `-w`, `--workspace <dir>` — Path to the workspace to inspect (default: the current workforest workspace).

Examples:

- `wf workspace status` — Show initialization progress for the current workspace.
- `wf workspace status -w <dir> --json` — Print another workspace's status as a JSON envelope.

### `wf workspace add`

Add repositories to a workspace.

Adds repositories to an existing workspace, creating a worktree for each on the workspace's feature branch and running the template's initializers. Run from inside a workspace or target one with `-w`. With no repositories in a terminal it prompts; without a TTY at least one repository is required.

```text
wf workspace add [options] [repositories...]
wf workspace add [options] <repositories...>
```

Arguments:

- `repositories` — One or more repositories to add, each a cached repo name, `org/repo` shorthand, or git URL. Required without a TTY.

Options:

- `-w`, `--workspace <dir>` — Path to the target workspace (default: the current workforest workspace).
- `-n`, `--dry-run` — Show which repositories would be added without writing anything.

Examples:

- `wf workspace add vercel/turborepo` — Add a repository to the current workspace.
- `wf workspace add vercel/next.js vercel/turborepo -w <dir>` — Add repositories to a specific workspace.

## `wf task`

Manage temporary workspace tasks.

Create and remove short-lived task worktrees inside an existing workspace, each on its own branch off a parent repository's current HEAD. Run these from inside a workspace. A task is scoped to one repository in the workspace; for a worktree not tied to any workspace, see `wf worktree`.

```text
wf task <subcommand>
```

### `wf task create`

Create temporary worktrees.

Adds one or more task worktrees inside the current workspace, each on a new branch off the parent repository's current HEAD, then runs the template's setup initializers. Run from inside a workspace; the parent repository is inferred from the current directory unless set with `--repo`. Refuses to run when the parent has uncommitted changes unless you pass `--force`. When one task is created, changes your shell's directory to it under shell integration. See also `wf task delete`.

```text
wf task create [options] <task names...>
```

Arguments:

- `task names` — One or more task names, each a slug (lowercase words separated by hyphens); each names a worktree and its branch.

Options:

- `--repo <repository>` — Parent repository in the workspace to branch from; defaults to the one inferred from the current directory.
- `-n`, `--dry-run` — Show the worktrees and branches that would be created without writing anything.
- `-f`, `--force` — Create even when the parent repository has uncommitted changes.

Examples:

- `wf task create fix-login` — Create one task worktree off the inferred parent repo and cd into it.
- `wf task create fix-login add-tests --repo web` — Create two task worktrees branched from the `web` repository.

### `wf task list`

List temporary worktrees.

Lists the task worktrees tracked in the current workspace, showing each task's parent repository, branch, setup status, merge state, and path. Run from inside a workspace; the parent repository is inferred from the current directory unless `--repo` scopes the list. Exits 0 with a message when no tasks match.

```text
wf task list [options]
```

Options:

- `--repo <repository>` — Limit the list to tasks whose parent is this repository in the workspace.

Examples:

- `wf task list` — List every task tracked in the current workspace.
- `wf task list --repo web` — List only tasks branched from the `web` repository.

### `wf task delete`

Delete temporary worktrees.

Removes one or more task worktrees and deletes their branches; this cannot be undone. Run from inside a workspace. Refuses a task with uncommitted changes or an unmerged branch unless you pass `--force`. Prompts for confirmation in a terminal; without a TTY it exits 1 unless `--force` or `--dry-run` is given. See also `wf task create`.

```text
wf task delete [options] <task names...>
```

Arguments:

- `task names` — One or more task names (slugs) to remove, as shown by `wf task list`.

Options:

- `--repo <repository>` — Parent repository to disambiguate the named tasks; required when a name matches tasks in more than one repository.
- `-n`, `--dry-run` — Show which task worktrees and branches would be removed without deleting anything.
- `-f`, `--force` — Delete without the prompt and even when a task is dirty or unmerged; required without a terminal.

Examples:

- `wf task delete fix-login` — Delete one task worktree and its branch after confirming.
- `wf task delete fix-login add-tests --force` — Delete two tasks with no prompt, including dirty or unmerged ones.

## `wf worktree`

Manage standalone worktrees.

Create, list, and delete standalone worktrees — single git worktrees checked out from a cached bare mirror, each on its own branch, not tied to any workspace. Reach for these when you want one repository's worktree on its own. See also `wf task` for a worktree created inside a workspace.

```text
wf worktree <subcommand>
```

### `wf worktree create`

Create a standalone worktree.

Creates a git worktree from a cached bare mirror on a new branch, caching the mirror first if needed; the worktree is not attached to any workspace. The target path is `defaultDir/<repo>/<worktree-name>` unless `--dir` is passed. The branch is named for the worktree name using the configured `branchPrefix`. Changes your shell's directory into the new worktree under shell integration. See also `wf task create`.

```text
wf worktree create [options] <repository> <worktree name>
```

Arguments:

- `repository and worktree name` — The repository (cached name, `org/repo`, or git URL) followed by the worktree name — a slug of lowercase letters, digits, and single hyphens.

Options:

- `--dir <path>` — Write the worktree to this explicit path instead of `defaultDir/<repo>/<worktree-name>`.
- `-n`, `--dry-run` — Show the repository, branch, and target path without writing anything.

Examples:

- `wf worktree create vercel/next.js fix-router` — Check out a new worktree at `defaultDir/next.js/fix-router`.
- `wf worktree create <org/repo> <worktree-name> --dir <path>` — Place the worktree at an explicit path.

### `wf worktree list`

List standalone worktrees.

Lists standalone worktrees recorded against cached bare mirrors, showing each worktree's path, repository, branch, and whether it still exists on disk. With no argument, lists across all cached repositories. Exits 0 with a message when none match. See also `wf cache list`.

```text
wf worktree list [repository]
```

Arguments:

- `repository` — Limit the listing to one cached repository (a cached repo name or `org/repo`). Omit to list all.

Examples:

- `wf worktree list` — List every standalone worktree across all cached repositories.
- `wf worktree list <org/repo>` — List only the standalone worktrees of one cached repository.

### `wf worktree delete`

Delete a standalone worktree.

Removes the git worktree at the given path; this deletes its working directory and cannot be undone. Prompts for confirmation in a terminal; without a TTY it errors (exit 1) unless you pass `--force`. The cached bare mirror and its branch are left intact. See also `wf worktree create`.

```text
wf worktree delete [options] <worktree path>
```

Arguments:

- `worktree path` — Path to the standalone worktree directory to remove.

Options:

- `-n`, `--dry-run` — Show which worktree and branch would be removed without deleting anything.
- `-f`, `--force` — Skip the confirmation prompt; required to proceed without a terminal.

Examples:

- `wf worktree delete <path>` — Delete the worktree at the given path after confirming.
- `wf worktree delete <path> --force` — Delete without prompting; use this in scripts and non-interactive shells.

## `wf cache`

Manage cached repositories.

The cached bare mirrors that workforest clones from to create workspaces and worktrees live under `$WORKFOREST_CACHE_DIR`, fetched with `--filter=blob:none` to stay small. The usual lifecycle is `add` to clone, `update` to fetch, `doctor`/`repair` to check and fix, and `delete`/`prune` to reclaim space.

```text
wf cache <subcommand>
```

### `wf cache list`

List cached repositories.

Lists every cached bare mirror with its size, active worktree count, last-fetched time, and health, plus the cache directory and totals. Reads only the local cache; touches no network. Exits 0 with a message when the cache is empty. With `--json` it emits `{ "ok": true, "data": [ … ] }`. See also `wf cache info`.

```text
wf cache list [options]
```

Options:

- `--json` — Emit the cache inventory as a JSON envelope instead of the report.

Examples:

- `wf cache list` — List all cached mirrors with sizes and health.
- `wf cache list --json` — Emit the cache inventory as a JSON envelope for scripting.

### `wf cache info`

Show cached repository information.

Shows one cached bare mirror in detail: health, origin remote, default branch, size, last-fetched time, path, any integrity issues, and every registered worktree. Reads only the local cache. Errors (exit 1) if the repository is not cached. With `--json` it emits `{ "ok": true, "data": { … } }`. See also `wf cache list`.

```text
wf cache info [options] <repository>
```

Arguments:

- `repository` — A cached repo name, `org/repo` shorthand, full git URL, or cache directory name.

Options:

- `--json` — Emit the repository's record as a JSON envelope.

Examples:

- `wf cache info vercel/next.js` — Show full detail for one cached mirror.
- `wf cache info <org/repo> --json` — Emit one repository's record as a JSON envelope.

### `wf cache path`

Print a cached repository path.

Prints the absolute path of a cached bare mirror to stdout with no other output, for capture in `$(wf cache path …)`. With no argument, prints the cache directory itself. With a repository, errors (exit 1) if it is not cached. Touches no network.

```text
wf cache path [repository]
```

Arguments:

- `repository` — A cached repo name, `org/repo`, git URL, or directory name; omit for the cache directory.

Examples:

- `wf cache path` — Print the cache directory path for capture in a script.
- `cd "$(wf cache path vercel/next.js)"` — Capture one mirror's path and change into it.

### `wf cache add`

Cache repositories.

Clones one or more repositories as cached bare mirrors over the network, using `--filter=blob:none`. Each repository is reported independently: a failed clone does not stop the rest, and any failure exits 1. Run before creating a workspace so the mirror exists locally. See also `wf cache update` and `wf cache delete`.

```text
wf cache add <repositories...>
```

Arguments:

- `repositories` — One or more repositories: a cached name, `org/repo` shorthand, or full git URL.

Examples:

- `wf cache add vercel/next.js` — Clone one repository into the cache as a bare mirror.
- `wf cache add vercel/next.js facebook/react` — Clone several mirrors in one invocation.

### `wf cache update`

Update cached repositories.

Fetches new commits from the origin remote into cached bare mirrors over the network. With no repositories, updates every cached mirror; otherwise updates just those named. A failed fetch is reported and exits 1 but does not stop the others. Exits 0 with a message when the cache is empty. See also `wf cache add`.

```text
wf cache update [repositories...]
```

Arguments:

- `repositories` — Zero or more repositories to update; omit to update all cached mirrors.

Examples:

- `wf cache update` — Fetch new commits for every cached mirror.
- `wf cache update vercel/next.js` — Update one cached mirror.

### `wf cache doctor`

Check cached repositories.

Checks cached bare mirrors for integrity problems — missing origin remote, non-bare or unreadable repositories, and stale worktree registrations — and reports each one's health. With no repositories, checks every mirror. Reads only the local cache. Exits 1 if any checked repository is unhealthy (in both report and JSON modes). See also `wf cache repair`.

```text
wf cache doctor [options] [repositories...]
```

Arguments:

- `repositories` — Zero or more repositories to check; omit to check all cached mirrors.

Options:

- `--json` — Emit health records as a JSON envelope; exit code is still 1 if any are unhealthy.

Examples:

- `wf cache doctor` — Report health for every cached mirror.
- `wf cache doctor --json` — Emit health records as JSON; nonzero exit flags problems.

### `wf cache repair`

Repair cached repositories.

Repairs cached bare mirrors by pruning stale worktree registrations and running a connectivity-only fsck. With no repositories, repairs every mirror. Touches no network. Cannot repair a mirror that is not a valid bare git repository — that case is reported and the mirror must be deleted and re-added. See also `wf cache doctor`.

```text
wf cache repair [repositories...]
```

Arguments:

- `repositories` — Zero or more repositories to repair; omit to repair all cached mirrors.

Examples:

- `wf cache repair` — Prune and fsck every cached mirror.
- `wf cache repair vercel/next.js` — Repair one cached mirror after doctor flags it.

### `wf cache delete`

Delete cached repositories.

Permanently deletes cached bare mirrors from disk; the data must be re-cloned to use them again. Refuses (exit 1) any mirror that still has active worktrees unless you pass `--force`. Without a terminal it cannot prompt and exits 1; pass `--force` or `--dry-run` to proceed. See also `wf cache prune`.

```text
wf cache delete [options] <repositories...>
```

Arguments:

- `repositories` — One or more repositories to delete: a cached name, `org/repo`, URL, or directory name.

Options:

- `-n`, `--dry-run` — Show which mirrors would be deleted without removing anything.
- `-f`, `--force` — Skip the prompt and delete even mirrors with active worktrees; required without a terminal.

Examples:

- `wf cache delete <org/repo>` — Delete one cached mirror after confirming.
- `wf cache delete <org/repo> --force` — Delete without prompting, even with active worktrees.

### `wf cache prune`

Delete unused cached repositories.

Permanently deletes every cached bare mirror that has no active worktrees, reclaiming disk space; pruned data must be re-cloned to use again. Without a terminal it cannot prompt and exits 1; pass `--force` or `--dry-run` to proceed. Exits 0 with a message when nothing is unused. See also `wf cache delete`.

```text
wf cache prune [options]
```

Options:

- `-n`, `--dry-run` — Show which unused mirrors would be deleted without removing anything.
- `-f`, `--force` — Skip the confirmation prompt; required to proceed without a terminal.

Examples:

- `wf cache prune --dry-run` — List the unused mirrors prune would remove.
- `wf cache prune --force` — Delete all unused mirrors without prompting.

### `wf cache manage`

Open the repository cache manager.

Opens the interactive cache manager to browse cached bare mirrors and add, update, repair, delete, and prune them from one screen. Requires an interactive terminal; errors without one. For scripted access, use the individual `wf cache` subcommands.

```text
wf cache manage
```

Examples:

- `wf cache manage` — Open the interactive manager to inspect and maintain the cache.

## `wf review`

Manage review workspaces and PR worktrees.

Set up review workspaces and check out pull request worktrees inside them, for reviewing someone else's PR without disturbing your own workspaces. `wf review open` creates the per-repository review workspace; `wf review checkout` adds a worktree for a specific PR. Both store worktrees under the configured `reviewsDir`.

```text
wf review <subcommand>
```

### `wf review open`

Open a review workspace.

Sets up a review workspace for a repository: caches its bare mirror and adds a detached worktree under the configured `reviewsDir`. Reads `reviewsDir` from config; in a terminal it prompts for and saves the directory when unset, but without a TTY an unset `reviewsDir` is an operational failure (exit 1). Changes your shell's directory to the workspace under shell integration. See also `wf review checkout`.

```text
wf review open <repository>
```

Arguments:

- `repository` — The repository to review, as `org/repo`, a cached repo name, or a git URL.

Examples:

- `wf review open <owner>/<repo>` — Set up a review workspace for the repository, then enter it.

### `wf review checkout`

Check out a pull request worktree.

Adds a worktree for one pull request inside its review workspace, running `gh pr checkout` to fetch the PR branch — requires the `gh` CLI and network access. Run from inside a review workspace and you can pass just a PR number, taking the repository from the workspace's metadata. Reads `reviewsDir` from config (errors exit 1 without a TTY when unset). Changes your shell's directory to the worktree under shell integration. See also `wf review open`.

```text
wf review checkout <review target> [pull request]
```

Arguments:

- `review targets` — The PR to check out: a GitHub PR URL, `org/repo#<number>`, a bare `org/repo` slug, or — inside a review workspace — a bare `<number>`/`#<number>`. A second `[pull request]` argument gives the number, valid only when the target is a bare `org/repo` slug.

Examples:

- `wf review checkout <owner>/<repo>#<number>` — Check out a PR by compact org/repo and number.
- `wf review checkout <owner>/<repo> <number>` — Same target supplied as two space-separated arguments.
- `wf review checkout <number>` — From inside a review workspace, check out a PR using the workspace's repository.

## `wf template`

Manage templates.

Create, inspect, and maintain reusable workspace templates. A template names a set of repositories plus optional hooks, a branch prefix, and bundled files, stored at `~/.config/workforest/templates/<name>/template.jsonc`. Use `wf workspace create <template>` to build a workspace from one.

```text
wf template <subcommand>
```

### `wf template list`

List templates.

Lists every saved template with its description and repository set, and prints the templates directory. Exits 0 with a message when no templates exist. See also `wf template show` and `wf template new`.

```text
wf template list
```

Examples:

- `wf template list` — Show all saved templates and where they live on disk.

### `wf template open`

Open a template directory.

Resolves a template to its directory for editing its files by hand, changing your shell's directory there under shell integration; as the bare binary it prints the path instead. Errors if the template does not exist. See also `wf template show`.

```text
wf template open <template>
```

Arguments:

- `template` — Name of an existing template (lowercase, hyphen-separated).

Examples:

- `wf template open <template>` — Move into the template's directory to edit its files directly.

### `wf template show`

Show template information.

Prints one template's full configuration: description, effective branch prefix, bundled files directory if present, repository set, and any hooks, plus the path to its `template.jsonc`. Errors if the template does not exist. See also `wf template list` and `wf template edit`.

```text
wf template show <template>
```

Arguments:

- `template` — Name of an existing template (lowercase, hyphen-separated).

Examples:

- `wf template show <template>` — Print one template's repositories, hooks, and branch prefix.

### `wf template manage`

Open the template manager.

Opens an interactive manager to browse, create, edit, copy, and delete templates from one screen. Requires an interactive terminal; without a TTY (or under `$CI`/`$WORKFOREST_NO_TUI`) it falls back to `wf template list` and exits 0. For scripted use, drive the individual subcommands directly.

```text
wf template manage
```

Examples:

- `wf template manage` — Browse and edit all templates in an interactive screen.

### `wf template new`

Create a template.

Creates a new template directory and `template.jsonc` from a name and a repository set. In a terminal, prompts for anything missing; without a TTY the name and at least one repository are required, and omitting them is a usage error. Errors if a template with that name already exists. See also `wf template edit` and `wf workspace create <template>`.

```text
wf template new [options] [template] [repositories...]
wf template new [options] <template> <repositories...>
```

Arguments:

- `template and repositories` — A template name (lowercase, hyphen-separated), then one or more repositories (cached name, `org/repo`, or git URL). Both required without a TTY.

Options:

- `-d`, `--description <description>` — Set the template's description; otherwise prompted in a terminal.

Examples:

- `wf template new` — Prompt for the name, repositories, and description interactively.
- `wf template new my-stack vercel/next.js vercel/turborepo` — Create a template from two GitHub repositories, non-interactively.

### `wf template edit`

Edit a template.

Opens an interactive editor for one template's repositories, hooks, and branch prefix, saving changes back to its `template.jsonc`. Requires an interactive terminal; errors without one. To change a template in a script, edit its `template.jsonc` directly. See also `wf template show` and `wf template add-file`.

```text
wf template edit <template>
```

Arguments:

- `template` — Name of an existing template (lowercase, hyphen-separated).

Examples:

- `wf template edit <template>` — Edit one template's repositories and hooks interactively.

### `wf template add-file`

Add files to a template.

Copies files or directories into a template's `files/` directory so workspaces created from it start with those files. Without `--template`, run from inside a workspace to target its template. Prompts to resolve conflicts when a copied file differs from one already bundled. See also `wf template edit`.

```text
wf template add-file [options] <paths...>
```

Arguments:

- `paths` — One or more files or directories to copy into the template.

Options:

- `-t`, `--template <template>` — Template to add files to; otherwise inferred from the current workspace.

Examples:

- `wf template add-file -t my-stack .prettierrc tsconfig.base.json` — Bundle two config files into a named template.
- `wf template add-file .editorconfig` — From inside a workspace, add a file to that workspace's template.

### `wf template copy`

Copy a template.

Duplicates a template's full configuration under a new name, source then destination. Errors if the source does not exist or the destination name is taken; the new template is independent of the source. See also `wf template new` and `wf template edit`.

```text
wf template copy <source template> <destination template>
```

Arguments:

- `templates` — The source template name, then the new destination name (both lowercase, hyphen-separated).

Examples:

- `wf template copy my-stack my-stack-experimental` — Duplicate a template under a new name to modify independently.

### `wf template delete`

Delete a template.

Permanently removes a template's directory, including its `template.jsonc` and any bundled files; this cannot be undone. Prompts for confirmation in a terminal; without a TTY it refuses and exits 1 unless `--force` is passed. Existing workspaces created from it are unaffected. See also `wf template copy`.

```text
wf template delete [options] <template>
```

Arguments:

- `template` — Name of an existing template (lowercase, hyphen-separated).

Options:

- `-f`, `--force` — Skip the confirmation prompt; required to delete without a terminal.

Examples:

- `wf template delete <template>` — Delete a template after confirming at the prompt.
- `wf template delete <template> --force` — Delete without confirmation, e.g. in a script.

## `wf shell`

Manage shell integration.

Set up shell integration so directory-changing commands (`wf workspace create`/`open`/`delete`, `wf task`, `wf worktree`, `wf review`, `wf template open`) change your shell's working directory instead of just printing a path.

```text
wf shell <subcommand>
```

### `wf shell init`

Print shell integration.

Prints a shell integration script to stdout for `eval "$(wf shell init zsh)"`; the output is meant to be captured and nothing else is written to stdout. The script defines `wf`/`workforest` wrapper functions and completions and enables auto-cd. Pass `zsh` or `bash`, or omit to detect from `$SHELL`; an unsupported shell is a usage error. Add the `eval` line to your `.zshrc` or `.bashrc`.

```text
wf shell init [shell]
```

Arguments:

- `shell` — `zsh` or `bash`. Omit to detect from `$SHELL`.

Examples:

- `eval "$(wf shell init zsh)"` — Enable integration in the current zsh; put this in `.zshrc`.
- `eval "$(wf shell init bash)"` — Enable integration in bash; put this in `.bashrc`.

## `wf config`

Manage configuration.

Inspect and edit workforest's global settings — `defaultDir`, `reviewsDir`, `dirPrefix`, and `branchPrefix`, stored in `config.json` under `$WORKFOREST_CONFIG_DIR`. With no subcommand, `wf config` runs `wf config show`.

```text
wf config [subcommand]
```

Without a subcommand: Show configuration.

### `wf config show`

Show configuration.

Prints the resolved global configuration — `defaultDir`, `reviewsDir`, `dirPrefix`, `branchPrefix`, and any Vercel link settings — followed by the path of the `config.json` it read. Unset keys show their fallback behavior. Reads only; never writes. See also `wf config edit`.

```text
wf config show
```

Examples:

- `wf config show` — Print the current configuration and the file it came from.

### `wf config init`

Configure workforest interactively.

Walks through prompts for `defaultDir`, `reviewsDir`, `dirPrefix`, and `branchPrefix`, shows a preview, and on confirmation writes `config.json`. Requires an interactive terminal; errors without one (exit 1). To set values without a TTY, use `wf config edit`. See also `wf config show`.

```text
wf config init
```

Examples:

- `wf config init` — Set the directories and prefixes through guided prompts, then save.

### `wf config edit`

Open the configuration editor.

Opens `config.json` in your editor to change settings by hand, then reports when the editor closes. Uses `$EDITOR`, falling back to `$VISUAL`, then `vi`. Requires an interactive terminal; errors without one. See also `wf config init`.

```text
wf config edit
```

Examples:

- `wf config edit` — Open the config file in `$EDITOR` to change settings directly.

## `wf skills`

Inspect bundled agent skills.

List and read the agent skills bundled with workforest. These skills are written for AI coding agents driving `wf`, not for interactive use; start with the `core` skill. With no subcommand, `wf skills` runs `wf skills list`.

```text
wf skills [subcommand]
```

Without a subcommand: List bundled agent skills.

### `wf skills list`

List bundled agent skills.

Lists the available bundled skills with their names and descriptions; hidden skills are omitted. The `core` skill is the recommended starting point. With `--json` it emits `{ "ok": true, "data": [ … ] }`. See also `wf skills get`.

```text
wf skills list [options]
```

Options:

- `--json` — Emit the skill list as a JSON envelope instead of the report.

Examples:

- `wf skills list` — List every bundled skill with a one-line description.
- `wf skills list --json` — Get the skill list as a JSON envelope for programmatic use.

### `wf skills get`

Print bundled skill content.

Prints the full content of one or more skills to stdout, separated by `---`. Name one or more skills, or pass `--all` for every non-hidden skill (with no skill names). Naming an unknown skill exits 1. For an agent getting oriented, start with `get core`. With `--json` it emits the envelope instead of plain text. See also `wf skills list`.

```text
wf skills get [options] <skill names...>
wf skills get [options]
```

Arguments:

- `skill names` — One or more skill names to print. Omit only when using `--all`.

Options:

- `--full` — Also include the skill's supplementary `references/` and `templates/` files.
- `--all` — Print every non-hidden skill; takes no skill-name arguments.
- `--json` — Emit the JSON envelope instead of plain text.

Examples:

- `wf skills get core` — Print the `core` skill — the recommended starting point.
- `wf skills get core terminal-ui` — Print several named skills, separated by `---`.
- `wf skills get --all --full` — Print every skill, including its reference and template files.

### `wf skills path`

Print bundled skill paths.

Prints filesystem paths to stdout for capture in `$(…)`. With a skill name, prints that skill's directory; an unknown skill exits 1. With no name, prints the bundled skills directories, one per line. Nothing else is written to stdout. See also `wf skills get`.

```text
wf skills path [options] [skill]
```

Arguments:

- `skill` — A skill name whose directory to print. Omit to print the skills directories.

Options:

- `--json` — Emit a JSON envelope instead of bare paths.

Examples:

- `wf skills path core` — Print the `core` skill's directory for use in a script.
- `cat "$(wf skills path core)/SKILL.md"` — Capture a skill's directory and read a file from it.

## `wf help`

Show help pages.

Prints the overview help page, the conceptual glossary, or the recommended workflow guide. With no subcommand, `wf help` prints the same overview as `wf --help`.

```text
wf help [subcommand]
```

Without a subcommand: Show overview help.

### `wf help concepts`

Explain core concepts.

Describes the mental model behind workforest: what workspaces, tasks, templates, cached mirrors, and review workspaces are, and the git operations that underpin them.

```text
wf help concepts
```

Examples:

- `wf help concepts` — Read the conceptual glossary and the git model.

### `wf help workflow`

Show recommended workflows.

Describes recommended day-to-day workflows for both interactive users and AI agents, covering workspace creation, task management, PR review, and orientation patterns.

```text
wf help workflow
```

Examples:

- `wf help workflow` — Read the recommended workflows for users and agents.

## `wf version`

Print the workforest version.

Prints the installed workforest version to stdout as `workforest <version>`.

```text
wf version
```

Examples:

- `wf version` — Print the installed version.

## Shortcuts

Shortcuts preserve the published command surface while using the same parser and handler as their canonical commands.

### `wf new`

Shortcut for `wf workspace create`.

```text
wf new [options]
wf new [options] <templates or repositories...> -- <work words...>
wf new [options] -- <work words...>
```

### `wf clean`

Shortcut for `wf workspace delete`.

```text
wf clean [options] <workspace>
```
