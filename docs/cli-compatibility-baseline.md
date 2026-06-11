# CLI Compatibility Baseline

## Published npm contract

The `workforest@0.0.1` package was published on January 24, 2026. Registry
metadata reported this integrity:

`sha512-L8RlLxW4N5K11a7KSMWvL0f6GH1Z3BvyBSJXyr/VpbLtGrIrqt1QuzKUgaPgOrPBzEdbaSAf6b2XdnyjxYdlqA==`

Inspection of the published tarball found exactly four root commands:

- `new`
- `clean`
- `config`
- `template`

The published package exposed both `wf` and `workforest` executables. The
template namespace accepted `list` (`ls`), `show`, `new` (`create`), `delete`
(`rm`), and `edit`.

The machine-readable copy used by tests is
`src/test-fixtures/workforest-0.0.1-command-contract.json`. Of the published
root commands, `new` and `clean` are the shortcuts that the resource-first CLI
redesign must retain.

## Personal consumer audit

On June 11, 2026, the following read-only locations were searched for
invocations of commands added after the npm publication:

- `~/.config`
- `~/.local/bin`
- `~/bin`
- `~/.local/share/chezmoi`
- the home-directory zsh, bash, and profile startup files

The search excluded Git metadata, dependency directories, environment files,
and files whose names indicated secrets, credentials, or tokens.

One unique shell-initialization invocation using the superseded root form was
found. Its supported replacement is:

```sh
eval "$(wf shell init zsh)"
```

The existing invocation appears in the active config at
`~/.config/zsh/.zshrc:117` and in its chezmoi source at
`~/.local/share/chezmoi/home/dot_config/zsh/dot_zshrc:117`.

No invocations of the other post-publication commands were found in the audit
scope. Generated zsh completion registration and a symlink to the `wf`
executable were present, but neither invokes a command.

Shell initialization therefore has a real personal consumer. The active dotfile
and its chezmoi source must be updated as part of the command migration. The
audit found no evidence requiring compatibility aliases for the other
post-publication command forms.
