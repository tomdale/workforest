# AGENTS.md

See `CLAUDE.md` for project overview, architecture, code style, and standard commands (`pnpm build`, `pnpm test`, `pnpm biome check .`).

## Cursor Cloud specific instructions

- **Node.js >= 25 required.** The VM update script installs Node 25 via nvm and activates pnpm via corepack. If `node --version` shows < 25, run `nvm use 25`.
- **CLI during development:** `node bin/workforest.js` runs directly from TypeScript source (via the bin shim), so a build is not required for iterating on the CLI. `pnpm build` is needed only to test the dist output.
- **Lint note:** `pnpm biome check .` is the lint/format check. Use `pnpm biome check --write .` to auto-fix. There is currently a pre-existing formatting issue in `src/workspace/repository.ts` that causes `biome check` to exit non-zero.
- **Tests:** `pnpm test` runs vitest (20 tests across 2 files). Tests are fast (~300 ms) and do not require network or external services.
- **No background services:** This is a pure CLI tool. No databases, Docker, or servers to start.
