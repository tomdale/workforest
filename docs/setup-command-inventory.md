# Setup command inventory

This inventory defines the execution and output contracts for commands run by
Workforest provisioning. It was captured from the installed tool versions and
from the initializer sources so implementation can make pipe-backed execution a
product rule instead of an incidental fallback.

## Built-in initializers

| Initializer | Current command | Automation controls | Current transport | Structured output | Pipe fallback |
| --- | --- | --- | --- | --- | --- |
| pnpm install | `pnpm install --frozen-lockfile --prefer-offline`; retries `pnpm install` only for a stale lockfile | frozen install is already non-prompting for ordinary installs | Pipe | `--reporter=ndjson` is documented by installed pnpm 11.9.0 | NDJSON on stdout, diagnostics on stderr |
| npm install | `npm ci` | `npm ci` is CI-oriented; stdin is ignored by the pipe runner | Pipe | No streaming structured reporter identified | Plain stdout/stderr lines |
| Yarn install | `yarn install --frozen-lockfile` | frozen lockfile; stdin is ignored by the pipe runner | Pipe | Version-dependent; Yarn is not installed on this machine | Plain stdout/stderr lines |
| Vercel link | `vercel whoami --format json --non-interactive`, then `vercel link --yes --repo --scope … --non-interactive` | explicit non-interactive and confirmation flags | Pipe except explicit foreground login/device-auth recovery | Final JSON for `whoami`; no documented streaming JSON/NDJSON reporter for link | Plain stdout/stderr lines plus existing phase state |
| Vercel env pull | `vercel env pull --environment development --yes --non-interactive` | explicit non-interactive and confirmation flags | Pipe except explicit foreground/device-auth recovery | No documented streaming JSON/NDJSON reporter; dotenv file is the meaningful result | Plain stdout/stderr lines plus existing phase state |
| Turbo link | `turbo link --yes --scope …` | `--yes`; failed auth triggers explicit foreground `turbo login` recovery | Pipe except explicit foreground login recovery | No documented JSON/NDJSON reporter in installed Turbo 2.10.0 | Plain stdout/stderr lines plus existing phase state |
| Template hook | configured `sh -c` command | no generic non-interactive guarantee | Pipe | arbitrary user command; none assumed | Plain stdout/stderr lines |

## Scope boundaries

- The inventory covers background repository initializer commands and template
  hooks rendered by the setup view. Git and GitHub service commands are not
  setup-pane PTY consumers.
- `runForegroundTask` is deliberately distinct: it inherits stdio only for an
  explicit user-facing recovery, currently Vercel or Turbo login. It is not a
  background provisioning transport.
- Standard setup commands and hooks use pipe-backed execution. Only explicit
  foreground authentication recovery inherits user stdio.

## Evidence

- `packages/package-managers/src/initializers/{pnpm,npm,yarn}-install.ts`
- `packages/vercel/src/initializers/vercel-link.ts`
- `packages/turbo/src/initializers/turbo-link.ts`
- `src/services/hooks.ts`
- `packages/core/src/index.ts`

The installed CLI help was inspected on 2026-08-18: pnpm 11.9.0 documents
`--reporter=ndjson`; Turbo 2.10.0 documents stream/TUI human output but no
machine-readable `link` reporter; Vercel CLI 56.4.1 documents non-interactive
operation but no streaming structured reporter for `link` or `env pull`.
