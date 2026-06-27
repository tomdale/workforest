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
  type ChangeScope,
  candidateInScope,
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
  /**
   * The Workforest container the command was launched from, when inside one.
   * Phase 1 defaults its change list to this scope (Tab toggles to all changes)
   * and Phase 2 defaults its source mode and highlight to it.
   */
  scope?: ChangeScope;
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
    const phase1 = await runPhase1(screen, mode, deps.scope);
    if (phase1.kind === "cancel") return;
    if (phase1.kind === "cd") {
      await cdToChange(phase1.candidate);
      return;
    }

    const sources = await runPhase2(screen, phase1.changeName, deps.scope);
    if (!sources) return;

    // Hand off to the setup grid + confetti, which owns its own screen.
    teardown();
    await deps.commitChange({ changeName: phase1.changeName, sources });
  } finally {
    teardown();
  }
}

function toChangeItems(
  candidates: ChangeCandidate[],
): FuzzyItem<ChangeCandidate>[] {
  return candidates.map((candidate) => ({
    value: candidate,
    label: candidate.changeName,
    hint: candidate.statusHint,
  }));
}

async function runPhase1(
  screen: FullscreenScreen,
  mode: ChangeEntryMode,
  scope: ChangeScope | undefined,
): Promise<Phase1Result> {
  const candidates = mode === "go" ? await listChangeCandidates() : [];

  // When launched inside a Workforest container, default the list to that
  // scope's changes; fall back to the full list when the scope has none.
  // Tab toggles between the scoped and global views.
  const scoped = scope
    ? candidates.filter((candidate) => candidateInScope(candidate, scope))
    : [];
  const canScope = scope !== undefined && scoped.length > 0;
  let showingScoped = canScope;

  // The two scopes hold fixed positions in the toggle: the launch scope first
  // ("in front", badging "front"), all changes second. Tab moves only the
  // highlight between them — index 0 when scoped, 1 when showing everything.
  const scopeName = scope ? describeScope(scope) : "";
  const scopeOptions = [
    { label: `in ${scopeName}`, name: scopeName },
    { label: "all changes" },
  ];
  const activeScopeIndex = (): number => (showingScoped ? 0 : 1);
  const itemsNow = (): FuzzyItem<ChangeCandidate>[] =>
    toChangeItems(showingScoped ? scoped : candidates);

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
      items: itemsNow(),
      placeholder,
      ...(canScope
        ? {
            scopeToggle: { options: scopeOptions, active: activeScopeIndex() },
            onTab: () => {
              showingScoped = !showingScoped;
              return {
                items: itemsNow(),
                scopeActive: activeScopeIndex(),
              };
            },
          }
        : {}),
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

/** A short human label for a scope, e.g. "front" or "vercel-agent". */
function describeScope(scope: ChangeScope): string {
  return scope.name;
}

/**
 * The kind of change being assembled. Each mode maps to one of `wf start`'s
 * outcomes and filters the source list accordingly:
 * - `repo`     — one repository (a single-repo change)
 * - `template` — one saved `@template` (a template workspace)
 * - `multi`    — several repositories (an ad-hoc multi-repo workspace)
 */
type SourceMode = "repo" | "template" | "multi";

const MODE_ORDER: readonly SourceMode[] = ["repo", "template", "multi"];

function modeLabel(mode: SourceMode): string {
  return mode === "repo"
    ? "Repo"
    : mode === "template"
      ? "Template"
      : "Multi-repo";
}

function nextMode(mode: SourceMode): SourceMode {
  const index = MODE_ORDER.indexOf(mode);
  return MODE_ORDER[(index + 1) % MODE_ORDER.length] ?? "repo";
}

/** The mode to open Phase 2 in, defaulted from the launch scope. */
function initialMode(scope: ChangeScope | undefined): SourceMode {
  switch (scope?.kind) {
    case "template":
      return "template";
    case "adhoc":
      return "multi";
    default:
      return "repo";
  }
}

/**
 * A predicate selecting the candidate to highlight on entry, so a change
 * started from inside a repo/template opens with that source under the cursor
 * (without auto-adding it). Only meaningful for the single-source modes.
 */
function preselectFor(
  scope: ChangeScope | undefined,
  mode: SourceMode,
): ((candidate: SourceCandidate) => boolean) | undefined {
  if (!scope) return undefined;
  if (mode === "repo" && scope.kind === "repo") {
    const name = scope.name;
    return (candidate) =>
      candidate.id === name || candidate.id.endsWith(`/${name}`);
  }
  if (mode === "template" && scope.kind === "template") {
    const id = scope.name;
    return (candidate) => candidate.id === id;
  }
  return undefined;
}

async function runPhase2(
  screen: FullscreenScreen,
  changeName: string,
  scope: ChangeScope | undefined,
): Promise<ChosenSource[] | null> {
  const candidates = await listSourceCandidates();
  const repoCandidates = candidates.filter(
    (candidate) => candidate.kind === "repo",
  );
  const templateCandidates = candidates.filter(
    (candidate) => candidate.kind === "template",
  );
  const candidatesForMode = (mode: SourceMode): SourceCandidate[] =>
    mode === "template" ? templateCandidates : repoCandidates;

  // `chosen` only accumulates in multi mode; the single modes commit on the
  // first selection. `mode` and `chosen` are read live by the closures below.
  let mode = initialMode(scope);
  const chosen: ChosenSource[] = [];

  const remainingForMode = (m: SourceMode): SourceCandidate[] => {
    const base = candidatesForMode(m);
    return m === "multi"
      ? base.filter((candidate) => !isChosen(candidate, chosen))
      : base;
  };
  const itemsForMode = (m: SourceMode): FuzzyItem<SourceCandidate>[] =>
    remainingForMode(m).map((candidate) => ({
      value: candidate,
      label: candidate.label,
      hint: candidate.hint,
    }));

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
        await renderPreview(theme, changeName, mode, chosen, notice),
      );
      screen.render();
      notice = null;

      const preselect = preselectFor(scope, mode);
      const list = createFuzzyList<SourceCandidate>({
        screen,
        parent: host,
        prompt: `sources for "${changeName}"`,
        scopeLabel: `${modeLabel(mode)} mode`,
        tabHint: `${modeLabel(nextMode(mode))} mode`,
        items: itemsForMode(mode),
        ...(preselect
          ? { initialSelected: (item) => preselect(item.value) }
          : {}),
        actionRow: { label: (query) => actionLabel(query, mode, chosen) },
        onTab: () => {
          mode = nextMode(mode);
          // Re-render the preview synchronously so the mode tabs and guidance
          // track the switch (inference is deferred to the next render cycle).
          preview.setContent(
            renderPreviewSync(theme, changeName, mode, chosen, null),
          );
          return {
            items: itemsForMode(mode),
            scopeLabel: `${modeLabel(mode)} mode`,
            tabHint: `${modeLabel(nextMode(mode))} mode`,
          };
        },
      });

      const result = await list.run();
      if (result.kind === "cancel") return null;

      if (result.kind === "item") {
        const source = sourceFromCandidate(result.value);
        if (mode === "multi") {
          notice = addSource(chosen, source);
          continue;
        }
        return [source];
      }

      const query = result.query.trim();
      if (query.length > 0) {
        const source = sourceFromFreeEntry(query, mode);
        if (mode === "multi") {
          notice = addSource(chosen, source);
          continue;
        }
        return [source];
      }
      if (mode === "multi" && chosen.length > 0) return chosen;
    }
  } finally {
    preview.destroy();
    host.destroy();
  }
}

function actionLabel(
  query: string,
  mode: SourceMode,
  chosen: ChosenSource[],
): string {
  const typed = query.trim();
  if (typed.length > 0) {
    return mode === "template"
      ? `✛ use @${escapeBlessedTags(typed.replace(/^@/, ""))}`
      : `✛ add "${escapeBlessedTags(typed)}"`;
  }
  if (mode === "multi") {
    return chosen.length > 0
      ? "✓ create (or add more)"
      : "· add one or more repositories";
  }
  return mode === "template"
    ? "· select a template to create the change"
    : "· select a repository to create the change";
}

function sourceFromCandidate(candidate: SourceCandidate): ChosenSource {
  return candidate.kind === "template"
    ? { kind: "template", name: candidate.id }
    : { kind: "repo", token: candidate.id };
}

/** Interpret a free-entry query as the kind of source the mode expects. */
function sourceFromFreeEntry(query: string, mode: SourceMode): ChosenSource {
  if (mode === "template") {
    return { kind: "template", name: query.replace(/^@/, "") };
  }
  return query.startsWith("@")
    ? { kind: "template", name: query.slice(1) }
    : { kind: "repo", token: query };
}

/**
 * Add a repository to the multi-repo accumulation, rejecting templates (which
 * belong to single Template mode) and duplicates. Returns a human notice when
 * the add is rejected, else null.
 */
function addSource(chosen: ChosenSource[], next: ChosenSource): string | null {
  if (next.kind === "template") {
    return "Use Template mode (tab) for a template workspace";
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

/** Phase 2 preview without the (async) inferred-change line. */
function renderPreviewSync(
  theme: Theme,
  changeName: string,
  mode: SourceMode,
  chosen: ChosenSource[],
  notice: string | null,
): string {
  return previewBaseLines(theme, changeName, mode, chosen, notice).join("\n");
}

async function renderPreview(
  theme: Theme,
  changeName: string,
  mode: SourceMode,
  chosen: ChosenSource[],
  notice: string | null,
): Promise<string> {
  const lines = previewBaseLines(theme, changeName, mode, chosen, notice);
  if (mode === "multi" && chosen.length > 0) {
    lines.push("", await describeInferred(theme, changeName, chosen));
  }
  return lines.join("\n");
}

function previewBaseLines(
  theme: Theme,
  changeName: string,
  mode: SourceMode,
  chosen: ChosenSource[],
  notice: string | null,
): string[] {
  const { palette } = theme;
  const lines: string[] = [
    `${fg(palette.muted, "new change")}  ${fg(
      palette.focus,
      escapeBlessedTags(changeName),
    )}`,
    renderModeTabs(theme, mode),
  ];

  if (mode === "multi" && chosen.length > 0) {
    const chips = chosen
      .map((source) =>
        source.kind === "template"
          ? fg(palette.focus, `@${escapeBlessedTags(source.name)}`)
          : fg(palette.primary, escapeBlessedTags(source.token)),
      )
      .join(fg(palette.muted, " · "));
    lines.push(`${fg(palette.muted, "sources")}  ${chips}`);
  } else {
    lines.push(fg(palette.muted, modeGuidance(mode)));
  }

  if (notice) {
    lines.push(fg(palette.warning, escapeBlessedTags(notice)));
  }

  return lines;
}

/** The mode switcher row: each mode, the active one accented, plus a tab hint. */
function renderModeTabs(theme: Theme, mode: SourceMode): string {
  const { palette } = theme;
  const tabs = MODE_ORDER.map((candidate) =>
    candidate === mode
      ? fg(palette.focus, `▌${modeLabel(candidate)}`)
      : fg(palette.muted, modeLabel(candidate)),
  ).join("   ");
  return `${tabs}   ${fg(palette.muted, "· tab switches mode")}`;
}

function modeGuidance(mode: SourceMode): string {
  switch (mode) {
    case "repo":
      return "select a repository for a single-repo change";
    case "template":
      return "select a @template for a template workspace";
    case "multi":
      return "add repositories for an ad-hoc multi-repo workspace";
  }
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
