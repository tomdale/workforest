---
name: terminal-ui
description: Workforest terminal interface design and verification guidance. Use when adding, changing, reviewing, or auditing Workforest prompts, fullscreen TUIs, progress displays, static CLI reports, status messages, help text, command streams, or machine-readable output.
---

# Workforest Terminal UI

Keep every terminal surface consistent with the interface category it belongs
to. Read `references/experience-inventory.md` when auditing coverage or choosing
the next surface to migrate.

## Classify First

Choose one category before writing output:

- **Machine output:** shell integration, JSON, paths, and skill contents. Emit
  exact data with no decoration.
- **Static report:** lists, configuration, metadata, previews, and summaries.
  Use headings, labeled values, two-space indentation, and stable ordering.
- **Inline interaction:** text, select, fuzzy select, multi-select, confirm,
  notes, spinners, and status messages. Reuse `src/ui/prompts/`.
- **Fullscreen interaction:** multi-pane browsing, creation wizards, and
  concurrent progress. Reuse `src/terminal/` primitives and the established
  footer conventions.
- **Command stream:** subprocess stdout and stderr. Preserve the child output;
  add framing outside the stream rather than rewriting it.

Do not infer presentation from `isTTY` alone. Decide the semantic category,
then use TTY capability only to choose the rich or fallback implementation.

## Visual Language

- Cyan: focus, active selection, progress, and primary borders.
- Green: completed and successful states.
- Yellow: warnings and recoverable attention states.
- Red: errors, failed states, cancellation, and destructive emphasis.
- Gray or dim: hints, labels, inactive choices, chrome, and secondary metadata.
- White or default foreground: primary content.

Use the shared tokens in `src/terminal/theme.ts`. Do not introduce a competing
palette or a second set of status symbols.

Decorative effects such as completion confetti may use additional colors, but
those colors must not communicate state.

Use these symbols consistently:

- `◆` active step, `◇` completed prompt step, `■` cancelled step
- `●` information or selected radio, `○` unselected radio
- `◼` selected checkbox, `◻` unselected checkbox
- `✓` success, `▲` warning, `✗` error

## Layout

- Start human-readable reports with one heading, not an unstructured blank
  line followed by prose.
- Render all help through `src/help.ts`. In color-capable terminals, use cyan
  bold section headings, neutral bold program names, cyan commands and
  subcommands, yellow flags, bright cyan arguments and example values, dim
  metadata, and default foreground for explanatory prose.
- Keep colored help structurally identical to plain help. ANSI styling must
  disappear cleanly when stdout is redirected or color is disabled.
- Indent report content by two spaces. Keep labels aligned within a section.
- Put secondary paths and hints last and render them dim.
- Keep empty states actionable and short.
- Use sentence case for headings, labels, prompts, and status messages.
- Use `…` for truncation and transient work, never three periods.
- Keep interactive footer hints on one line: key first, action second.
- Preserve content when color is disabled; color may reinforce meaning but
  cannot carry it alone.

## Interaction

- Support arrows and `j`/`k` for vertical navigation in fullscreen lists.
- Use Enter for the primary action, Escape for back, `q` for quit, and Ctrl-C
  for cancellation.
- Show available keys in fullscreen footers. Do not hide required navigation.
- Preserve entered values when moving back.
- Require explicit confirmation for destructive actions unless `--force` is
  supplied.
- In non-interactive mode, fail with the exact flag or argument needed instead
  of attempting to prompt.

## Implementation

- Put terminal lifecycle behavior in `src/terminal/`.
- Put reusable inline widgets in `src/ui/prompts/`.
- Keep command routing and data gathering out of rendering modules.
- Provide a plain fallback for every fullscreen or animated experience.
- Keep raw and JSON modes free of ANSI styling and explanatory text.
- Avoid direct `console.log` for new human-facing interfaces when an existing
  report, prompt, logger, or fullscreen primitive fits.

## Verification

Run:

```sh
pnpm check
```

For prompt or fullscreen changes, also exercise the real interface in a PTY at
`120x40` or larger and inspect both the rich TTY path and a non-TTY fallback.

Check:

- layout and wrapping at realistic widths
- focus, back, quit, and Ctrl-C behavior
- cursor and raw-mode restoration
- color-disabled readability
- non-TTY behavior and machine-output purity
- success, warning, failure, cancellation, and empty states
