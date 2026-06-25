import {
  CommandStreamAdapter,
  escapeBlessedTags,
} from "../terminal/command-stream-adapter.ts";
import {
  createFullscreenKeypress,
  createFullscreenScreen,
  createFullscreenStatusLine,
  FULLSCREEN_QUIT_KEYS,
} from "../terminal/fullscreen-surface.ts";
import { fullscreenColor } from "../terminal/theme.ts";
import { runParallel } from "../utils/task-generator.ts";
import {
  type InitializationTarget,
  readWorkspaceInitializationState,
  watchRepoInitialization,
} from "../workspace/initialization.ts";
import type { RepoPipelineState } from "../workspace/pipeline.ts";
import { calculateGridDimensions, GridLayout } from "./grid-layout.ts";

const STATUS_ICONS = {
  running: "\u21bb",
  complete: "\u2713",
  failed: "\u2717",
  pending: "\u25cb",
  cancelled: "\u2298",
};

export async function renderInitializationStatus(
  target: InitializationTarget,
  repoNames: readonly string[],
): Promise<void> {
  const screen = createFullscreenScreen();
  const statusLine = createFullscreenStatusLine(screen);
  const { rows, cols } = calculateGridDimensions(repoNames.length);
  const grid = new GridLayout({
    screen,
    rows,
    cols,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%-1",
    borderColor: fullscreenColor.accent,
  });
  const paneMap = new Map<string, number>();
  const adapters = new Map<string, CommandStreamAdapter>();

  repoNames.forEach((repoName, index) => {
    paneMap.set(repoName, index);
    grid
      .getPane(index)
      ?.setLabel(`${escapeBlessedTags(repoName)} ${STATUS_ICONS.pending}`);
  });
  const quit = createFullscreenKeypress(screen, FULLSCREEN_QUIT_KEYS);

  const pipelines = new Map(
    repoNames.map((repoName) => [
      repoName,
      watchRepoInitialization({
        ...(typeof target === "string"
          ? { workspaceDir: target }
          : { scope: target }),
        repoName,
        includeExistingLog: true,
      }),
    ]),
  );
  const updates = runParallel(pipelines)[Symbol.asyncIterator]();
  let nextUpdate = updates.next();

  const updateStatusLine = async (): Promise<void> => {
    const workspaceState = await readWorkspaceInitializationState(target);
    const message = workspaceState?.message ?? "Initialization status";
    const warningCount = workspaceState?.warnings?.length ?? 0;
    const warningSuffix =
      warningCount > 0
        ? `  |  ${warningCount} warning${warningCount === 1 ? "" : "s"}`
        : "";
    statusLine.setContent(
      `{gray-fg}${escapeBlessedTags(message)}${warningSuffix}  |  q quit{/gray-fg}`,
    );
  };

  try {
    await updateStatusLine();
    grid.render();

    while (true) {
      const next = await quit.race(nextUpdate);
      if (next.type === "keypress") {
        await updates.return?.(undefined);
        return;
      }
      if (next.result.done) {
        break;
      }

      const { id, state } = next.result.value;
      nextUpdate = updates.next();
      renderRepoState({
        repoName: id,
        state,
        pane: grid.getPane(paneMap.get(id) ?? -1),
        adapters,
      });
      await updateStatusLine();
      grid.render();
    }

    while (true) {
      await updateStatusLine();
      grid.render();
      const workspaceState = await readWorkspaceInitializationState(target);
      if (
        workspaceState?.status === "ready" ||
        workspaceState?.status === "failed" ||
        workspaceState?.status === "cancelled"
      ) {
        await quit.wait();
        return;
      }

      const result = await quit.race(
        new Promise<void>((resolve) => setTimeout(resolve, 100)),
      );
      if (result.type === "keypress") return;
    }
  } finally {
    for (const [repoName, paneIndex] of paneMap) {
      const pane = grid.getPane(paneIndex);
      const adapter = adapters.get(repoName);
      if (!pane || !adapter) continue;
      for (const line of adapter.flush()) {
        pane.appendLine(line.line);
      }
    }
    statusLine.destroy();
    grid.destroy();
    screen.destroy();
  }
}

function renderRepoState({
  repoName,
  state,
  pane,
  adapters,
}: {
  repoName: string;
  state: RepoPipelineState;
  pane: ReturnType<GridLayout["getPane"]>;
  adapters: Map<string, CommandStreamAdapter>;
}): void {
  if (!pane) return;

  switch (state.phase) {
    case "git":
      pane.setLabel(
        `${escapeBlessedTags(repoName)}: ${state.step} ${STATUS_ICONS.running}`,
      );
      if (state.message) {
        pane.appendLine(
          `{gray-fg}${escapeBlessedTags(state.message)}{/gray-fg}`,
        );
      }
      break;
    case "initializer":
      pane.setLabel(
        `${escapeBlessedTags(repoName)}: ${escapeBlessedTags(state.name)} ${STATUS_ICONS.running}`,
      );
      if (state.output) {
        const adapter = getAdapter(adapters, repoName);
        for (const line of adapter.push("stdout", state.output)) {
          pane.appendLine(line.line);
        }
      } else if (state.message) {
        pane.appendLine(
          `{gray-fg}${escapeBlessedTags(state.message)}{/gray-fg}`,
        );
      }
      break;
    case "worktree-ready":
      pane.setLabel(
        `${escapeBlessedTags(repoName)}: initializing ${STATUS_ICONS.running}`,
      );
      break;
    case "complete":
      flushAdapter(pane, repoName, adapters);
      pane.setLabel(
        `{green-fg}${escapeBlessedTags(repoName)} ${STATUS_ICONS.complete}{/green-fg}`,
      );
      break;
    case "cancelled":
      flushAdapter(pane, repoName, adapters);
      pane.setLabel(
        `{yellow-fg}${escapeBlessedTags(repoName)} ${STATUS_ICONS.cancelled}{/yellow-fg}`,
      );
      pane.appendLine(
        `{yellow-fg}${escapeBlessedTags(state.message ?? "Initialization cancelled")}{/yellow-fg}`,
      );
      break;
    case "failed":
      flushAdapter(pane, repoName, adapters);
      pane.setLabel(
        `{red-fg}${escapeBlessedTags(repoName)} ${STATUS_ICONS.failed}{/red-fg}`,
      );
      if (state.step) {
        pane.appendLine(
          `{red-fg}Step: ${escapeBlessedTags(state.step)}{/red-fg}`,
        );
      }
      pane.appendLine(
        `{red-fg}Error: ${escapeBlessedTags(state.error.message)}{/red-fg}`,
      );
      break;
  }
}

function getAdapter(
  adapters: Map<string, CommandStreamAdapter>,
  repoName: string,
): CommandStreamAdapter {
  let adapter = adapters.get(repoName);
  if (!adapter) {
    adapter = new CommandStreamAdapter();
    adapters.set(repoName, adapter);
  }
  return adapter;
}

function flushAdapter(
  pane: NonNullable<ReturnType<GridLayout["getPane"]>>,
  repoName: string,
  adapters: Map<string, CommandStreamAdapter>,
): void {
  const adapter = adapters.get(repoName);
  if (!adapter) return;
  for (const line of adapter.flush()) {
    pane.appendLine(line.line);
  }
  adapters.delete(repoName);
}
