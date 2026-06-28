import {
  createFullscreenScreen,
  createFullscreenStage,
} from "../terminal/fullscreen-surface.ts";
import { createFuzzyList, type FuzzyItem } from "../terminal/fuzzy-list.ts";
import type { InventoryEntry } from "../workspace/inventory.ts";
import { candidateFromInventoryEntry } from "./entries-data.ts";

export async function runSwitchSurface(
  entries: readonly InventoryEntry[],
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
    const list = createFuzzyList<InventoryEntry>({
      screen,
      parent: stage,
      items: switchItems(entries),
      placeholder: "type to find a change",
    });
    const result = await list.run();
    if (result.kind === "item") return result.value;
    return null;
  } finally {
    teardown();
  }
}

function switchItems(
  entries: readonly InventoryEntry[],
): FuzzyItem<InventoryEntry>[] {
  const now = Date.now();
  return entries.map((entry) => {
    const candidate = candidateFromInventoryEntry(entry, now);
    return {
      value: entry,
      label: candidate.changeName,
      hint: candidate.statusHint,
    };
  });
}
