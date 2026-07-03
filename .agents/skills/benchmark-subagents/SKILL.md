---
name: benchmark-subagents
description: Benchmark Codex and Claude Code subagents on representative integration/audit tasks to choose the fastest model and reasoning/effort level that meets a shared quality bar. Use when evaluating model choices for Workforest integration workflows, comparing subagent harnesses, testing audit prompts, or updating agent definitions with benchmark-backed model metadata.
---

# Benchmark Subagents

Use this skill to compare subagent models and reasoning/effort levels for
Workforest integration workflows. Optimize for the fastest configuration that
meets the quality threshold; a cheaper model that is slow, incomplete, or noisy
is not a win.

## Benchmark Shape

Test a matrix of:

- Harness: Codex/OpenAI and Claude Code.
- Model: each candidate model available to that harness.
- Reasoning/effort level: every relevant level supported by the harness or
  agent definition.
- Task: representative past integration or audit work, preferably from real
  Codex transcripts, queued branches, or known integration commits.

Use the same task prompt, repository state, input diff, time limit, and scoring
rubric for every run in a task group. Keep runs read-only unless the benchmark
explicitly covers commit or integration behavior.

## Task Corpus

Pick at least three tasks when time allows:

- A small low-risk integration to catch over-analysis and latency.
- A medium integration with test or contract changes.
- A broad/risky integration with UI, state, or cross-module behavior where a
  good auditor should find real semantic risks.

For each task, write the expected result before running models:

- Diff range or branch/SHA under review.
- Files or subsystems that matter.
- Expected high-value findings.
- Acceptable omissions.
- Known false-positive traps.
- Required verification awareness.

Do not tune the expected result after seeing candidate outputs except to fix
clear mistakes in the benchmark fixture; if you do, rerun affected candidates.

## Timing

Collect wall-clock time for every run. Use an external timer around the complete
subagent invocation, including startup and final response generation.

Record:

- Start timestamp.
- End timestamp.
- Elapsed wall-clock seconds.
- Whether the run completed, timed out, or was interrupted.
- Time to first progress update when the task has a progress contract.
- Any long silence or progress-contract failure.

Prefer `/usr/bin/time -p <command>` or a shell wrapper using `date +%s` before
and after the invocation. Do not compare model speed using token count,
perceived responsiveness, or partial output alone.

## Rubric

Score every run with the same rubric:

| Area | Score |
| --- | --- |
| Correctness findings | 0-4: identifies the important real risks and blockers |
| Evidence quality | 0-3: cites exact files, diffs, tests, or contracts |
| Scope control | 0-2: reviews the requested diff without wandering or missing key areas |
| Verification judgment | 0-2: recommends appropriate tests or recognizes missing coverage |
| Signal-to-noise | 0-2: avoids speculative or low-value findings |
| Operational behavior | 0-2: completes, follows read-only/progress constraints, and stays within timeout |

Default quality threshold: at least 11/15 total, no zero in correctness findings,
and no critical missed expected finding. Raise the threshold for high-risk
integration workflows.

When comparing two outputs with the same score, prefer the one with fewer false
positives and clearer file references. When two configurations meet the quality
bar, select the faster wall-clock run unless repeat runs show high variance.

## Run Log

Capture results in a table or markdown note with these fields:

| Task | Harness | Model | Effort | Seconds | First update | Status | Score | Critical miss | Notes |
| --- | --- | --- | --- | ---: | ---: | --- | ---: | --- | --- |

Keep raw outputs or concise excerpts until the decision is made. Include enough
evidence that another agent can understand why the selected configuration won.

## Selection Rules

Select one configuration per harness:

- Codex/OpenAI: choose the fastest model plus reasoning/effort level that meets
  the rubric across representative tasks.
- Claude Code: choose the fastest model plus reasoning/effort level that meets
  the same rubric across representative tasks.

Prefer agent-definition metadata over skill prose for enforcing the chosen model.
Update the Codex TOML and Claude Markdown subagent definitions when the harness
supports model metadata. Keep skill instructions limited to fallback guidance for
manual invocation without a packaged subagent.

Do not select mini-class or low-effort configurations for integration audits
unless benchmark evidence shows they meet the same quality threshold and are
actually faster wall-clock than stronger models.

## Reporting

Report:

- Selected configuration for Codex/OpenAI.
- Selected configuration for Claude Code.
- Runner-up configurations and why they lost.
- Number and shape of tasks tested.
- Wall-clock timing summary.
- Rubric scores and any critical misses.
- Files updated to encode the selected models.

If evidence is thin, say so and mark the result provisional instead of presenting
it as settled.
