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
| Entry surface (go to or create a worktree or workspace) | bare `wf` (go-or-create), `wf new` (create-only) | `src/entry/surface.ts` (Phase 1 name/existing omni-prompt → Phase 2 source accumulation), `src/terminal/fuzzy-list.ts`, hands off to the setup view via `src/workspace/create.ts` | Audit needed |
| Creation flow | `wf new <name> <source…>` setup output | `src/cli/new.ts` → `src/workspace/create.ts` → `src/ui/setup-view/present.ts` | Canonical |
| Parallel repository setup grid | `wf new`, `wf status --watch` | `src/ui/setup-view/{grid-view,model,pager}.ts`, `src/ui/grid-layout.ts`; renders from the run event log (`src/workspace/run-log/`) with terminal-sized pane layout, merged single-line borders with junctions, pane zoom, paging, a `?` help overlay, detach, and graceful cancel; setup commands run under a real pseudo-terminal for colored output and in-place progress (falls back to plain pipes if unavailable; forced via `WORKFOREST_NO_PTY=1`); completion holds until a keypress | Canonical |
| Legacy pipeline grid (compat) | `wf add`, task setup, review, cloud | `src/ui/grid-consumer.ts` (>9 repos route through `src/ui/setup-view/compat.ts`) | Canonical |
| Setup scrollback summary | Every setup grid or console exit path | `src/ui/setup-view/summary.ts` | Canonical |
| Setup run log report | `wf init logs` | `src/workspace/run-log/render.ts` | Canonical |
| Workspace completion modal and next steps | End of setup grid | `src/ui/grid-consumer.ts` | Canonical |
| Template browser and manager | `wf template list|show|open` | Template command handlers in `src/cli.ts` | Canonical |
| Template create/edit/copy forms | `wf template new|edit|copy` | Prompts in `src/cli.ts` | Canonical |
| Template file conflict resolution | `wf template add-file` | Select and confirm prompts in `src/cli.ts` | Canonical |
| Workspace picker | `wf switch` | Select prompt in `src/cli.ts` | Canonical |
| Fuzzy workspace finder | `wf switch` | Fuzzy-select prompt in `src/cli.ts` | Canonical |
| Config initialization | `wf config init` | Prompt timeline with preview and confirmation in `src/cli.ts` | Canonical |
| Reviews directory first-run prompt | `wf review open` without a configured directory | Text prompt in `src/cli.ts` | Canonical |
| Delete confirmations | Explicit change, task, template, and cache delete commands | Select and confirm prompts in `src/cli.ts` | Canonical |
| Cleanup preview | `wf delete <selector>`, `wf delete <selector>` | Prompt note in `src/cli.ts` | Canonical |
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
| Cached repository list, details, and health | `wf cache list|show|check` | Canonical |
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
| Skills JSON | `wf skills ... --json` | One JSON value, no decoration |
| Repository cache JSON | `wf cache list|show|check --json` | One JSON value, no decoration |
| Repository cache paths | `wf cache show [repo] --path` | Exact filesystem path |
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
pnpm check
```

Exercise fallbacks and raw contracts:

```sh
pnpm exec tsx bin/workforest.js skills list --json
pnpm exec tsx bin/workforest.js shell init zsh
```
