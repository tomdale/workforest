import { Box } from "@unblessed/node";
import {
  createFullscreenScreen,
  createFullscreenStage,
  type FullscreenScreen,
} from "../terminal/fullscreen-surface.ts";
import {
  createFuzzyList,
  type FuzzyItem,
  type FuzzyScopeToggle,
} from "../terminal/fuzzy-list.ts";
import {
  renderTerminalDocBlessed,
  type TerminalLineInput,
  terminalDoc,
  terminalSpan,
} from "../terminal/render-model.ts";
import {
  activeTheme,
  type Theme,
  toBlessed,
} from "../terminal/theme-system.ts";
import {
  type Candidate,
  candidateInScope,
  cdToEntry,
  listCandidates,
  type Scope,
} from "./entries-data.ts";
import {
  type ChosenSource,
  type InferredEntry,
  inferEntry,
  listSourceCandidates,
  type SourceCandidate,
} from "./sources-data.ts";

/**
 * The universal "go to or create a worktree or workspace" surface, opened by
 * bare `wf` (go-or-create) and `wf new` (create-only).
 *
 * It is one continuous fullscreen flow: Phase 1 resolves a change name (matching
 * existing changes in go-mode), Phase 2 accumulates sources for a new change,
 * and on commit the surface tears itself down and hands off to the setup grid +
 * confetti (driven by {@link EntryDeps.commit}). It never returns to
 * the normal terminal until the work is done.
 */

export type EntryMode = "go" | "create";

/** Where a new change is provisioned: this machine, or a cloud sandbox. */
export type EntryTarget = "local" | "cloud";

export type EntryDeps = Readonly<{
  /**
   * Resolve the chosen name + sources into a real change: build worktrees, run
   * setup through the grid, show the confetti modal, and cd on acknowledgement.
   * Injected so the surface stays decoupled from the creation core. `target`
   * selects local vs cloud provisioning.
   */
  commit: (intent: {
    changeName: string;
    sources: ChosenSource[];
    target: EntryTarget;
  }) => Promise<void>;
  /** Target highlighted first when the command line supplies a preference. */
  initialTarget?: EntryTarget;
  /**
   * The Workforest container the command was launched from, when inside one.
   * Phase 1 defaults its change list to this scope (Tab toggles to all changes)
   * and Phase 2 defaults its source mode and highlight to it.
   */
  scope?: Scope;
}>;

type Phase1Result =
  | { kind: "cd"; candidate: Candidate }
  | { kind: "create"; changeName: string }
  | { kind: "cancel" };

const PREVIEW_HEIGHT = 7;

export async function runEntry(
  mode: EntryMode,
  deps: EntryDeps,
): Promise<void> {
  const screen = createFullscreenScreen();
  // Capped, centered region every phase renders into; on a large terminal the
  // surrounding margin stays at the terminal default. Destroyed with the screen.
  const stage = createFullscreenStage(screen);
  let torn = false;
  const teardown = (): void => {
    if (torn) return;
    torn = true;
    screen.destroy();
  };

  try {
    const phase1 = await runPhase1(screen, stage, mode, deps.scope);
    if (phase1.kind === "cancel") return;
    if (phase1.kind === "cd") {
      await cdToEntry(phase1.candidate);
      return;
    }

    const sources = await runPhase2(
      screen,
      stage,
      phase1.changeName,
      deps.scope,
    );
    if (!sources) return;

    const target = await runTargetStep(screen, stage, deps.initialTarget);
    if (!target) return;

    // Hand off to the setup grid + confetti, which owns its own screen.
    teardown();
    await deps.commit({ changeName: phase1.changeName, sources, target });
  } finally {
    teardown();
  }
}

function toEntryItems(candidates: Candidate[]): FuzzyItem<Candidate>[] {
  return candidates.map((candidate) => ({
    value: candidate,
    label: candidate.changeName,
    hint: candidate.statusHint,
  }));
}

async function runPhase1(
  screen: FullscreenScreen,
  stage: Box,
  mode: EntryMode,
  scope: Scope | undefined,
): Promise<Phase1Result> {
  const candidates = mode === "go" ? await listCandidates() : [];

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
    { label: "all" },
  ];
  const activeScopeIndex = (): number => (showingScoped ? 0 : 1);
  const itemsNow = (): FuzzyItem<Candidate>[] =>
    toEntryItems(showingScoped ? scoped : candidates);

  const placeholder =
    mode === "go"
      ? "type to find one, or a new name to create one"
      : "type a name to create one";

  while (true) {
    const list = createFuzzyList<Candidate>({
      screen,
      parent: stage,
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
          return mode === "go" ? "✛ Create new" : "✛ Type a name to create one";
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
function describeScope(scope: Scope): string {
  return scope.name;
}

/**
 * The kind of change being assembled. Each mode maps to one of `wf new`'s
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

/** The mode switcher as a fuzzy-list scope bar (rendered between input and list). */
function modeScopeToggle(mode: SourceMode): FuzzyScopeToggle {
  return {
    options: MODE_ORDER.map((candidate) => ({ label: modeLabel(candidate) })),
    active: MODE_ORDER.indexOf(mode),
  };
}

/** The mode to open Phase 2 in, defaulted from the launch scope. */
function initialMode(scope: Scope | undefined): SourceMode {
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
  scope: Scope | undefined,
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
  stage: Box,
  changeName: string,
  scope: Scope | undefined,
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
    parent: stage,
    top: 0,
    left: 0,
    width: "100%",
    height: PREVIEW_HEIGHT,
    tags: true,
    padding: { left: 1, top: 1 },
    style: { bg: toBlessed(theme.chrome.background) },
  });
  const host = new Box({
    parent: stage,
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
        scopeToggle: modeScopeToggle(mode),
        items: itemsForMode(mode),
        placeholder: "add a repo or @template",
        ...(preselect
          ? { initialSelected: (item) => preselect(item.value) }
          : {}),
        actionRow: { label: (query) => actionLabel(query, mode, chosen) },
        onTab: () => {
          mode = nextMode(mode);
          // Re-render the preview synchronously so the guidance tracks the
          // switch (inference is deferred to the next render cycle).
          preview.setContent(
            renderPreviewSync(theme, changeName, mode, chosen, null),
          );
          return {
            items: itemsForMode(mode),
            scopeActive: MODE_ORDER.indexOf(mode),
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

/**
 * The final create step: choose where the change runs. Local is highlighted by
 * default so the common case is a single Enter; cancel aborts the whole flow.
 */
async function runTargetStep(
  screen: FullscreenScreen,
  stage: Box,
  initialTarget: EntryTarget = "local",
): Promise<EntryTarget | null> {
  const list = createFuzzyList<EntryTarget>({
    screen,
    parent: stage,
    prompt: "Where should this run?",
    items: [
      { value: "local", label: "Local", hint: "worktrees on this machine" },
      { value: "cloud", label: "Cloud", hint: "Vercel Sandbox" },
    ],
    initialSelected: (item) => item.value === initialTarget,
  });
  const result = await list.run();
  list.destroy();
  if (result.kind === "item") return result.value;
  return null;
}

function actionLabel(
  query: string,
  mode: SourceMode,
  chosen: ChosenSource[],
): string {
  const typed = query.trim();
  if (typed.length > 0) {
    return mode === "template"
      ? `✛ use @${typed.replace(/^@/, "")}`
      : `✛ add "${typed}"`;
  }
  if (mode === "multi") {
    return chosen.length > 0
      ? "⏎ create (or add more)"
      : "· add one or more repositories";
  }
  return mode === "template"
    ? "· select a template to create it"
    : "· select a repository to create it";
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
  _theme: Theme,
  changeName: string,
  mode: SourceMode,
  chosen: ChosenSource[],
  notice: string | null,
): string {
  return renderTerminalDocBlessed(
    terminalDoc(previewBaseLines(changeName, mode, chosen, notice)),
  );
}

async function renderPreview(
  theme: Theme,
  changeName: string,
  mode: SourceMode,
  chosen: ChosenSource[],
  notice: string | null,
): Promise<string> {
  const lines = previewBaseLines(changeName, mode, chosen, notice);
  if (mode === "multi" && chosen.length > 0) {
    lines.push("", await describeInferred(theme, changeName, chosen));
  }
  return renderTerminalDocBlessed(terminalDoc(lines));
}

function previewBaseLines(
  changeName: string,
  mode: SourceMode,
  chosen: ChosenSource[],
  notice: string | null,
): TerminalLineInput[] {
  const lines: TerminalLineInput[] = [
    [
      terminalSpan("new change", { role: "muted" }),
      "  ",
      terminalSpan(changeName, { role: "focus" }),
    ],
  ];

  if (mode === "multi" && chosen.length > 0) {
    const chips = chosen.flatMap((source, index) => {
      const sourceSpan =
        source.kind === "template"
          ? terminalSpan(`@${source.name}`, { role: "focus" })
          : terminalSpan(source.token, { role: "primary" });
      return index === 0
        ? [sourceSpan]
        : [terminalSpan(" · ", { role: "muted" }), sourceSpan];
    });
    lines.push([terminalSpan("sources", { role: "muted" }), "  ", ...chips]);
  } else {
    lines.push([terminalSpan(modeGuidance(mode), { role: "muted" })]);
  }

  if (notice) {
    lines.push([terminalSpan(notice, { role: "warning" })]);
  }

  return lines;
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
  _theme: Theme,
  changeName: string,
  chosen: ChosenSource[],
): Promise<TerminalLineInput> {
  try {
    const result: InferredEntry = await inferEntry({
      changeName,
      sources: chosen,
    });
    const tail =
      result.type === "template" && result.repoPreview.length > 0
        ? [
            "  ",
            terminalSpan(`→ ${result.repoPreview.join(", ")}`, {
              role: "muted",
            }),
          ]
        : [];
    return [
      terminalSpan(`→ ${result.type}`, { role: "success" }),
      "  ",
      terminalSpan(result.relativePath, { role: "muted" }),
      "  ",
      terminalSpan(result.branch, { role: "muted" }),
      ...tail,
    ];
  } catch (error) {
    const message = error instanceof Error ? error.message : "cannot resolve";
    return [terminalSpan(message, { role: "error" })];
  }
}
