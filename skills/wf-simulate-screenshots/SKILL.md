---
name: wf-simulate-screenshots
description: Capture Workforest dev simulator TUI states as PNG screenshots with Betamax and tmux. Use when asked to run `wf dev simulate new`, capture each UI state, generate terminal screenshots, document the new-workspace wizard, or reproduce visual states of the Workforest simulator.
---

# WF Simulate Screenshots

Use this skill to automate PNG screenshots of `wf dev simulate new` and related Workforest TUI simulator flows.

## Workflow

1. Verify prerequisites:
   - `tmux`
   - `termshot`
   - Betamax, either on `PATH` or at `/tmp/betamax/betamax`
   - project dependencies installed so `pnpm exec tsx` works
2. Use a fixed terminal size, usually `120x40`.
3. Run the simulator through `pnpm exec tsx bin/workforest.js ...` when capturing source-tree UI states. This avoids Node native TypeScript strip-mode failures on syntax such as parameter properties.
4. Set `NCURSES_NO_UTF8_ACS=1 LANG=en_US.UTF-8` for captures. This makes `@unblessed` emit Unicode borders instead of DEC ACS fallback glyphs that render as `q`, `x`, and similar characters in PNG output.
5. Keep the pane alive briefly after the simulator exits so the final screenshot does not include tmux's `Pane is dead` footer.
6. Verify with `file <output>/*.png` and sample at least the first, a grid-progress state, and the final state visually.

## Standard Capture

Prefer the bundled script for the standard `new` simulator flow:

```sh
skills/wf-simulate-screenshots/scripts/capture-new-flow.sh /tmp/wf-simulate-new-ui-states
```

The script writes these states:

```text
01-select-template.png
02-manual-option.png
03-repos-empty.png
04-repos-typed.png
05-feature-empty.png
06-feature-description.png
07-generating-feature-name.png
08-summary-before-setup.png
09-setup-grid-running.png
10-setup-grid-progress.png
11-setup-complete-prompt.png
12-final-next-steps.png
```

## Manual Command Shape

When the script needs adjustment, preserve this command shape:

```sh
/tmp/betamax/betamax \
  --cols 120 \
  --rows 40 \
  -d 100 \
  -o /tmp/wf-simulate-new-ui-states \
  "NCURSES_NO_UTF8_ACS=1 LANG=en_US.UTF-8 pnpm exec tsx bin/workforest.js dev simulate new --speed slow; sleep 5" \
  -f /tmp/wf-simulate-new.keys
```

Use `@wait:Press any key to continue` before capturing the completion prompt, then send `Space` and capture the final next-steps screen.

## Troubleshooting

- If screenshots show `q`, `x`, `l`, `k`, or `j` instead of borders, confirm `NCURSES_NO_UTF8_ACS=1` is in the command environment.
- If the final screenshot shows `Pane is dead`, append `; sleep 5` to the captured command.
- If the command fails with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, run through `pnpm exec tsx bin/workforest.js` instead of `pnpm exec wf` or `./bin/workforest.js`.
- If Betamax rejects an absolute capture path, pass the directory with `-o` and use relative names in `@capture:...`.
- If timing drifts, prefer `@wait:<visible text>` over longer sleeps.
