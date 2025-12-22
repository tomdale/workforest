## Project Overview

`vercel-workspace` is a CLI tool that initializes multiple Vercel GitHub repositories into a shared local workspace. It sets up git worktrees from cached bare mirrors, installs dependencies, and configures turbo caching.

## Commands

```bash
# Build (uses tsdown)
pnpm build

# Run the CLI directly during development
pnpm tsx src/cli.ts <feature-name> [repo-names...]

# Run with demo UI
pnpm ui:demo

# Lint and format
pnpm biome check .
pnpm biome check --write .  # auto-fix
```

## Architecture

### Entry Flow
1. `src/cli.ts` - CLI argument parsing, calls `stampWorkspace()`
2. `src/workspace/index.ts` - Main orchestrator, processes repos sequentially
3. For each repo: mirror → worktree → pnpm install → turbo link

### Key Components
- **Repository caching** (`src/workspace/repository.ts`): Maintains bare git mirrors in `~/.cache/vercel-workspace/` with `--filter=blob:none` for efficiency. Creates git worktrees for each workspace.
- **Package management** (`src/services/pnpm.ts`): `installDependenciesIfNeeded()` runs `pnpm install` if lockfile exists; `turboLinkIfNeeded()` links turbo cache.
- **Config** (`src/config.ts`): Defines repo aliases (e.g., `@dashboard` → `["front", "api"]`) and assumes all repos are under `github.com/vercel/`.
- **Retry logic** (`src/utils/retry.ts`): All network operations use `withRetry()` with 3 attempts.

### Types
- `RepoConfig`: `{ name, remote, defaultBranch }` - core repo definition
- `RunCommandOptions`: `{ cwd?, capture? }` - for `runCommand()` in exec.ts

## Code Style

- Uses Biome for linting/formatting (2-space indent, double quotes)
- TypeScript with ES modules (`"type": "module"`)
- Requires Node.js >= 25
