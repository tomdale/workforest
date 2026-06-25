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
| Change start flow | `wf start` setup output | `src/cli/start.ts` | Canonical |
| Parallel repository setup grid | `wf start`, `wf add`, task setup | `src/ui/grid-consumer.ts`, `src/ui/grid-layout.ts` | Canonical |
| Background initialization status grid | `wf status --watch` inside a change | `src/ui/initialization-status.ts`, `src/ui/grid-layout.ts` | Canonical |
| Workspace completion modal and next steps | End of setup grid | `src/ui/grid-consumer.ts` | Canonical |
| Template browser and manager | `wf template manage` | `src/ui/template-manager.ts` | Canonical |
| Cached repository browser and manager | `wf cache manage` | `src/ui/repository-manager.ts` | Canonical |
| Template create/edit/copy forms | `wf template manage` | Prompt timeline with preview and confirmation in `src/ui/index.ts` | Canonical |
| Template file conflict resolution | Template manager | Select and confirm prompts in `src/cli.ts` | Canonical |
| Workspace picker | `wf switch` | Select prompt in `src/cli.ts` | Canonical |
| Fuzzy workspace finder | `wf switch` | Fuzzy-select prompt in `src/cli.ts` | Canonical |
| Config initialization | `wf config init` | Prompt timeline with preview and confirmation in `src/cli.ts` | Canonical |
| Reviews directory first-run prompt | `wf review open` without a configured directory | Text prompt in `src/cli.ts` | Canonical |
| Delete confirmations | Explicit change, task, template, and cache delete commands | Select and confirm prompts in `src/cli.ts` | Canonical |
| Cleanup preview | `wf finish <selector>`, `wf delete <selector>` | Prompt note in `src/cli.ts` | Canonical |
| External editor handoff | `wf config edit` | Status line, inherited editor session, completion status | Canonical |
| Template directory jump | `wf template open` | Shell auto-cd handoff or explicit `cd` status line | Canonical |
| Spinner fallback for setup | Small terminal, CI, too many repos, or `WORKFOREST_NO_TUI` | Prompt spinner and generator consumers | Canonical |

## Static Human-Readable Experiences

| Experience | Entry point | Status |
| --- | --- | --- |
| Top-level, scoped, and nested help | `wf --help`, `<command> --help`, nested `--help` | Canonical |
| Version | `wf version` | Canonical |
| Change list | `wf list` | Canonical |
| Config report | `wf config show` | Canonical |
| Task inventory | `wf task list` | Canonical |
| Template details | `wf template show` | Canonical |
| Cached repository list, info, and health | `wf cache list|info|doctor` | Canonical |
| Skills list | `wf skills list` | Canonical |
| Dry-run reports for task and cache operations | `--dry-run` variants | Canonical |
| Non-interactive cleanup preview | Explicit change deletion outside a TTY | Canonical |
| Fallback workspace next steps | Workspace setup without the fullscreen grid | Canonical |
| Success, warning, error, and informational status lines | All commands | Canonical |
| Empty states | List and lookup commands | Canonical |

Human-readable reports use `src/terminal/report.ts`. Inline status and empty
states use the shared semantic logger or prompt timeline.

## Intentional Raw And Composable Output

| Experience | Entry point | Contract |
| --- | --- | --- |
| Shell integration source | `wf shell init zsh|bash` | Exact shell program on stdout |
| Auto-cd handoff | Shell wrapper path file | Exact path data |
| Skill content | `wf skills get` | Exact Markdown content |
| Skill paths | `wf skills path` | Exact filesystem paths |
| Skills JSON | `wf skills ... --json` | One JSON value, no decoration |
| Repository cache JSON | `wf cache list|info|doctor --json` | One JSON value, no decoration |
| Repository cache paths | `wf cache path [repo]` | Exact filesystem path |
| Unified template file diff | Template manager conflict action | Preserve standard unified diff text |
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

Exercise fallbacks and raw contracts:

```sh
pnpm exec tsx bin/workforest.js skills list --json
pnpm exec tsx bin/workforest.js shell init zsh
```
