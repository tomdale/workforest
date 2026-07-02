# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`workforest` is a CLI tool that initializes multiple git repositories into a shared local workspace. It sets up git worktrees from cached bare mirrors, installs dependencies, and runs template hooks. Supports any git host via full URLs, with `org/repo` shorthand for GitHub.

## Commands

```bash
pnpm build              # Build with tsdown
pnpm test               # Run tests with vitest
pnpm biome check .      # Lint and format check
pnpm biome check --write .  # Auto-fix lint/format issues

# Run CLI during development
node bin/workforest.js new <name> <org/repo...|@template>
node bin/workforest.js templates
```

## Architecture

### Entry Flow
1. `src/cli.ts` — CLI argument parsing, routes to subcommands
2. `src/workspace/index.ts` — `stampWorkspaceGenerator()` orchestrates workspace creation
3. For each repo: mirror → worktree → pnpm install → template hooks

### Generator Pattern
Long-running operations use async generators that yield state updates, enabling both TUI and simple console output:
- `stampWorkspaceGenerator()` yields `WorkspaceState` for each phase
- `applyTemplateGenerator()` yields `HookState` for hook execution
- `runParallel()` in `task-generator.ts` runs multiple generators concurrently

### Key Components
- **Repository caching** (`src/workspace/repository.ts`): Bare git mirrors in `~/.cache/workforest/` with `--filter=blob:none`. Creates worktrees per workspace.
- **Templates** (`src/templates/`): User-defined workspace configurations stored in `~/.config/workforest/templates/<name>/template.jsonc`. Support JSONC format with comments.
- **Config** (`src/config.ts`): Global settings at `~/.config/workforest/config.json` (`directory.*`, `branchPrefix`, Vercel link settings).
- **Hooks** (`src/services/hooks.ts`): Shell commands run after workspace setup, defined in templates.

### Types (`src/types.ts`)
- `RepositorySource`: `{ name, remote }`
- `TemplateConfig`: `{ repos, description?, hooks?, branchPrefix? }`
- `Hook`: `{ name, run, in?, if?, continueOnError? }`
- `WorkspaceMetadata`: Stored in `.workforest/workspace.json` at workspace root

## Code Style

- Biome for linting/formatting (2-space indent, double quotes)
- TypeScript with ES modules
- Node.js >= 25 required
- NEVER use `any` or `!` non-null assertions

## Testing the CLI in Interactive Mode

Before changing terminal output or interaction, use the in-project terminal UI
skill at `.agents/skills/terminal-ui/SKILL.md`.

`pnpm test` and the Bash tool both run in non-interactive shells without a real TTY.
This silently bypasses large parts of the CLI:

- `shouldUseGrid()` returns `false` (no TTY → spinner fallback, never `renderPipelinesGrid`)
- Custom prompts (`src/ui/prompts/`) require raw mode on stdin and skip without a TTY
- Any code path gated on `process.stdout.isTTY` is invisible to automated tests

**After any change that touches the TUI, prompt flow, or
`wf new` end-to-end path, smoke-test in a real terminal using
tmux:**

```bash
# Open the interactive entry surface in a real PTY.
# Use a scratch config dir so the smoke test can't touch real workspaces.
CFG=$(mktemp -d)
tmux new-session -d -s wf-smoke -x 120 -y 40
tmux send-keys -t wf-smoke \
  "WORKFOREST_USE_SOURCE_CLI=1 WORKFOREST_CONFIG_DIR=$CFG pnpm exec tsx bin/workforest.js" Enter
sleep 8
tmux capture-pane -t wf-smoke -p   # inspect what the user actually sees
tmux send-keys -t wf-smoke Escape  # cancel without creating anything
tmux kill-session -t wf-smoke
```

Key things to verify:
- Inline prompts and the fuzzy entry surface render and accept input correctly
- `shouldUseGrid()` returns `true` in the tmux PTY (it has a real TTY)
- The `@unblessed` setup grid appears and updates as repos are set up — this
  only happens on a real `wf new <name> <repo>`, so exercise it against a
  throwaway name and clean up afterward with `wf delete`
- The process exits cleanly after completion

Do not rely solely on `pnpm test` to validate user-facing behavior — the test suite
only covers logic that runs outside the TTY-gated paths.

## Documentation

- Update `README.md` after making any user-visible changes (new commands, changed behavior, new features, etc.)
