# Workforest Command Reference

<!-- Generated from the executable registry. Do not edit directly. -->

All syntax is generated from the CLI command registry. Use `wf`; `workforest` remains an executable alias.

## `wf workspace`

Manage workspaces.

```text
wf workspace <subcommand>
```

### `wf workspace create`

Create a workspace.

```text
wf workspace create [options]
wf workspace create [options] <templates or repositories...> -- <work words...>
wf workspace create [options] -- <work words...>
```

Options:

- `--like <workspace>`
- `-d`, `--description <description>`
- `-n`, `--dry-run`

### `wf workspace delete`

Delete a workspace.

```text
wf workspace delete [options] <workspace>
```

Options:

- `-n`, `--dry-run`
- `-f`, `--force`
- `--delete-mirrors`
- `-r`, `--delete-remote-branches`

### `wf workspace open`

Open a workspace.

```text
wf workspace open [options] [workspace]
wf workspace open [options]
```

Options:

- `--search`

### `wf workspace list`

List workspaces.

```text
wf workspace list
```

### `wf workspace status`

Show repository initialization status.

```text
wf workspace status [options]
```

Options:

- `--json`
- `-w`, `--workspace <dir>`

### `wf workspace add`

Add repositories to a workspace.

```text
wf workspace add [options] [repositories...]
wf workspace add [options] <repositories...>
```

Options:

- `-w`, `--workspace <dir>`
- `-n`, `--dry-run`

## `wf task`

Manage temporary workspace tasks.

```text
wf task <subcommand>
```

### `wf task create`

Create temporary worktrees.

```text
wf task create [options] <task names...>
```

Options:

- `--repo <repository>`
- `-n`, `--dry-run`
- `-f`, `--force`

### `wf task list`

List temporary worktrees.

```text
wf task list [options]
```

Options:

- `--repo <repository>`

### `wf task delete`

Delete temporary worktrees.

```text
wf task delete [options] <task names...>
```

Options:

- `--repo <repository>`
- `-n`, `--dry-run`
- `-f`, `--force`

## `wf worktree`

Manage standalone worktrees.

```text
wf worktree <subcommand>
```

### `wf worktree create`

Create a standalone worktree.

```text
wf worktree create [options] <repository and worktree name>
```

Options:

- `--dir <path>`
- `-n`, `--dry-run`

### `wf worktree list`

List standalone worktrees.

```text
wf worktree list [repository]
```

### `wf worktree delete`

Delete a standalone worktree.

```text
wf worktree delete [options] <worktree path>
```

Options:

- `-n`, `--dry-run`
- `-f`, `--force`

## `wf cache`

Manage cached repositories.

```text
wf cache <subcommand>
```

### `wf cache list`

List cached repositories.

```text
wf cache list [options]
```

Options:

- `--json`

### `wf cache info`

Show cached repository information.

```text
wf cache info [options] <repository>
```

Options:

- `--json`

### `wf cache path`

Print a cached repository path.

```text
wf cache path [repository]
```

### `wf cache add`

Cache repositories.

```text
wf cache add <repositories...>
```

### `wf cache update`

Update cached repositories.

```text
wf cache update [repositories...]
```

### `wf cache doctor`

Check cached repositories.

```text
wf cache doctor [options] [repositories...]
```

Options:

- `--json`

### `wf cache repair`

Repair cached repositories.

```text
wf cache repair [repositories...]
```

### `wf cache delete`

Delete cached repositories.

```text
wf cache delete [options] <repositories...>
```

Options:

- `-n`, `--dry-run`
- `-f`, `--force`

### `wf cache prune`

Delete unused cached repositories.

```text
wf cache prune [options]
```

Options:

- `-n`, `--dry-run`
- `-f`, `--force`

### `wf cache manage`

Open the repository cache manager.

```text
wf cache manage
```

## `wf review`

Manage review workspaces and PR worktrees.

```text
wf review <subcommand>
```

### `wf review open`

Open a review workspace.

```text
wf review open <repository>
```

### `wf review checkout`

Check out a pull request worktree.

```text
wf review checkout <review targets>
```

## `wf template`

Manage templates.

```text
wf template <subcommand>
```

### `wf template list`

List templates.

```text
wf template list
```

### `wf template open`

Open a template directory.

```text
wf template open <template>
```

### `wf template show`

Show template information.

```text
wf template show <template>
```

### `wf template manage`

Open the template manager.

```text
wf template manage
```

### `wf template new`

Create a template.

```text
wf template new [options] [template and repositories...]
wf template new [options] <template and repositories...>
```

Options:

- `-d`, `--description <description>`

### `wf template edit`

Edit a template.

```text
wf template edit <template>
```

### `wf template add-file`

Add files to a template.

```text
wf template add-file [options] <paths...>
```

Options:

- `-t`, `--template <template>`

### `wf template copy`

Copy a template.

```text
wf template copy <templates>
```

### `wf template delete`

Delete a template.

```text
wf template delete [options] <template>
```

Options:

- `-f`, `--force`

## `wf shell`

Manage shell integration.

```text
wf shell <subcommand>
```

### `wf shell init`

Print shell integration.

```text
wf shell init [shell]
```

## `wf config`

Manage configuration.

```text
wf config [subcommand]
```

Without a subcommand: Show configuration.

### `wf config show`

Show configuration.

```text
wf config show
```

### `wf config init`

Configure workforest interactively.

```text
wf config init
```

### `wf config edit`

Open the configuration editor.

```text
wf config edit
```

## `wf skills`

Inspect bundled agent skills.

```text
wf skills [subcommand]
```

Without a subcommand: List bundled agent skills.

### `wf skills list`

List bundled agent skills.

```text
wf skills list [options]
```

Options:

- `--json`

### `wf skills get`

Print bundled skill content.

```text
wf skills get [options] <skill names...>
wf skills get [options]
```

Options:

- `--full`
- `--all`
- `--json`

### `wf skills path`

Print bundled skill paths.

```text
wf skills path [options] [skill]
```

Options:

- `--json`

## `wf version`

Print the workforest version.

```text
wf version
```

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
