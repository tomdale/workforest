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
node bin/workforest.js new <template|org/repo...>
node bin/workforest.js template list
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
- **Config** (`src/config.ts`): Global settings at `~/.config/workforest/config.json` (defaultDir, branchPrefix, dirPrefix).
- **Hooks** (`src/services/hooks.ts`): Shell commands run after workspace setup, defined in templates.

### Types (`src/types.ts`)
- `RepoConfig`: `{ name, remote, defaultBranch }`
- `TemplateConfig`: `{ repos, description?, hooks?, branchPrefix? }`
- `Hook`: `{ name, run, in?, if?, continueOnError? }`
- `WorkspaceMetadata`: Stored in `.workforest` file at workspace root

## Code Style

- Biome for linting/formatting (2-space indent, double quotes)
- TypeScript with ES modules
- Node.js >= 25 required
- NEVER use `any` or `!` non-null assertions

## Documentation

- Update `README.md` after making any user-visible changes (new commands, changed behavior, new features, etc.)
