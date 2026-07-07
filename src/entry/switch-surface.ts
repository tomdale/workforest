import {
  createFullscreenScreen,
  createFullscreenStage,
} from "../terminal/fullscreen-surface.ts";
import { createFuzzyList, type FuzzyItem } from "../terminal/fuzzy-list.ts";
import type { InventoryEntry } from "../workspace/inventory.ts";
import {
  type Candidate,
  candidateFromInventoryEntry,
  candidateInScope,
  type Scope,
  sortEntriesByRecency,
} from "./entries-data.ts";

export async function runSwitchSurface(
  entries: readonly InventoryEntry[],
  scope?: Scope,
  initialQuery?: string,
): Promise<InventoryEntry | null> {
  const screen = createFullscreenScreen();
  const stage = createFullscreenStage(screen);
  let torn = false;
  const teardown = (): void => {
    if (torn) return;
    torn = true;
    screen.destroy();
  };

  try {
    const candidates = switchCandidates(entries);
    const scoped = scope
      ? candidates.filter(({ candidate }) => candidateInScope(candidate, scope))
      : [];
    const canScope = scope !== undefined && scoped.length > 0;
    let showingScoped = canScope;
    const scopeName = scope?.name ?? "";
    const scopeOptions = [
      { label: `in ${scopeName}`, name: scopeName },
      { label: "all" },
    ];
    const activeScopeIndex = (): number => (showingScoped ? 0 : 1);
    const itemsNow = (): FuzzyItem<InventoryEntry>[] =>
      switchItems(showingScoped ? scoped : candidates);

    const list = createFuzzyList<InventoryEntry>({
      screen,
      parent: stage,
      items: itemsNow(),
      placeholder: "type to find a change",
      ...(initialQuery !== undefined ? { initialQuery } : {}),
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
    });
    const result = await list.run();
    if (result.kind === "item") return result.value;
    return null;
  } finally {
    teardown();
  }
}

type SwitchCandidate = Readonly<{
  entry: InventoryEntry;
  candidate: Candidate;
}>;

function switchCandidates(
  entries: readonly InventoryEntry[],
): SwitchCandidate[] {
  const now = Date.now();
  return sortEntriesByRecency(entries).map((entry) => ({
    entry,
    candidate: candidateFromInventoryEntry(entry, now),
  }));
}

function switchItems(
  entries: readonly SwitchCandidate[],
): FuzzyItem<InventoryEntry>[] {
  return entries.map(({ entry, candidate }) => ({
    value: entry,
    label: candidate.changeName,
    hint: candidate.statusHint,
    searchText: `${entry.selector} ${entry.changeName}`,
  }));
}
