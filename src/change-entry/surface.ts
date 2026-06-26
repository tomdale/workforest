import { Box } from "@unblessed/node";
import { escapeBlessedTags } from "../terminal/command-stream-adapter.ts";
import {
  createFullscreenScreen,
  type FullscreenScreen,
} from "../terminal/fullscreen-surface.ts";
import { createFuzzyList, type FuzzyItem } from "../terminal/fuzzy-list.ts";
import {
  activeTheme,
  fg,
  setActiveTheme,
  type Theme,
  toBlessed,
} from "../terminal/theme-system.ts";
import {
  type ChangeCandidate,
  cdToChange,
  listChangeCandidates,
} from "./changes-data.ts";
import {
  type ChosenSource,
  type InferredChange,
  inferChange,
  listSourceCandidates,
  type SourceCandidate,
} from "./sources-data.ts";

/**
 * The universal "go to or create a change" surface — the interactive front door
 * opened by bare `wf` (go-or-create) and `wf start` (create-only).
 *
 * It is one continuous fullscreen flow: Phase 1 resolves a change name (matching
 * existing changes in go-mode), Phase 2 accumulates sources for a new change,
 * and on commit the surface tears itself down and hands off to the setup grid +
 * confetti (driven by {@link ChangeEntryDeps.commitChange}). It never returns to
 * the normal terminal until the work is done.
 */

export type ChangeEntryMode = "go" | "create";

export type ChangeEntryDeps = Readonly<{
  /**
   * Resolve the chosen name + sources into a real change: build worktrees, run
   * setup through the grid, show the confetti modal, and cd on acknowledgement.
   * Injected so the surface stays decoupled from the creation core.
   */
  commitChange: (intent: {
    changeName: string;
    sources: ChosenSource[];
  }) => Promise<void>;
}>;

type Phase1Result =
  | { kind: "cd"; candidate: ChangeCandidate }
  | { kind: "create"; changeName: string }
  | { kind: "cancel" };

const PREVIEW_HEIGHT = 8;

export async function runChangeEntry(
  mode: ChangeEntryMode,
  deps: ChangeEntryDeps,
): Promise<void> {
  // The new front door wears the cyberpunk theme by default. Truecolor hex tags
  // must render in the target terminal; override with a named-color theme via
  // setActiveTheme("default") if a terminal cannot show them.
  setActiveTheme("cyberpunk-red");

  const screen = createFullscreenScreen();
  let torn = false;
  const teardown = (): void => {
    if (torn) return;
    torn = true;
    screen.destroy();
  };

  try {
    const phase1 = await runPhase1(screen, mode);
    if (phase1.kind === "cancel") return;
    if (phase1.kind === "cd") {
      await cdToChange(phase1.candidate);
      return;
    }

    const sources = await runPhase2(screen, phase1.changeName);
    if (!sources) return;

    // Hand off to the setup grid + confetti, which owns its own screen.
    teardown();
    await deps.commitChange({ changeName: phase1.changeName, sources });
  } finally {
    teardown();
  }
}

async function runPhase1(
  screen: FullscreenScreen,
  mode: ChangeEntryMode,
): Promise<Phase1Result> {
  const candidates = mode === "go" ? await listChangeCandidates() : [];
  const items: FuzzyItem<ChangeCandidate>[] = candidates.map((candidate) => ({
    value: candidate,
    label: candidate.changeName,
    hint: candidate.statusHint,
  }));
  const prompt =
    mode === "go" ? "go to or create a change" : "name a new change";
  const placeholder =
    mode === "go"
      ? "Type to find a change, or a new name to create one…"
      : "Type a name for the new change…";

  while (true) {
    const list = createFuzzyList<ChangeCandidate>({
      screen,
      prompt,
      items,
      placeholder,
      actionRow: {
        label: (query) => {
          const name = query.trim();
          if (name) return `✛ Create "${name}"`;
          return mode === "go"
            ? "✛ Create a new change"
            : "✛ Type a name to create a change";
        },
      },
    });

    const result = await list.run();
    if (result.kind === "cancel") return { kind: "cancel" };
    if (result.kind === "item") return { kind: "cd", candidate: result.value };

    const changeName = result.query.trim();
    if (changeName.length === 0) continue;
    return { kind: "create", changeName };
  }
}

async function runPhase2(
  screen: FullscreenScreen,
  changeName: string,
): Promise<ChosenSource[] | null> {
  const candidates = await listSourceCandidates();
  const chosen: ChosenSource[] = [];

  const theme = activeTheme();
  const preview = new Box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: PREVIEW_HEIGHT,
    tags: true,
    padding: { left: 1, top: 1 },
    style: { bg: toBlessed(theme.chrome.background) },
  });
  const host = new Box({
    parent: screen,
    top: PREVIEW_HEIGHT,
    left: 0,
    width: "100%",
    height: `100%-${PREVIEW_HEIGHT}`,
    tags: true,
  });

  let notice: string | null = null;

  try {
    while (true) {
      preview.setContent(
        await renderPreview(theme, changeName, chosen, notice),
      );
      screen.render();
      notice = null;

      const remaining = candidates.filter(
        (candidate) => !isChosen(candidate, chosen),
      );
      const items: FuzzyItem<SourceCandidate>[] = remaining.map(
        (candidate) => ({
          value: candidate,
          label: candidate.label,
          hint: candidate.hint,
        }),
      );

      const list = createFuzzyList<SourceCandidate>({
        screen,
        parent: host,
        prompt: `sources for "${changeName}"`,
        items,
        actionRow: { label: (query) => actionLabel(query, chosen, changeName) },
      });

      const result = await list.run();
      if (result.kind === "cancel") return null;

      if (result.kind === "item") {
        notice = addSource(chosen, sourceFromCandidate(result.value));
        continue;
      }

      const query = result.query.trim();
      if (query.length > 0) {
        notice = addSource(chosen, sourceFromFreeEntry(query));
        continue;
      }
      if (chosen.length > 0) return chosen;
    }
  } finally {
    preview.destroy();
    host.destroy();
  }
}

function actionLabel(
  query: string,
  chosen: ChosenSource[],
  changeName: string,
): string {
  const typed = query.trim();
  if (typed.length > 0) return `✛ add "${typed}"`;
  if (chosen.length > 0) return `✓ create "${changeName}"`;
  return "· type to add a repo or @template";
}

function sourceFromCandidate(candidate: SourceCandidate): ChosenSource {
  return candidate.kind === "template"
    ? { kind: "template", name: candidate.id }
    : { kind: "repo", token: candidate.id };
}

function sourceFromFreeEntry(query: string): ChosenSource {
  return query.startsWith("@")
    ? { kind: "template", name: query.slice(1) }
    : { kind: "repo", token: query };
}

/**
 * Add a source, enforcing the templates-cannot-combine-with-repos rule. Returns
 * a human notice when the add is rejected or redundant, else null.
 */
function addSource(chosen: ChosenSource[], next: ChosenSource): string | null {
  const hasTemplate = chosen.some((source) => source.kind === "template");
  const hasRepo = chosen.some((source) => source.kind === "repo");

  if (next.kind === "template" && (hasTemplate || hasRepo)) {
    return "A template can't be combined with other sources";
  }
  if (next.kind === "repo" && hasTemplate) {
    return "A template can't be combined with repositories";
  }
  if (isChosen2(chosen, next)) return "Already added";

  chosen.push(next);
  return null;
}

function isChosen(candidate: SourceCandidate, chosen: ChosenSource[]): boolean {
  return isChosen2(chosen, sourceFromCandidate(candidate));
}

function isChosen2(chosen: ChosenSource[], next: ChosenSource): boolean {
  return chosen.some((source) =>
    source.kind === "repo" && next.kind === "repo"
      ? source.token === next.token
      : source.kind === "template" && next.kind === "template"
        ? source.name === next.name
        : false,
  );
}

async function renderPreview(
  theme: Theme,
  changeName: string,
  chosen: ChosenSource[],
  notice: string | null,
): Promise<string> {
  const { palette } = theme;
  const lines: string[] = [];
  lines.push(
    `${fg(palette.muted, "new change")}  ${fg(
      palette.focus,
      escapeBlessedTags(changeName),
    )}`,
  );

  if (chosen.length === 0) {
    lines.push("");
    lines.push(fg(palette.muted, "add one or more repos, or one @template"));
  } else {
    const chips = chosen
      .map((source) =>
        source.kind === "template"
          ? fg(palette.focus, `@${escapeBlessedTags(source.name)}`)
          : fg(palette.primary, escapeBlessedTags(source.token)),
      )
      .join(fg(palette.muted, " · "));
    lines.push(`${fg(palette.muted, "sources")}  ${chips}`);

    const inferred = await describeInferred(theme, changeName, chosen);
    lines.push("");
    lines.push(inferred);
  }

  if (notice) {
    lines.push("");
    lines.push(fg(palette.warning, escapeBlessedTags(notice)));
  }

  return lines.join("\n");
}

async function describeInferred(
  theme: Theme,
  changeName: string,
  chosen: ChosenSource[],
): Promise<string> {
  const { palette } = theme;
  try {
    const result: InferredChange = await inferChange({
      changeName,
      sources: chosen,
    });
    const tail =
      result.type === "template" && result.repoPreview.length > 0
        ? `  ${fg(palette.muted, `→ ${result.repoPreview.join(", ")}`)}`
        : "";
    return `${fg(palette.success, `→ ${result.type}`)}  ${fg(
      palette.muted,
      escapeBlessedTags(result.relativePath),
    )}  ${fg(palette.muted, escapeBlessedTags(result.branch))}${tail}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "cannot resolve";
    return fg(palette.error, escapeBlessedTags(message));
  }
}
