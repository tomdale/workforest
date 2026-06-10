# Workforest Terminal Experience Inventory

Status values:

- **Canonical:** matches the current target conventions.
- **Intentional raw:** must remain undecorated for composition or scripting.
- **Partial:** functional, but still has inconsistent layout or implementation.
- **Audit needed:** not yet verified in a real PTY and fallback environment.

## Shared Foundations

| Experience | Implementation | Status |
| --- | --- | --- |
| Terminal lifecycle, raw mode, cursor restoration | `src/terminal/session.ts` | Canonical |
| Inline redraw surface | `src/terminal/inline-surface.ts` | Canonical |
| Text, confirm, select, multi-select, fuzzy-select | `src/ui/prompts/`, `src/terminal/inline-widgets.ts` | Canonical |
| Spinner and prompt timeline | `src/ui/prompts/spinner.ts`, `src/ui/prompts/index.ts` | Canonical |
| Palette and semantic symbols | `src/terminal/theme.ts` | Canonical |
| Fullscreen screen and status line | `src/terminal/fullscreen-surface.ts` | Canonical |
| Subprocess stream adaptation | `src/terminal/command-stream-adapter.ts` | Canonical |
| Plain status logger | `src/logger.ts` | Canonical |

## Fullscreen And Interactive Experiences

| Experience | Entry point | Implementation | Status |
| --- | --- | --- | --- |
| New workspace wizard | `wf new` without selections | `src/ui/new-wizard.ts` | Canonical |
| Parallel repository setup grid | `wf new`, `wf add`, `wf fork`, temporary worktree setup | `src/ui/grid-consumer.ts`, `src/ui/grid-layout.ts` | Canonical |
| Background initialization status grid | `wf status` inside a workspace | `src/ui/initialization-status.ts`, `src/ui/grid-layout.ts` | Canonical |
| Workspace completion modal and next steps | End of setup grid | `src/ui/grid-consumer.ts` | Canonical |
| Template browser and manager | `wf templates` | `src/ui/template-manager.ts` | Canonical |
| Cached repository browser and manager | `wf repositories` | `src/ui/repository-manager.ts` | Canonical |
| Template create/edit/copy forms | Template manager and `wf template new/edit/copy` | Prompt timeline with preview and confirmation in `src/ui/index.ts` | Canonical |
| Template file conflict resolution | `wf template add-file` | Select and confirm prompts in `src/cli.ts` | Canonical |
| Workspace picker | `wf cd` | Select prompt in `src/cli.ts` | Canonical |
| Fuzzy workspace finder | `wf find` | Fuzzy-select prompt in `src/cli.ts` | Canonical |
| Config initialization | `wf config init` | Prompt timeline with preview and confirmation in `src/cli.ts` | Canonical |
| Reviews directory first-run prompt | `wf review` without configured directory | Text prompt in `src/cli.ts` | Canonical |
| Delete target selection and confirmations | `wf delete`, worktree/review/template/workspace delete | Select and confirm prompts in `src/cli.ts` | Canonical |
| Cleanup preview | `wf workspace delete`, `wf clean` | Prompt note in `src/cli.ts` | Canonical |
| External editor handoff | `wf config edit` | Status line, inherited editor session, completion status | Canonical |
| Template directory jump | `wf template show` | Shell auto-cd handoff or explicit `cd` status line | Canonical |
| Spinner fallback for setup | Small terminal, CI, too many repos, or `WORKFOREST_NO_TUI` | Prompt spinner and generator consumers | Canonical |
| Dev simulator | `wf dev simulate new|confetti` | `src/dev-simulator.ts` | Canonical |

## Static Human-Readable Experiences

| Experience | Entry point | Status |
| --- | --- | --- |
| Top-level, scoped, nested, and simulator help | `wf --help`, `<command> --help`, nested `--help` | Canonical |
| Version | `wf version` | Canonical |
| Workspace list | `wf list` | Canonical |
| Config report | `wf config show` | Canonical |
| Review worktree list | `wf review list` | Canonical |
| Temporary worktree list | `wf worktree list` | Canonical |
| Template list | `wf template list` | Canonical |
| Template info | `wf template info` | Canonical |
| Cached repository list, info, and health | `wf repository list|info|doctor` | Canonical |
| Skills list | `wf skills list` | Canonical |
| Dry-run reports for new/add/fork/worktree/review/delete | `--dry-run` variants | Canonical |
| Non-interactive cleanup preview | `wf workspace delete`, `wf clean` outside a TTY | Canonical |
| Fallback workspace next steps | Workspace setup without the fullscreen grid | Canonical |
| Success, warning, error, and informational status lines | All commands | Canonical |
| Empty states | List and lookup commands | Canonical |

Human-readable reports use `src/terminal/report.ts`. Inline status and empty
states use the shared semantic logger or prompt timeline.

## Intentional Raw And Composable Output

| Experience | Entry point | Contract |
| --- | --- | --- |
| Shell integration source | `wf init zsh|bash` | Exact shell program on stdout |
| Auto-cd handoff | Shell wrapper path file | Exact path data |
| Skill content | `wf skills get` | Exact Markdown content |
| Skill paths | `wf skills path` | Exact filesystem paths |
| Skills JSON | `wf skills ... --json` | One JSON value, no decoration |
| Repository cache JSON | `wf repository list|info|doctor --json` | One JSON value, no decoration |
| Repository cache paths | `wf repository path [repo]` | Exact filesystem path |
| Unified template file diff | `wf template add-file` conflict action | Preserve standard unified diff text |
| Child command stdout/stderr | Setup commands, hooks, review checkout | Preserve original stream bytes |

Do not add headings, symbols, colors, blank-line framing, or explanatory prose
to these surfaces.

## Paged Output

Workforest currently has no pager-owned experience. If a report becomes large
enough to require paging, keep generation separate from pager invocation,
respect `PAGER`, bypass paging outside a TTY, and retain a direct-output mode.

## Verification Matrix

Use project commands in review instructions:

```sh
pnpm test
pnpm typecheck
pnpm lint
```

Exercise rich interfaces in a fixed PTY:

```sh
tmux new-session -d -s wf-ui -x 120 -y 40
tmux send-keys -t wf-ui 'pnpm exec tsx bin/workforest.js dev simulate new --speed fast' Enter
tmux capture-pane -t wf-ui -p
tmux kill-session -t wf-ui
```

Exercise fallbacks and raw contracts:

```sh
WORKFOREST_NO_TUI=1 pnpm exec tsx bin/workforest.js dev simulate new --speed fast
pnpm exec tsx bin/workforest.js skills list --json
pnpm exec tsx bin/workforest.js init zsh
```
