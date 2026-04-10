import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Box, NodeRuntime, Screen, setRuntime } from "@unblessed/node";
import { runParallel } from "../utils/task-generator.ts";
import type { RepoPipelineState } from "../workspace/pipeline.ts";
import { calculateGridDimensions, GridLayout } from "./grid-layout.ts";

export type RenderPipelinesGridOptions = {
  pipelines: Map<string, AsyncGenerator<RepoPipelineState>>;
  repoNames: string[];
};

type RepoDisplayStatus = "pending" | "running" | "complete" | "failed";
type RepoTaskState = Extract<RepoPipelineState, { status: string }>;
type RepoTaskStatus = RepoTaskState["status"];
const require = createRequire(import.meta.url);
let unblessedSetupPromise: Promise<void> | null = null;

/**
 * Check if the terminal supports grid rendering.
 * Falls back to spinner mode for:
 * - Non-TTY environments
 * - Terminals that are too small for the computed pane layout
 * - CI environments
 * - When WORKFOREST_NO_TUI is set
 */
export function shouldUseGrid(repoCount = 1): boolean {
  if (!process.stdout.isTTY) return false;
  if (process.env.CI || process.env.WORKFOREST_NO_TUI) return false;

  const { rows, cols } = calculateGridDimensions(repoCount);
  const minimumColumns = cols * 28 + 1;
  const minimumRows = rows * 8 + 2;
  const { columns, rows: terminalRows } = process.stdout;
  if ((columns ?? 80) < minimumColumns || (terminalRows ?? 24) < minimumRows) {
    return false;
  }

  return true;
}

/**
 * Status indicators for pane labels.
 */
const STATUS_ICONS = {
  running: "\u21bb", // ⟳
  complete: "\u2713", // ✓
  failed: "\u2717", // ✗
  pending: "\u25cb", // ○
};

/**
 * Render parallel repo pipelines using a grid layout.
 * Each pane shows one repo's output and current phase.
 */
export async function renderPipelinesGrid({
  pipelines,
  repoNames,
}: RenderPipelinesGridOptions): Promise<Map<string, { hasLockfile: boolean }>> {
  await ensureUnblessedCompatibility();
  setRuntime(new NodeRuntime());
  const screen = new Screen({
    smartCSR: true,
    fullUnicode: true,
    title: "workforest",
  });

  const { rows, cols } = calculateGridDimensions(repoNames.length);

  const grid = new GridLayout({
    screen,
    rows,
    cols,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%-1",
    borderColor: "cyan",
  });
  const footer = new Box({
    top: Math.max(0, Number(screen.height) - 1),
    left: 0,
    width: "100%",
    height: 1,
  });
  screen.append(footer);

  // Map repo names to pane indices
  const paneMap = new Map<string, number>();
  const repoStatuses = new Map<string, RepoDisplayStatus>();
  repoNames.forEach((name, i) => {
    paneMap.set(name, i);
    repoStatuses.set(name, "pending");
    const pane = grid.getPane(i);
    if (pane) {
      pane.setLabel(formatRepoLabel(name, undefined, "pending"));
    }
  });

  // Track repo states for return value
  const repoResults = new Map<string, { hasLockfile: boolean }>();
  const repoPhases = new Map<string, string>();
  let activeRepoIndex = 0;
  let runComplete = false;
  let closeRequested = false;
  let cleanedUp = false;

  const focusRepo = (repoIndex: number): void => {
    if (repoNames.length === 0) {
      return;
    }
    activeRepoIndex =
      ((repoIndex % repoNames.length) + repoNames.length) % repoNames.length;
    const paneIndex = paneMap.get(repoNames[activeRepoIndex]);
    if (paneIndex !== undefined) {
      grid.setActivePane(paneIndex);
    }
  };

  const renderScreen = (): void => {
    footer.setContent(
      buildFooterContent({
        repoNames,
        repoPhases,
        repoStatuses,
        activeRepoName: repoNames[activeRepoIndex],
        width: Number(screen.width),
        runComplete,
      }),
    );
    grid.render();
  };

  const cleanup = (): void => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    footer.destroy();
    grid.destroy();
    screen.destroy();
  };

  // Handle keyboard events
  screen.key(["tab"], () => {
    focusRepo(activeRepoIndex + 1);
    renderScreen();
  });
  screen.key(["S-tab"], () => {
    focusRepo(activeRepoIndex - 1);
    renderScreen();
  });
  screen.key(["up"], () => {
    grid.scrollActivePane(-1);
    renderScreen();
  });
  screen.key(["down"], () => {
    grid.scrollActivePane(1);
    renderScreen();
  });
  screen.key(["pageup"], () => {
    grid.scrollActivePaneByPage(-1);
    renderScreen();
  });
  screen.key(["pagedown"], () => {
    grid.scrollActivePaneByPage(1);
    renderScreen();
  });
  screen.key(["q", "escape"], () => {
    if (runComplete) {
      closeRequested = true;
    }
  });
  screen.key(["C-c"], () => {
    cleanup();
    process.exit(130);
  });

  // Initial render
  focusRepo(0);
  renderScreen();

  // Consume all pipelines in parallel
  for await (const { id, state } of runParallel(pipelines)) {
    const paneIndex = paneMap.get(id);
    if (paneIndex === undefined) continue;

    const pane = grid.getPane(paneIndex);
    if (!pane) continue;

    switch (state.phase) {
      case "git": {
        repoPhases.set(id, state.step);
        updateRepoStatus(repoStatuses, id, state.status);
        pane.setLabel(
          formatRepoLabel(id, state.step, repoStatuses.get(id) ?? "pending"),
        );

        if (state.output) {
          appendOutput(pane, state.output);
        } else {
          appendTaskMessage(pane, state.step, state.status, state.message);
        }
        break;
      }

      case "initializer": {
        repoPhases.set(id, state.name);
        updateRepoStatus(repoStatuses, id, state.status);
        pane.setLabel(
          formatRepoLabel(id, state.name, repoStatuses.get(id) ?? "pending"),
        );

        if (state.output) {
          appendOutput(pane, state.output);
        } else {
          appendTaskMessage(pane, state.name, state.status, state.message);
        }
        break;
      }

      case "complete": {
        repoPhases.set(id, "complete");
        repoStatuses.set(id, "complete");
        pane.setLabel(formatRepoLabel(id, "ready", "complete"));
        pane.appendLine("{green-fg}Repository ready{/green-fg}");
        repoResults.set(id, { hasLockfile: state.hasLockfile });
        break;
      }

      case "failed": {
        repoPhases.set(id, "failed");
        repoStatuses.set(id, "failed");
        pane.setLabel(formatRepoLabel(id, "failed", "failed"));
        pane.appendLine(`{red-fg}Error: ${state.error.message}{/red-fg}`);
        break;
      }
    }

    renderScreen();
  }

  runComplete = true;
  renderScreen();
  await waitForCloseOrTimeout(() => closeRequested, 1500);

  cleanup();

  return repoResults;
}

async function ensureUnblessedCompatibility(): Promise<void> {
  if (!unblessedSetupPromise) {
    unblessedSetupPromise = ensureUnblessedDataPath();
  }
  await unblessedSetupPromise;
}

async function ensureUnblessedDataPath(): Promise<void> {
  const coreEntryPath = require.resolve("@unblessed/core");
  const corePackageRoot = path.dirname(path.dirname(coreEntryPath));
  const sourceDataDir = path.join(corePackageRoot, "data");
  const expectedDataDir = path.join(corePackageRoot, "dist", "data");

  if (await pathExists(expectedDataDir)) {
    return;
  }

  if (!(await pathExists(sourceDataDir))) {
    return;
  }

  await fs.mkdir(path.dirname(expectedDataDir), { recursive: true });

  try {
    await fs.symlink(sourceDataDir, expectedDataDir, "dir");
  } catch (error_) {
    const error = error_ as NodeJS.ErrnoException;
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
}

/**
 * Append output to a pane, handling newlines and ANSI codes.
 */
function appendOutput(
  pane: { appendLine: (line: string) => void },
  output: string,
): void {
  const cleaned = sanitizeTerminalOutput(output);
  if (!cleaned.trim()) {
    return;
  }
  pane.appendLine(cleaned);
}

/**
 * Strip terminal control codes and normalize carriage-return output.
 */
export function sanitizeTerminalOutput(output: string): string {
  return output
    .replace(ANSI_ESCAPE_PATTERN, "")
    .split("\n")
    .map((line) => {
      const segments = line.split("\r");
      return segments[segments.length - 1] ?? "";
    })
    .join("\n");
}

function updateRepoStatus(
  repoStatuses: Map<string, RepoDisplayStatus>,
  repoName: string,
  status: RepoTaskStatus,
): void {
  if (status === "failed") {
    repoStatuses.set(repoName, "failed");
  } else if (status === "completed" || status === "skipped") {
    if ((repoStatuses.get(repoName) ?? "pending") !== "failed") {
      repoStatuses.set(repoName, "running");
    }
  } else {
    repoStatuses.set(repoName, "running");
  }
}

function formatRepoLabel(
  repoName: string,
  phase: string | undefined,
  status: RepoDisplayStatus,
): string {
  const icon = STATUS_ICONS[status];
  const label = phase ? `${repoName}: ${phase} ${icon}` : `${repoName} ${icon}`;

  if (status === "complete") {
    return `{green-fg}${label}{/green-fg}`;
  }

  if (status === "failed") {
    return `{red-fg}${label}{/red-fg}`;
  }

  return label;
}

function appendTaskMessage(
  pane: { appendLine: (line: string) => void },
  name: string,
  status: RepoTaskStatus,
  message: string | undefined,
): void {
  if (status === "completed") {
    pane.appendLine(`{green-fg}${name} complete{/green-fg}`);
    return;
  }

  if (status === "skipped") {
    pane.appendLine(
      `{yellow-fg}${name} skipped${message ? `: ${message}` : ""}{/yellow-fg}`,
    );
    return;
  }

  if (status === "retrying") {
    pane.appendLine(
      `{yellow-fg}${message ?? `${name} retrying`}{/yellow-fg}`,
    );
    return;
  }

  if (message) {
    pane.appendLine(`{gray-fg}${message}{/gray-fg}`);
  }
}

function buildFooterContent({
  repoNames,
  repoPhases,
  repoStatuses,
  activeRepoName,
  width,
  runComplete,
}: {
  repoNames: string[];
  repoPhases: Map<string, string>;
  repoStatuses: Map<string, RepoDisplayStatus>;
  activeRepoName: string | undefined;
  width: number;
  runComplete: boolean;
}): string {
  let completed = 0;
  let failed = 0;
  let running = 0;

  for (const repoName of repoNames) {
    const status = repoStatuses.get(repoName) ?? "pending";
    if (status === "complete") {
      completed++;
    } else if (status === "failed") {
      failed++;
    } else if (status === "running") {
      running++;
    }
  }

  const pending = repoNames.length - completed - failed - running;
  const summary = `${completed}/${repoNames.length} ready`;
  const states = [
    failed > 0 ? `${failed} failed` : undefined,
    running > 0 ? `${running} active` : undefined,
    pending > 0 ? `${pending} pending` : undefined,
  ]
    .filter((value) => value !== undefined)
    .join(", ");
  const activePhase =
    activeRepoName === undefined
      ? undefined
      : repoPhases.get(activeRepoName) ?? "waiting";
  const activeLabel =
    activeRepoName === undefined
      ? undefined
      : `pane ${activeRepoName}${activePhase ? ` (${activePhase})` : ""}`;
  const controls = runComplete
    ? "Tab switch pane | Up/Down/PgUp/PgDn scroll | q close | Ctrl+C abort"
    : "Tab switch pane | Up/Down/PgUp/PgDn scroll | Ctrl+C abort";

  return truncatePlainText(
    [summary, states, activeLabel, controls]
      .filter((value) => value !== undefined && value.length > 0)
      .join(" | "),
    Math.max(20, width - 1),
  );
}

function truncatePlainText(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }
  if (width <= 3) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 3)}...`;
}

async function waitForCloseOrTimeout(
  shouldClose: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (!shouldClose() && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape detection requires control characters
const ANSI_ESCAPE_PATTERN =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[@-_])/g;

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error_) {
    const error = error_ as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
