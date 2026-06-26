---
name: write-cli-skills
description: Author shipped Workforest CLI skills in skill-data with concise how-to guidance.
---

# Write CLI Skills

Use this skill when you are adding or updating shipped skills under
`skill-data/`.

## Shape The Skill

- Use a job-shaped name such as `start-work` or `keep-cache-healthy`.
- Keep the content concise and action-focused.
- Write how-to guidance, not a command reference dump.
- Keep the file small enough to scan quickly.

## Write For The CLI

- Put the supported commands in the skill body.
- Tell readers to use `wf ... --help` for exact syntax.
- Do not add generated markdown references or filesystem-bypass surfaces.
- Keep examples copy-pasteable and tied to the current CLI behavior.

## Update The Repo

- Update or add tests for the shipped skill set and the expected outputs.
- Remove retired skill names and stale references from the shipped content.
- Verify the skill appears in `wf skills list` and loads with `wf skills get <name>`.

## Keep It Shipped

- Author only the runtime skill files under `skill-data/`.
- Do not create extra agent configuration files for this skill.
- Keep the skill aligned with the commands that reviewers and CI should use.
