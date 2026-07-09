# Pi resources for Workforest integration workflows

This directory is the pi-native port of the Claude Code / Codex plugin under
`.agents/plugins/wf`. It provides the same submit, integrate, and plan workflows
using pi's project-local resource conventions.

## Layout

- `agents/*.md` — project subagents (`commit`, `integration-auditor`,
  `plan-architect`, `plan-detailer`) in pi's agent frontmatter format (`name`,
  `description`, `tools`, `model`). They are loaded by the `subagent` tool when it
  is invoked with `agentScope: "both"` (or `"project"`); the bundled skills do
  this.
- `skills/*/SKILL.md` — the `submit`, `integrate`, and `plan` skills. Pi
  auto-discovers project skills once the repository is trusted, and registers
  them as `/skill:submit`, `/skill:integrate`, and `/skill:plan`.
- `scripts/integration.mjs` — the shared integration queue and lock helper the
  skills call by relative path.

## Mapping from the plugin

| Plugin resource | Pi equivalent |
| --- | --- |
| `agents/*.toml` and `agents/*.md` (Codex/Claude) | `agents/*.md` (pi subagent frontmatter) |
| `skills/*/SKILL.md` | `skills/*/SKILL.md` (auto-discovered) |
| `scripts/integration.mjs` | `scripts/integration.mjs` |
| `.claude-plugin` / `.codex-plugin` manifests, `marketplace.json` | project-local convention directories (no manifest needed) |

## Notes on the port

- Codex `sandbox_mode` and reasoning-effort fields have no direct pi frontmatter
  equivalent. Read-only intent is enforced through agent instructions, and
  reasoning effort is expressed with the `:level` suffix on the `model` field.
- The integration auditor was adapted from the Claude agent-team `SendMessage`
  progress-streaming contract to pi's isolated subagent model: its tool calls
  stream to the caller automatically, and its final message is a self-contained
  verdict.
