import { formatTemplateIdentifier, loadTemplate } from "../templates/index.ts";
import { CommandStreamAdapter } from "../terminal/command-stream-adapter.ts";
import {
  createFullscreenKeypress,
  createFullscreenScreen,
  createFullscreenStage,
  createFullscreenStatusLine,
  FULLSCREEN_QUIT_KEYS,
  fullTerminalViewport,
} from "../terminal/fullscreen-surface.ts";
import {
  renderTerminalLineBlessed,
  type TerminalLineInput,
  terminalLine,
  terminalSpan,
} from "../terminal/render-model.ts";
import { activeTheme, toBlessed } from "../terminal/theme-system.ts";
import { runParallel } from "../utils/task-generator.ts";
import {
  type InitializationTarget,
  readWorkspaceInitializationState,
  watchRepoInitialization,
} from "../workspace/initialization.ts";
import { getInitializationRootDir } from "../workspace/initialization-scope.ts";
import { readWorkspaceMetadata } from "../workspace/metadata.ts";
import type { RepoPipelineState } from "../workspace/pipeline.ts";
import { calculateGridDimensions, GridLayout } from "./grid-layout.ts";

const AGENTS_MD_PANE_NAME = "AGENTS.md";

/** Pane status glyphs, resolved from the active theme's semantic symbols. */
function statusIcons(): {
  running: string;
  complete: string;
  failed: string;
  pending: string;
  cancelled: string;
} {
  const { symbols } = activeTheme();
  return {
    running: symbols.statusRunning,
    complete: symbols.statusComplete,
    failed: symbols.statusFailed,
    pending: symbols.statusPending,
    cancelled: symbols.statusCancelled,
  };
}

/** Semantic color roles as @unblessed tokens for the current theme. */
function colors(): {
  focus: string;
  success: string;
  warning: string;
  error: string;
  muted: string;
  primary: string;
  border: string;
  background: string;
} {
  const theme = activeTheme();
  const { palette } = theme;
  return {
    focus: toBlessed(palette.focus),
    success: toBlessed(palette.success),
    warning: toBlessed(palette.warning),
    error: toBlessed(palette.error),
    muted: toBlessed(palette.muted),
    primary: toBlessed(palette.primary),
    border: toBlessed(theme.chrome.border),
    background: toBlessed(theme.chrome.background),
  };
}

function renderBlessedLine(input: TerminalLineInput): string {
  return renderTerminalLineBlessed(terminalLine(input));
}

function repoLabel(repoName: string, status: string): string {
  return renderBlessedLine([repoName, " ", status]);
}

function repoStepLabel(repoName: string, step: string, status: string): string {
  return renderBlessedLine([repoName, ": ", step, " ", status]);
}

function styledRepoLabel(
  repoName: string,
  status: string,
  role: "success" | "warning" | "error",
): string {
  return renderBlessedLine([terminalSpan(`${repoName} ${status}`, { role })]);
}

function paneMessage(
  message: string,
  role: "muted" | "warning" | "error",
): string {
  return renderBlessedLine([terminalSpan(message, { role })]);
}

export async function renderInitializationStatus(
  target: InitializationTarget,
  repoNames: readonly string[],
): Promise<void> {
  const screen = createFullscreenScreen();
  const stage = createFullscreenStage(screen, fullTerminalViewport);
  const statusLine = createFullscreenStatusLine(screen);
  const includeAgentsMdPane = await shouldShowAgentsMdPane(target);
  const paneNames = includeAgentsMdPane
    ? [...repoNames, AGENTS_MD_PANE_NAME]
    : [...repoNames];
  const { rows, cols } = calculateGridDimensions(paneNames.length);
  const grid = new GridLayout({
    screen,
    parent: stage,
    rows,
    cols,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%-1",
    borderColor: colors().border,
    backgroundColor: colors().background,
  });
  const paneMap = new Map<string, number>();
  const adapters = new Map<string, CommandStreamAdapter>();

  paneNames.forEach((paneName, index) => {
    paneMap.set(paneName, index);
    grid.getPane(index)?.setLabel(repoLabel(paneName, statusIcons().pending));
  });
  const quit = createFullscreenKeypress(screen, FULLSCREEN_QUIT_KEYS);

  const pipelines = new Map<string, AsyncGenerator<RepoPipelineState>>(
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
  if (includeAgentsMdPane) {
    pipelines.set(AGENTS_MD_PANE_NAME, watchAgentsMdInitialization(target));
  }
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
      paneMessage(`${message}${warningSuffix}  |  q quit`, "muted"),
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
    stage.destroy();
    screen.destroy();
  }
}

async function shouldShowAgentsMdPane(
  target: InitializationTarget,
): Promise<boolean> {
  if (typeof target !== "string" && target.kind !== "workspace") return false;
  const workspaceDir =
    typeof target === "string" ? target : getInitializationRootDir(target);
  const metadata = await readWorkspaceMetadata(workspaceDir).catch(() => null);
  const templateId = metadata?.workspace.template_id;
  if (!templateId) return false;
  const template = await loadTemplate(
    formatTemplateIdentifier({
      parent: templateId,
      variant: metadata.workspace.template_variant,
    }),
  ).catch(() => null);
  return Boolean(template?.config["AGENTS.md"]);
}

async function* watchAgentsMdInitialization(
  target: InitializationTarget,
): AsyncGenerator<RepoPipelineState> {
  let lastRendered = "";
  while (true) {
    const workspaceState = await readWorkspaceInitializationState(target);
    const message = workspaceState?.message ?? "Waiting for workspace setup";
    const guidanceWarning = workspaceState?.warnings?.find((warning) =>
      /AGENTS\.md/i.test(warning),
    );

    if (
      workspaceState?.status === "ready" ||
      workspaceState?.status === "failed" ||
      workspaceState?.status === "cancelled"
    ) {
      if (guidanceWarning) {
        yield {
          phase: "cancelled",
          message: guidanceWarning,
        };
      } else {
        yield { phase: "complete", hasLockfile: false };
      }
      return;
    }

    const isRefreshing = /AGENTS\.md|guidance/i.test(message);
    const nextRendered = `${isRefreshing ? "refresh" : "waiting"}:${message}`;
    if (nextRendered !== lastRendered) {
      lastRendered = nextRendered;
      yield {
        phase: "initializer",
        name: isRefreshing ? "refresh" : "waiting",
        status: "running",
        message: isRefreshing
          ? message
          : "Waiting for repository initialization to finish",
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
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
      pane.setLabel(repoStepLabel(repoName, state.step, statusIcons().running));
      if (state.message) {
        pane.appendLine(paneMessage(state.message, "muted"));
      }
      break;
    case "initializer":
      pane.setLabel(repoStepLabel(repoName, state.name, statusIcons().running));
      if (state.output) {
        const adapter = getAdapter(adapters, repoName);
        for (const line of adapter.push("stdout", state.output)) {
          pane.appendLine(line.line);
        }
      } else if (state.message) {
        pane.appendLine(paneMessage(state.message, "muted"));
      }
      break;
    case "worktree-ready":
      pane.setLabel(
        repoStepLabel(repoName, "initializing", statusIcons().running),
      );
      break;
    case "complete":
      flushAdapter(pane, repoName, adapters);
      pane.setLabel(
        styledRepoLabel(repoName, statusIcons().complete, "success"),
      );
      break;
    case "cancelled":
      flushAdapter(pane, repoName, adapters);
      pane.setLabel(
        styledRepoLabel(repoName, statusIcons().cancelled, "warning"),
      );
      pane.appendLine(
        paneMessage(state.message ?? "Initialization cancelled", "warning"),
      );
      break;
    case "failed":
      flushAdapter(pane, repoName, adapters);
      pane.setLabel(styledRepoLabel(repoName, statusIcons().failed, "error"));
      if (state.step) {
        pane.appendLine(paneMessage(`Step: ${state.step}`, "error"));
      }
      pane.appendLine(paneMessage(`Error: ${state.error.message}`, "error"));
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
