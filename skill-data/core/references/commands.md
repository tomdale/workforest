# Workforest Command Reference

<!-- Generated from the executable registry. Do not edit directly. -->

All syntax is generated from the CLI command registry. Use `wf`; `workforest` remains an executable alias.

## Concepts

workforest creates isolated changes from cached repositories, so a feature can move one repo or several together without juggling branches in a single checkout.

- **change** — A repository or workspace lane managed by Workforest for one piece of work.
- **workspace** — A multi-repository change directory, branched and set up together.
- **task** — A short-lived nested worktree inside a managed change, on its own branch.
- **template** — A saved repository set, plus hooks and files, to start workspaces from.
- **cached mirror** — A local bare clone each worktree is built from, kept for fast offline setup.
- **review workspace** — A workspace for reviewing someone's pull request (wf review).

## Conventions

Exit codes: `0` success, `2` usage error (invalid arguments or flags), `1` operational failure.

Commands whose options include `--json` emit a machine-readable envelope: `{ "ok": true, "data": ... }` on success, or `{ "ok": false, "error": { "kind": "operational" | "usage", "message": ... } }` on failure.

## `wf start`

Start a change.

Creates a new Workforest change. A single repository source creates `Repos/<repo>/<change>`, an `@template` source creates `Workspaces/<template>/<change>`, and multiple repository sources create `Workspaces/_adhoc/<change>`. With only a change name, repeats the current Workforest-managed context.

```text
wf start [options] <change> [source...]
```

Arguments:

- `arguments` — A change name, optionally followed by one repository, multiple repositories, or one @template source.

Options:

- `--branch <branch>` — Use this exact Git branch name instead of deriving one from `branchPrefix` and <change>.

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

## `wf migrate`

Migrate Workforest layouts.

Runs one-time migrations for Workforest-managed data layouts.

```text
wf migrate <subcommand>
```

### `wf migrate workspaces`

Migrate workspace layouts and repository metadata.

Moves metadata-bearing direct workspace directories into the grouped workspace layout, moves legacy repo-only directories from <repo>/<change> into Repos/<repo>/<change>, and backfills repository-change metadata under Repos/<repo>/.workforest/changes/<change>.json. Without --apply it prints the migration plan and makes no changes.

```text
wf migrate workspaces [options]
```

Options:

- `--apply` — Move directories and write repository metadata. Omit to preview the migration plan only.
- `--json` — Emit the migration result as a JSON envelope instead of the report.

Examples:

- `wf migrate workspaces` — Preview workspace moves, repository directory moves, and repository metadata backfills.
- `wf migrate workspaces --apply` — Apply workspace moves, repository directory moves, and repository metadata backfills.

## `wf task`

Manage temporary task worktrees.

Create, finish, list, and abandon short-lived task worktrees inside an existing Workforest change, each on its own branch off a parent repository's current HEAD. Run these from inside a workspace repo, repository change, or existing task.

```text
wf task <subcommand>
```

### `wf task start`

Start nested task lanes.

Adds one or more nested task worktrees under the current change's reserved _tasks directory, each on a new branch off the parent repository's committed HEAD, then runs setup initializers. Run from inside a workspace repo, repository change, or existing task; in workspaces, the parent repository is inferred from the current directory unless set with `--repo`. Refuses to run when the parent has uncommitted changes unless you pass `--force`. When one task is started, changes your shell's directory to it under shell integration. See also `wf task finish` and `wf task delete`.

```text
wf task start [options] <task names...>
```

Arguments:

- `task names` — One or more task names, each a slug (lowercase words separated by hyphens); each names a worktree and its branch.

Options:

- `--repo <repository>` — Parent repository in a workspace to branch from; defaults to the one inferred from the current directory.
- `-n`, `--dry-run` — Show the worktrees and branches that would be created without writing anything.
- `-f`, `--force` — Create even when the parent repository has uncommitted changes.

Examples:

- `wf task start fix-login` — Start one task lane off the inferred parent repo and cd into it.
- `wf task start fix-login add-tests --repo web` — Start two task lanes branched from the `web` repository.

### `wf task list`

List temporary worktrees.

Lists task worktrees for the current managed change, grouped by parent repository. Shows each task's branch, setup status, merge state, and path. In workspaces, the parent repository is inferred from the current directory unless `--repo` scopes the list. Exits 0 with a message when no tasks match.

```text
wf task list [options]
```

Options:

- `--repo <repository>` — Limit the list to tasks whose parent is this repository in the current workspace.

Examples:

- `wf task list` — List every task tracked in the current managed change.
- `wf task list --repo web` — List only tasks branched from the `web` repository.

### `wf task finish`

Finish integrated task lanes.

Removes one or more clean task worktrees after verifying their branches are reachable from the parent repository. Run from inside a managed change. Use `wf task delete --force` for abandoned, dirty, or intentionally unmerged task lanes.

```text
wf task finish [options] <task names...>
```

Arguments:

- `task names` — One or more task names (slugs) to finish, as shown by `wf task list`.

Options:

- `--repo <repository>` — Parent workspace repository to disambiguate the named tasks; required when a name matches tasks in more than one workspace repository.
- `-n`, `--dry-run` — Show which task worktrees and branches would be removed without deleting anything.

Examples:

- `wf task finish fix-login` — Finish one integrated task lane.
- `wf task finish fix-login add-tests --repo web` — Finish two integrated task lanes branched from the `web` repository.

### `wf task delete`

Delete temporary worktrees.

Explicitly abandons one or more task worktrees and deletes their branches; this cannot be undone. Run from inside a managed change. Refuses a task with uncommitted changes or an unmerged branch unless you pass `--force`. Prompts for confirmation in a terminal; without a TTY it exits 1 unless `--force` or `--dry-run` is given. See also `wf task finish`.

```text
wf task delete [options] <task names...>
```

Arguments:

- `task names` — One or more task names (slugs) to remove, as shown by `wf task list`.

Options:

- `--repo <repository>` — Parent workspace repository to disambiguate the named tasks; required when a name matches tasks in more than one workspace repository.
- `-n`, `--dry-run` — Show which task worktrees and branches would be removed without deleting anything.
- `-f`, `--force` — Delete without the prompt and even when a task is dirty or unmerged; required without a terminal.

Examples:

- `wf task delete fix-login` — Delete one task worktree and its branch after confirming.
- `wf task delete fix-login add-tests --force` — Delete two tasks with no prompt, including dirty or unmerged ones.

## `wf cache`

Manage cached repositories.

The cached bare mirrors that workforest clones from to create changes and task worktrees live under `$WORKFOREST_CACHE_DIR`, fetched with `--filter=blob:none` to stay small. The usual lifecycle is `sync` to clone or fetch, `check --fix` to inspect and repair, and `delete`/`clean` to reclaim space.

```text
wf cache <subcommand>
```

### `wf cache list`

List cached repositories.

Lists every cached bare mirror with its size, active worktree count, last-fetched time, and health, plus the cache directory and totals. Reads only the local cache; touches no network. Exits 0 with a message when the cache is empty. With `--json` it emits `{ "ok": true, "data": [ … ] }`. See also `wf cache show`.

```text
wf cache list [options]
```

Options:

- `--json` — Emit the cache inventory as a JSON envelope instead of the report.

Examples:

- `wf cache list` — List all cached mirrors with sizes and health.
- `wf cache list --json` — Emit the cache inventory as a JSON envelope for scripting.

### `wf cache show`

Show cached repository information.

Shows one cached bare mirror in detail: health, origin remote, default branch, size, last-fetched time, path, any integrity issues, and every registered worktree. Reads only the local cache. Errors (exit 1) if the repository is not cached. With `--json` it emits `{ "ok": true, "data": { … } }`. With `--path`, prints the cache root or selected mirror path with no decoration.

```text
wf cache show [options] [repository]
wf cache show [options] <repository>
```

Arguments:

- `repository` — A cached repo name, `org/repo` shorthand, full git URL, or cache directory name.

Options:

- `--json` — Emit the repository's record as a JSON envelope.
- `--path` — Print the cache root or selected mirror path with no decoration.

Examples:

- `wf cache show vercel/next.js` — Show full detail for one cached mirror.
- `wf cache show <org/repo> --json` — Emit one repository's record as a JSON envelope.
- `wf cache show --path` — Print the cache directory path for capture in a script.
- `cd "$(wf cache show vercel/next.js --path)"` — Capture one mirror's path and change into it.

### `wf cache sync`

Sync cached repositories.

Fetches new commits for existing cached mirrors, or clones missing repository specifiers as cached bare mirrors over the network using `--filter=blob:none`. With no repositories, syncs every cached mirror. Each repository is reported independently: a failed sync does not stop the rest, and any failure exits 1.

```text
wf cache sync [repositories...]
```

Arguments:

- `repositories` — Zero or more repositories: a cached name, `org/repo` shorthand, or full git URL.

Examples:

- `wf cache sync` — Fetch new commits for every cached mirror.
- `wf cache sync vercel/next.js facebook/react` — Update cached matches and clone missing mirrors in one invocation.

### `wf cache check`

Check cached repositories.

Checks cached bare mirrors for integrity problems — missing origin remote, non-bare or unreadable repositories, and stale worktree registrations — and reports each one's health. With no repositories, checks every mirror. Reads only the local cache unless `--fix` is passed. Exits 1 if any checked repository is unhealthy (in both report and JSON modes).

```text
wf cache check [options] [repositories...]
```

Arguments:

- `repositories` — Zero or more repositories to check; omit to check all cached mirrors.

Options:

- `--fix` — Repair selected mirrors before reporting health.
- `--json` — Emit health records as a JSON envelope; exit code is still 1 if any are unhealthy.

Examples:

- `wf cache check` — Report health for every cached mirror.
- `wf cache check --json` — Emit health records as JSON; nonzero exit flags problems.
- `wf cache check vercel/next.js --fix` — Repair one cached mirror before reporting health.

### `wf cache delete`

Delete cached repositories.

Permanently deletes cached bare mirrors from disk; the data must be re-cloned to use them again. Refuses (exit 1) any mirror that still has active worktrees unless you pass `--force`. Without a terminal it cannot prompt and exits 1; pass `--force` or `--dry-run` to proceed. See also `wf cache clean`.

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

### `wf cache clean`

Delete unused cached repositories.

Permanently deletes every cached bare mirror that has no active worktrees, reclaiming disk space; cleaned data must be re-cloned to use again. Without a terminal it cannot prompt and exits 1; pass `--force` or `--dry-run` to proceed. Exits 0 with a message when nothing is unused. See also `wf cache delete`.

```text
wf cache clean [options]
```

Options:

- `-n`, `--dry-run` — Show which unused mirrors would be deleted without removing anything.
- `-f`, `--force` — Skip the confirmation prompt; required to proceed without a terminal.

Examples:

- `wf cache clean --dry-run` — List the unused mirrors clean would remove.
- `wf cache clean --force` — Delete all unused mirrors without prompting.

## `wf review`

Manage review workspaces and PR worktrees.

Set up review workspaces and check out pull request worktrees inside them, for reviewing someone else's PR without disturbing your own workspaces. `wf review open` creates the per-repository review workspace; `wf review checkout` adds a worktree for a specific PR. Both store worktrees under `directory.reviews`.

```text
wf review <subcommand>
```

### `wf review open`

Open a review workspace.

Sets up a review workspace for a repository: caches its bare mirror and adds a detached worktree under `directory.reviews`, defaulting to `~/Code/Reviews`. Changes your shell's directory to the workspace under shell integration. See also `wf review checkout`.

```text
wf review open <repository>
```

Arguments:

- `repository` — The repository to review, as `org/repo`, a cached repo name, or a git URL.

Examples:

- `wf review open <owner>/<repo>` — Set up a review workspace for the repository, then enter it.

### `wf review checkout`

Check out a pull request worktree.

Adds a worktree for one pull request inside its review workspace, running `gh pr checkout` to fetch the PR branch — requires the `gh` CLI and network access. Run from inside a review workspace and you can pass just a PR number, taking the repository from the workspace's metadata. Uses `directory.reviews`, defaulting to `~/Code/Reviews`. Changes your shell's directory to the worktree under shell integration. See also `wf review open`.

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

Create, inspect, and maintain reusable workspace templates. A template names a set of repositories plus optional hooks, a branch prefix, and bundled files, stored at `~/.config/workforest/templates/<name>/template.jsonc`. Use `wf start <change> @<template>` to build a workspace from one.

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

Creates a new template directory and `template.jsonc` from a name and a repository set. In a terminal, prompts for anything missing; without a TTY the name and at least one repository are required, and omitting them is a usage error. Errors if a template with that name already exists. See also `wf template edit` and `wf start <change> @<template>`.

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

Set up shell integration so directory-changing commands (`wf start`, `wf switch`, `wf finish`, `wf delete`, `wf task`, `wf review`, and `wf template open`) change your shell's working directory instead of just printing a path.

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

Inspect and edit workforest's global settings, including `directory.base`, optional directory children, `branchPrefix`, and Vercel link settings stored in `config.json` under `$WORKFOREST_CONFIG_DIR`. With no subcommand, `wf config` runs `wf config show`.

```text
wf config [subcommand]
```

Without a subcommand: Show configuration.

### `wf config show`

Show configuration.

Prints the resolved global configuration, including checkout directories, branch prefix, and any Vercel link settings, followed by the path of the `config.json` it read. Unset keys show their fallback behavior. Reads only; never writes. See also `wf config edit`.

```text
wf config show
```

Examples:

- `wf config show` — Print the current configuration and the file it came from.

### `wf config init`

Configure workforest interactively.

Walks through prompts for the main checkout directories and branch prefix, shows a preview, and on confirmation writes `config.json`. Requires an interactive terminal; errors without one (exit 1). To set values without a TTY or to use the final nested `directory` shape directly, use `wf config edit`. See also `wf config show`.

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
